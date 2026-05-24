import { spawn } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { readFile } from "node:fs/promises";

export interface TranscriptionResult {
  text: string;
  backend: "parakeet" | "faster-whisper" | "cohere-transcribe" | "openai";
  durationMs: number;
}

export type TranscriptionBackend = "parakeet" | "faster-whisper" | "cohere-transcribe" | "openai";

export interface TranscriptionOptions {
  preferredBackend?: TranscriptionBackend | "auto";
  language?: string | null;
  fasterWhisperModel?: string;
}

export type VoiceBackendStatus = "available" | "missing" | "configured" | "unconfigured" | "error" | "not_collected";

export interface VoiceBackendDiagnostic {
  id: "ffmpeg" | TranscriptionBackend;
  label: string;
  status: VoiceBackendStatus;
  detail: string;
  version?: string;
  path?: string;
}

export interface VoiceDiagnostics {
  preferredBackend: TranscriptionBackend | "auto";
  defaultLanguage: string | null;
  transcribeOnly: boolean;
  availableBackends: TranscriptionBackend[];
  backends: VoiceBackendDiagnostic[];
  refreshedAt: string;
  stale: boolean;
  heavyChecks: boolean;
  cacheTtlMs: number;
}

export interface VoiceDiagnosticsOptions {
  preferredBackend?: TranscriptionBackend | "auto";
  defaultLanguage?: string | null;
  transcribeOnly?: boolean;
  fasterWhisperPython?: string;
  forceRefresh?: boolean;
  includeHeavyChecks?: boolean;
  cacheTtlMs?: number;
}

// Minimal interface for the parakeet-coreml engine instance.
interface ParakeetEngine {
  initialize(): Promise<void>;
  transcribe(samples: Float32Array): Promise<unknown>;
}

const PARAKEET_SPECIFIER = "parakeet-coreml";
const FFMPEG_INSTALL_MESSAGE = "ffmpeg not found. Install it with: sudo apt-get install ffmpeg or brew install ffmpeg";
const FFMPEG_FALLBACK_DIRS =
  process.platform === "darwin"
    ? ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]
    : process.platform === "win32"
      ? []
      : ["/usr/local/bin", "/usr/bin", "/bin", "/snap/bin"];
const NO_BACKEND_ERROR = `Voice messages require a transcription backend.

Option 1: Install faster-whisper for local Linux transcription:
  python3 -m venv .venv
  .venv/bin/python -m pip install faster-whisper
  Add FASTER_WHISPER_PYTHON=.venv/bin/python to your .env file

Option 2: Install Parakeet for local macOS Apple Silicon transcription (free, private, ~1.5GB download):
  npm install parakeet-coreml
Also requires ffmpeg: sudo apt-get install ffmpeg or brew install ffmpeg

Option 3: Install Cohere Transcribe for local Hugging Face transcription:
  .venv/bin/python -m pip install torch transformers librosa soundfile accelerate
  Add VOICE_PREFERRED_BACKEND=cohere-transcribe to your .env file
  The model may require a Hugging Face login/token before first download.

Option 4: Set OPENAI_API_KEY for cloud transcription (~$0.006/min):
  Add OPENAI_API_KEY=sk-... to your .env file`;
const FASTER_WHISPER_CHECK_SCRIPT = "import faster_whisper";
const FASTER_WHISPER_TRANSCRIBE_SCRIPT = `
import json
import os
import sys
from faster_whisper import WhisperModel

audio_path = sys.argv[1]
model_name = os.environ.get("FASTER_WHISPER_MODEL", "base")
device = os.environ.get("FASTER_WHISPER_DEVICE", "cpu")
compute_type = os.environ.get("FASTER_WHISPER_COMPUTE_TYPE", "int8")
language = os.environ.get("FASTER_WHISPER_LANGUAGE") or None

model = WhisperModel(model_name, device=device, compute_type=compute_type)
segments, info = model.transcribe(audio_path, language=language, vad_filter=True)
text = " ".join(segment.text.strip() for segment in segments).strip()
print(json.dumps({
    "text": text,
    "language": getattr(info, "language", None),
    "duration": getattr(info, "duration", None),
}))
`;
const COHERE_TRANSCRIBE_MODEL_DEFAULT = "CohereLabs/cohere-transcribe-03-2026";
const VOICE_DIAGNOSTICS_CACHE_TTL_MS = 10 * 60 * 1000;
const COHERE_TRANSCRIBE_CHECK_SCRIPT = `
import json
import sys

try:
    import torch
    import transformers
    from transformers import AutoProcessor, CohereAsrForConditionalGeneration
    from transformers.audio_utils import load_audio
except Exception as exc:
    print(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}))
    sys.exit(1)

print(json.dumps({
    "ok": True,
    "torch": getattr(torch, "__version__", None),
    "transformers": getattr(transformers, "__version__", None),
}))
`;
const COHERE_TRANSCRIBE_SCRIPT = `
import json
import os
import sys
import time

import torch
from transformers import AutoProcessor, CohereAsrForConditionalGeneration
from transformers.audio_utils import load_audio

audio_path = sys.argv[1]
model_name = os.environ.get("COHERE_TRANSCRIBE_MODEL", "CohereLabs/cohere-transcribe-03-2026")
device = os.environ.get("COHERE_TRANSCRIBE_DEVICE", "auto").strip().lower()
dtype_name = os.environ.get("COHERE_TRANSCRIBE_DTYPE", "auto").strip().lower()
language = (
    os.environ.get("COHERE_TRANSCRIBE_LANGUAGE")
    or os.environ.get("VOICE_DEFAULT_LANGUAGE")
    or "en"
).strip().lower()
if language in ("", "auto", "default", "detect"):
    language = "en"
punctuation = os.environ.get("COHERE_TRANSCRIBE_PUNCTUATION", "true").strip().lower() not in ("0", "false", "no", "off")
max_new_tokens = int(os.environ.get("COHERE_TRANSCRIBE_MAX_NEW_TOKENS", "1024"))

started = time.time()
processor = AutoProcessor.from_pretrained(model_name)
model_kwargs = {}
if device == "auto":
    model_kwargs["device_map"] = "auto"
if dtype_name not in ("", "auto"):
    model_kwargs["torch_dtype"] = getattr(torch, dtype_name)
model = CohereAsrForConditionalGeneration.from_pretrained(model_name, **model_kwargs)
if device not in ("", "auto"):
    model.to(device)

audio = load_audio(audio_path, sampling_rate=16000)
duration = len(audio) / 16000 if hasattr(audio, "__len__") else None
inputs = processor(
    audio=audio,
    sampling_rate=16000,
    return_tensors="pt",
    language=language,
    punctuation=punctuation,
)
audio_chunk_index = inputs.get("audio_chunk_index")
try:
    model_device = getattr(model, "device", None) or next(model.parameters()).device
except Exception:
    model_device = torch.device("cpu")
model_dtype = getattr(model, "dtype", None)
if model_dtype is not None:
    inputs.to(model_device, dtype=model_dtype)
else:
    inputs.to(model_device)
outputs = model.generate(**inputs, max_new_tokens=max_new_tokens)
text = processor.decode(
    outputs,
    skip_special_tokens=True,
    audio_chunk_index=audio_chunk_index,
    language=language,
)
if isinstance(text, list):
    text = text[0] if text else ""
print(json.dumps({
    "text": str(text).strip(),
    "language": language,
    "duration": duration,
    "elapsed": time.time() - started,
}))
`;

const _require = createRequire(import.meta.url);
let _importModule: (specifier: string) => Promise<unknown> = async (specifier) => _require(specifier);
let _decodeAudio: (filePath: string) => Promise<Float32Array> = decodeAudioToSamples;
let _runCommand: CommandRunner = runCommand;
let _engine: ParakeetEngine | null = null;
let _fasterWhisperAvailable: boolean | undefined;
let _cohereTranscribeAvailable: boolean | undefined;
let _voiceDiagnosticsCache: { key: string; value: VoiceDiagnostics; refreshedAt: number } | undefined;
let _voiceDiagnosticsRefresh: { key: string; promise: Promise<VoiceDiagnostics> } | undefined;

type CommandResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

type CommandRunner = (
  command: string,
  args: string[],
  options?: { env?: NodeJS.ProcessEnv; timeoutMs?: number },
) => Promise<CommandResult>;

export function _setImportHook(hook: (specifier: string) => Promise<unknown>): void {
  _importModule = hook;
}

export function _setDecodeHook(hook: (filePath: string) => Promise<Float32Array>): void {
  _decodeAudio = hook;
}

export function _setCommandHook(hook: CommandRunner): void {
  _runCommand = hook;
  _fasterWhisperAvailable = undefined;
  _cohereTranscribeAvailable = undefined;
  _voiceDiagnosticsCache = undefined;
  _voiceDiagnosticsRefresh = undefined;
}

export function _resetImportHook(): void {
  _importModule = async (specifier) => _require(specifier);
  _decodeAudio = decodeAudioToSamples;
  _runCommand = runCommand;
  _engine = null;
  _fasterWhisperAvailable = undefined;
  _cohereTranscribeAvailable = undefined;
  _voiceDiagnosticsCache = undefined;
  _voiceDiagnosticsRefresh = undefined;
}

export async function transcribeAudio(filePath: string, options: TranscriptionOptions = {}): Promise<TranscriptionResult> {
  for (const backend of backendOrder(options.preferredBackend)) {
    try {
      if (backend === "parakeet") {
        const parakeetMod = await _importModule(PARAKEET_SPECIFIER);
        return await transcribeWithParakeet(filePath, parakeetMod);
      }
      if (backend === "faster-whisper" && await hasFasterWhisper()) {
        return await transcribeWithFasterWhisper(filePath, options);
      }
      if (backend === "cohere-transcribe" && await hasCohereTranscribe()) {
        return await transcribeWithCohereTranscribe(filePath, options);
      }
      if (backend === "openai" && hasOpenAIApiKey()) {
        return await transcribeWithOpenAI(filePath, options);
      }
    } catch (error) {
      if (backend === "parakeet" && isModuleNotFoundError(error, PARAKEET_SPECIFIER)) {
        continue;
      }
      throw error;
    }
  }

  throw new Error(NO_BACKEND_ERROR);
}

export async function getAvailableBackends(): Promise<TranscriptionBackend[]> {
  const backends: TranscriptionBackend[] = [];

  try {
    await _importModule(PARAKEET_SPECIFIER);
    backends.push("parakeet");
  } catch {
    // Treat import failures as unavailable so /start can still work.
  }

  if (await hasFasterWhisper()) {
    backends.push("faster-whisper");
  }

  if (await hasCohereTranscribe()) {
    backends.push("cohere-transcribe");
  }

  if (hasOpenAIApiKey()) {
    backends.push("openai");
  }

  return backends;
}

export async function getVoiceDiagnostics(options: VoiceDiagnosticsOptions = {}): Promise<VoiceDiagnostics> {
  const includeHeavyChecks = options.includeHeavyChecks ?? true;
  const cacheTtlMs = options.cacheTtlMs ?? VOICE_DIAGNOSTICS_CACHE_TTL_MS;
  const key = voiceDiagnosticsCacheKey(options);
  const now = Date.now();

  if (!options.forceRefresh && _voiceDiagnosticsCache?.key === key && now - _voiceDiagnosticsCache.refreshedAt <= cacheTtlMs) {
    return withVoiceDiagnosticsCacheState(_voiceDiagnosticsCache.value, {
      cacheTtlMs,
      heavyChecks: _voiceDiagnosticsCache.value.heavyChecks,
      refreshedAt: _voiceDiagnosticsCache.refreshedAt,
      stale: false,
    });
  }

  if (!includeHeavyChecks) {
    if (_voiceDiagnosticsCache?.key === key && _voiceDiagnosticsCache.value.heavyChecks) {
      return withVoiceDiagnosticsCacheState(_voiceDiagnosticsCache.value, {
        cacheTtlMs,
        heavyChecks: true,
        refreshedAt: _voiceDiagnosticsCache.refreshedAt,
        stale: true,
      });
    }
    return collectVoiceDiagnostics(options, false, cacheTtlMs);
  }

  if (!options.forceRefresh && _voiceDiagnosticsRefresh?.key === key) {
    return _voiceDiagnosticsRefresh.promise;
  }

  const promise = collectVoiceDiagnostics(options, true, cacheTtlMs)
    .then((diagnostics) => {
      _voiceDiagnosticsCache = { key, value: diagnostics, refreshedAt: Date.now() };
      return withVoiceDiagnosticsCacheState(diagnostics, {
        cacheTtlMs,
        heavyChecks: true,
        refreshedAt: _voiceDiagnosticsCache.refreshedAt,
        stale: false,
      });
    })
    .finally(() => {
      if (_voiceDiagnosticsRefresh?.key === key) {
        _voiceDiagnosticsRefresh = undefined;
      }
    });
  _voiceDiagnosticsRefresh = { key, promise };
  return promise;
}

async function collectVoiceDiagnostics(
  options: VoiceDiagnosticsOptions,
  includeHeavyChecks: boolean,
  cacheTtlMs: number,
): Promise<VoiceDiagnostics> {
  const [ffmpeg, parakeet, fasterWhisper, cohereTranscribe] = await Promise.all([
    inspectFfmpeg(),
    inspectParakeet(),
    includeHeavyChecks ? inspectFasterWhisper(options.fasterWhisperPython) : inspectCachedFasterWhisper(options.fasterWhisperPython),
    includeHeavyChecks ? inspectCohereTranscribe() : inspectCachedCohereTranscribe(),
  ]);
  const openai = inspectOpenAI();
  const availableBackends = [parakeet, fasterWhisper, cohereTranscribe, openai]
    .filter((backend): backend is VoiceBackendDiagnostic & { id: TranscriptionBackend } =>
      isTranscriptionBackend(backend.id) && (backend.status === "available" || backend.status === "configured"))
    .map((backend) => backend.id);

  return {
    preferredBackend: options.preferredBackend ?? "auto",
    defaultLanguage: options.defaultLanguage?.trim() || null,
    transcribeOnly: Boolean(options.transcribeOnly),
    availableBackends,
    backends: [ffmpeg, parakeet, fasterWhisper, cohereTranscribe, openai],
    refreshedAt: new Date().toISOString(),
    stale: false,
    heavyChecks: includeHeavyChecks,
    cacheTtlMs,
  };
}

async function transcribeWithParakeet(filePath: string, parakeetMod: unknown): Promise<TranscriptionResult> {
  const startedAt = Date.now();
  const samples = await _decodeAudio(filePath);

  if (!_engine) {
    const mod = parakeetMod as Record<string, unknown> | null;
    const ParakeetAsrEngine =
      (mod?.ParakeetAsrEngine as (new () => unknown) | undefined) ??
      ((mod?.default as Record<string, unknown> | undefined)?.ParakeetAsrEngine as (new () => unknown) | undefined);

    if (typeof ParakeetAsrEngine !== "function") {
      throw new Error("parakeet-coreml was loaded but does not expose a ParakeetAsrEngine class");
    }

    const engine = new ParakeetAsrEngine() as Record<string, unknown>;

    if (typeof engine.initialize !== "function") {
      throw new Error("parakeet-coreml was loaded but the engine does not expose initialize()");
    }

    if (typeof engine.transcribe !== "function") {
      throw new Error("parakeet-coreml was loaded but the engine does not expose transcribe(samples)");
    }

    await (engine.initialize as () => Promise<void>)();
    _engine = engine as unknown as ParakeetEngine;
  }

  const result = await _engine.transcribe(samples);
  const text = extractTranscribedText(result);
  if (text === undefined) {
    throw new Error("parakeet-coreml returned an unsupported transcription result");
  }

  const durationMs =
    typeof result === "object" && result !== null && typeof (result as { durationMs?: unknown }).durationMs === "number"
      ? (result as { durationMs: number }).durationMs
      : Date.now() - startedAt;

  return {
    text,
    backend: "parakeet",
    durationMs,
  };
}

async function transcribeWithFasterWhisper(filePath: string, options: TranscriptionOptions = {}): Promise<TranscriptionResult> {
  const startedAt = Date.now();
  const env = {
    ...process.env,
    ...(options.language ? { FASTER_WHISPER_LANGUAGE: options.language } : {}),
    ...(options.fasterWhisperModel ? { FASTER_WHISPER_MODEL: options.fasterWhisperModel } : {}),
  };
  const result = await _runCommand(
    resolveFasterWhisperPython(),
    ["-c", FASTER_WHISPER_TRANSCRIBE_SCRIPT, filePath],
    {
      env,
      timeoutMs: parsePositiveInteger(process.env.FASTER_WHISPER_TIMEOUT_MS, 10 * 60 * 1000),
    },
  );

  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout || "unknown error").trim();
    throw new Error(`faster-whisper transcription failed (${result.code ?? result.signal ?? "unknown"}): ${detail}`);
  }

  const payload = parseJsonLine(result.stdout) as { text?: unknown; duration?: unknown } | null;
  if (!payload || typeof payload.text !== "string") {
    throw new Error("faster-whisper transcription response did not include a text field");
  }

  return {
    text: payload.text,
    backend: "faster-whisper",
    durationMs: typeof payload.duration === "number" ? Math.round(payload.duration * 1000) : Date.now() - startedAt,
  };
}

async function transcribeWithCohereTranscribe(filePath: string, options: TranscriptionOptions = {}): Promise<TranscriptionResult> {
  const startedAt = Date.now();
  const env = {
    ...process.env,
    ...(options.language ? { VOICE_DEFAULT_LANGUAGE: options.language } : {}),
  };
  const result = await _runCommand(
    resolveCohereTranscribePython(),
    ["-c", COHERE_TRANSCRIBE_SCRIPT, filePath],
    {
      env,
      timeoutMs: parsePositiveInteger(process.env.COHERE_TRANSCRIBE_TIMEOUT_MS, 30 * 60 * 1000),
    },
  );

  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout || "unknown error").trim();
    throw new Error(`Cohere Transcribe failed (${result.code ?? result.signal ?? "unknown"}): ${detail}`);
  }

  const payload = parseJsonLine(result.stdout) as { text?: unknown; duration?: unknown; elapsed?: unknown } | null;
  if (!payload || typeof payload.text !== "string") {
    throw new Error("Cohere Transcribe response did not include a text field");
  }

  return {
    text: payload.text,
    backend: "cohere-transcribe",
    durationMs: typeof payload.duration === "number"
      ? Math.round(payload.duration * 1000)
      : typeof payload.elapsed === "number"
        ? Math.round(payload.elapsed * 1000)
        : Date.now() - startedAt,
  };
}

async function transcribeWithOpenAI(filePath: string, options: TranscriptionOptions = {}): Promise<TranscriptionResult> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(NO_BACKEND_ERROR);
  }

  const startedAt = Date.now();
  const audioBuffer = await readFile(filePath);
  const ext = (path.extname(filePath) || ".ogg").slice(1).toLowerCase();
  const mimeTypes: Record<string, string> = {
    ogg: "audio/ogg", oga: "audio/ogg", mp3: "audio/mpeg",
    m4a: "audio/mp4", aac: "audio/aac", wav: "audio/wav",
    webm: "audio/webm", flac: "audio/flac",
  };
  const mimeType = mimeTypes[ext] ?? "audio/ogg";
  const form = new FormData();
  form.append("file", new Blob([audioBuffer], { type: mimeType }), path.basename(filePath) || "audio.ogg");
  form.append("model", "whisper-1");
  if (options.language) {
    form.append("language", options.language);
  }

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: form,
  });

  if (!response.ok) {
    const errorText = (await response.text().catch(() => "")).trim();
    throw new Error(
      `OpenAI transcription failed (${response.status}): ${errorText || response.statusText || "Unknown error"}`,
    );
  }

  const payload = (await response.json()) as { text?: unknown };
  if (typeof payload.text !== "string") {
    throw new Error("OpenAI transcription response did not include a text field");
  }

  return {
    text: payload.text,
    backend: "openai",
    durationMs: Date.now() - startedAt,
  };
}

async function decodeAudioToSamples(filePath: string): Promise<Float32Array> {
  const ffmpegCommand = resolveFfmpegCommand().command;
  return new Promise<Float32Array>((resolve, reject) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;

    const ffmpeg = spawn(ffmpegCommand, ["-i", filePath, "-ar", "16000", "-ac", "1", "-f", "f32le", "pipe:1"], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      callback();
    };

    ffmpeg.stdout.on("data", (chunk: Buffer | string) => {
      stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    ffmpeg.stderr.on("data", (chunk: Buffer | string) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    ffmpeg.once("error", (error) => {
      finish(() => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          reject(new Error(FFMPEG_INSTALL_MESSAGE));
          return;
        }
        reject(error);
      });
    });

    ffmpeg.once("close", (code, signal) => {
      finish(() => {
        if (code !== 0) {
          const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
          const reason = stderr || (signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`);
          reject(new Error(`ffmpeg failed to decode audio: ${reason}`));
          return;
        }

        const buffer = Buffer.concat(stdoutChunks);
        if (buffer.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
          reject(new Error("ffmpeg returned invalid float32 PCM output"));
          return;
        }

        const samples = new Float32Array(
          buffer.buffer,
          buffer.byteOffset,
          buffer.byteLength / Float32Array.BYTES_PER_ELEMENT,
        ).slice();
        resolve(samples);
      });
    });
  });
}

async function hasFasterWhisper(): Promise<boolean> {
  if (_fasterWhisperAvailable !== undefined) {
    return _fasterWhisperAvailable;
  }

  const result = await _runCommand(resolveFasterWhisperPython(), ["-c", FASTER_WHISPER_CHECK_SCRIPT], {
    env: process.env,
    timeoutMs: 10_000,
  }).catch(() => null);
  _fasterWhisperAvailable = result?.code === 0;
  return _fasterWhisperAvailable;
}

async function hasCohereTranscribe(): Promise<boolean> {
  if (_cohereTranscribeAvailable !== undefined) {
    return _cohereTranscribeAvailable;
  }

  const result = await _runCommand(resolveCohereTranscribePython(), ["-c", COHERE_TRANSCRIBE_CHECK_SCRIPT], {
    env: process.env,
    timeoutMs: 10_000,
  }).catch(() => null);
  _cohereTranscribeAvailable = result?.code === 0;
  return _cohereTranscribeAvailable;
}

function resolveFasterWhisperPython(): string {
  return process.env.FASTER_WHISPER_PYTHON?.trim() || process.env.WHISPER_PYTHON?.trim() || "python3";
}

function resolveCohereTranscribePython(): string {
  return process.env.COHERE_TRANSCRIBE_PYTHON?.trim() || resolveFasterWhisperPython();
}

function resolveFfmpegCommand(env: NodeJS.ProcessEnv = process.env): { command: string; path?: string } {
  const explicit = env.FFMPEG_PATH?.trim();
  if (explicit) return { command: explicit, path: explicit };
  const pathMatch = findExecutableOnSearchPath("ffmpeg", env.PATH, env.PATHEXT);
  if (pathMatch) return { command: "ffmpeg", path: pathMatch };
  const fallback = findExecutableInDirectories("ffmpeg", FFMPEG_FALLBACK_DIRS, env.PATHEXT);
  return fallback ? { command: fallback, path: fallback } : { command: "ffmpeg" };
}

function findExecutableOnSearchPath(command: string, searchPath?: string, pathext?: string): string | undefined {
  const direct = findExecutableCandidate(command, pathext);
  if (direct && (path.isAbsolute(command) || command.includes("/") || command.includes("\\"))) return direct;
  for (const dir of (searchPath || "").split(path.delimiter).filter(Boolean)) {
    const found = findExecutableCandidate(path.join(dir, command), pathext);
    if (found) return found;
  }
  return undefined;
}

function findExecutableInDirectories(command: string, directories: string[], pathext?: string): string | undefined {
  for (const dir of directories) {
    const found = findExecutableCandidate(path.join(dir, command), pathext);
    if (found) return found;
  }
  return undefined;
}

function findExecutableCandidate(candidate: string, pathext?: string): string | undefined {
  for (const name of executableCandidateNames(candidate, pathext)) {
    try {
      accessSync(name, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
      return name;
    } catch {
      // Try the next platform extension candidate.
    }
  }
  return undefined;
}

function executableCandidateNames(candidate: string, pathext?: string): string[] {
  if (process.platform !== "win32" || path.extname(candidate)) return [candidate];
  const extensions = (pathext || ".EXE;.CMD;.BAT;.COM").split(";").map((ext) => ext.trim()).filter(Boolean);
  return [candidate, ...extensions.flatMap((ext) => [candidate + ext.toLowerCase(), candidate + ext.toUpperCase()])];
}

function voiceDiagnosticsCacheKey(options: VoiceDiagnosticsOptions): string {
  const ffmpeg = resolveFfmpegCommand();
  return JSON.stringify({
    preferredBackend: options.preferredBackend ?? "auto",
    defaultLanguage: options.defaultLanguage?.trim() || null,
    transcribeOnly: Boolean(options.transcribeOnly),
    ffmpegPath: ffmpeg.path ?? null,
    fasterWhisperPython: options.fasterWhisperPython?.trim() || resolveFasterWhisperPython(),
    cohereTranscribePython: resolveCohereTranscribePython(),
  });
}

function withVoiceDiagnosticsCacheState(
  diagnostics: VoiceDiagnostics,
  state: { cacheTtlMs: number; heavyChecks: boolean; refreshedAt: number; stale: boolean },
): VoiceDiagnostics {
  return {
    ...diagnostics,
    cacheTtlMs: state.cacheTtlMs,
    heavyChecks: state.heavyChecks,
    refreshedAt: new Date(state.refreshedAt).toISOString(),
    stale: state.stale,
  };
}

function hasOpenAIApiKey(): boolean {
  return Boolean(process.env.OPENAI_API_KEY?.trim());
}

async function inspectFfmpeg(): Promise<VoiceBackendDiagnostic> {
  const ffmpeg = resolveFfmpegCommand();
  const result = await _runCommand(ffmpeg.command, ["-version"], {
    env: process.env,
    timeoutMs: 5_000,
  }).catch((error): CommandResult => ({
    code: null,
    signal: null,
    stdout: "",
    stderr: error instanceof Error ? error.message : String(error),
  }));
  if (result.code !== 0) {
    return {
      id: "ffmpeg",
      label: "ffmpeg",
      status: "missing",
      detail: (result.stderr || result.stdout || "ffmpeg not found").trim(),
      path: ffmpeg.path,
    };
  }
  return {
    id: "ffmpeg",
    label: "ffmpeg",
    status: "available",
    detail: "Audio decoding available.",
    version: firstNonEmptyLine(result.stdout),
    path: ffmpeg.path,
  };
}

async function inspectParakeet(): Promise<VoiceBackendDiagnostic> {
  try {
    await _importModule(PARAKEET_SPECIFIER);
    return {
      id: "parakeet",
      label: "Parakeet CoreML",
      status: "available",
      detail: "Local macOS Apple Silicon transcription backend is installed.",
    };
  } catch (error) {
    const missing = isModuleNotFoundError(error, PARAKEET_SPECIFIER);
    return {
      id: "parakeet",
      label: "Parakeet CoreML",
      status: missing ? "missing" : "error",
      detail: missing ? "Package parakeet-coreml is not installed." : errorDetail(error),
    };
  }
}

async function inspectFasterWhisper(pythonOverride?: string): Promise<VoiceBackendDiagnostic> {
  const python = pythonOverride?.trim() || resolveFasterWhisperPython();
  const result = await _runCommand(python, ["-c", FASTER_WHISPER_CHECK_SCRIPT], {
    env: process.env,
    timeoutMs: 10_000,
  }).catch((error): CommandResult => ({
    code: null,
    signal: null,
    stdout: "",
    stderr: error instanceof Error ? error.message : String(error),
  }));
  if (result.code !== 0) {
    _fasterWhisperAvailable = false;
    return {
      id: "faster-whisper",
      label: "faster-whisper",
      status: "missing",
      detail: (result.stderr || result.stdout || "faster-whisper is not available.").trim(),
      path: python,
    };
  }
  _fasterWhisperAvailable = true;
  return {
    id: "faster-whisper",
    label: "faster-whisper",
    status: "available",
    detail: "Local Python transcription backend is installed.",
    path: python,
  };
}

function inspectCachedFasterWhisper(pythonOverride?: string): VoiceBackendDiagnostic {
  const python = pythonOverride?.trim() || resolveFasterWhisperPython();
  if (_fasterWhisperAvailable === true) {
    return {
      id: "faster-whisper",
      label: "faster-whisper",
      status: "available",
      detail: "Cached availability from a previous voice backend check.",
      path: python,
    };
  }
  if (_fasterWhisperAvailable === false) {
    return {
      id: "faster-whisper",
      label: "faster-whisper",
      status: "missing",
      detail: "Cached unavailable state from a previous voice backend check.",
      path: python,
    };
  }
  return {
    id: "faster-whisper",
    label: "faster-whisper",
    status: "not_collected",
    detail: "Not checked automatically. Use Refresh voice backends to run the Python import probe.",
    path: python,
  };
}

async function inspectCohereTranscribe(): Promise<VoiceBackendDiagnostic> {
  const python = resolveCohereTranscribePython();
  const result = await _runCommand(python, ["-c", COHERE_TRANSCRIBE_CHECK_SCRIPT], {
    env: process.env,
    timeoutMs: 10_000,
  }).catch((error): CommandResult => ({
    code: null,
    signal: null,
    stdout: "",
    stderr: error instanceof Error ? error.message : String(error),
  }));
  const payload = parseJsonLine(result.stdout) as { ok?: unknown; torch?: unknown; transformers?: unknown; error?: unknown } | null;
  if (result.code !== 0 || payload?.ok !== true) {
    _cohereTranscribeAvailable = false;
    return {
      id: "cohere-transcribe",
      label: "Cohere Transcribe",
      status: "missing",
      detail: typeof payload?.error === "string"
        ? payload.error
        : (result.stderr || result.stdout || "Cohere Transcribe Python dependencies are not available.").trim(),
      path: python,
    };
  }
  const model = process.env.COHERE_TRANSCRIBE_MODEL?.trim() || COHERE_TRANSCRIBE_MODEL_DEFAULT;
  _cohereTranscribeAvailable = true;
  const versions = [
    typeof payload.transformers === "string" ? `transformers ${payload.transformers}` : "",
    typeof payload.torch === "string" ? `torch ${payload.torch}` : "",
  ].filter(Boolean).join(" / ");
  return {
    id: "cohere-transcribe",
    label: "Cohere Transcribe",
    status: "available",
    detail: `Local Hugging Face backend is installed. Model ${model} downloads on first use and may require HF_TOKEN for gated access.${versions ? ` ${versions}.` : ""}`,
    path: python,
  };
}

function inspectOpenAI(): VoiceBackendDiagnostic {
  return {
    id: "openai",
    label: "OpenAI Whisper",
    status: hasOpenAIApiKey() ? "configured" : "unconfigured",
    detail: hasOpenAIApiKey()
      ? "OPENAI_API_KEY is configured for cloud transcription."
      : "OPENAI_API_KEY is not configured.",
  };
}

function inspectCachedCohereTranscribe(): VoiceBackendDiagnostic {
  const python = resolveCohereTranscribePython();
  if (_cohereTranscribeAvailable === true) {
    return {
      id: "cohere-transcribe",
      label: "Cohere Transcribe",
      status: "available",
      detail: "Cached availability from a previous voice backend check.",
      path: python,
    };
  }
  if (_cohereTranscribeAvailable === false) {
    return {
      id: "cohere-transcribe",
      label: "Cohere Transcribe",
      status: "missing",
      detail: "Cached unavailable state from a previous voice backend check.",
      path: python,
    };
  }
  return {
    id: "cohere-transcribe",
    label: "Cohere Transcribe",
    status: "not_collected",
    detail: "Not checked automatically because this imports torch/transformers. Use Refresh voice backends to run the probe.",
    path: python,
  };
}

function firstNonEmptyLine(value: string): string | undefined {
  return value.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isTranscriptionBackend(value: unknown): value is TranscriptionBackend {
  return value === "parakeet" || value === "faster-whisper" || value === "cohere-transcribe" || value === "openai";
}

function extractTranscribedText(result: unknown): string | undefined {
  if (typeof result === "string") {
    return result;
  }

  if (typeof result === "object" && result !== null && typeof (result as { text?: unknown }).text === "string") {
    return (result as { text: string }).text;
  }

  return undefined;
}

function parseJsonLine(stdout: string): unknown {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const lastLine = lines.at(-1);
  if (!lastLine) {
    return null;
  }

  try {
    return JSON.parse(lastLine);
  } catch {
    return null;
  }
}

function runCommand(
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve, reject) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;
    const child = spawn(command, args, {
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = options.timeoutMs
      ? setTimeout(() => {
          if (settled) return;
          child.kill("SIGTERM");
          settled = true;
          resolve({
            code: null,
            signal: "SIGTERM",
            stdout: Buffer.concat(stdoutChunks).toString("utf8"),
            stderr: `Command timed out after ${options.timeoutMs}ms`,
          });
        }, options.timeoutMs)
      : undefined;
    timer?.unref?.();

    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      callback();
    };

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    child.once("error", (error) => {
      finish(() => {
        reject(error);
      });
    });

    child.once("close", (code, signal) => {
      finish(() => {
        resolve({
          code,
          signal,
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: Buffer.concat(stderrChunks).toString("utf8"),
        });
      });
    });
  });
}

function parsePositiveInteger(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function backendOrder(preferred: TranscriptionOptions["preferredBackend"]): TranscriptionBackend[] {
  const all: TranscriptionBackend[] = ["parakeet", "faster-whisper", "cohere-transcribe", "openai"];
  if (!preferred || preferred === "auto") {
    return all;
  }
  return [preferred, ...all.filter((backend) => backend !== preferred)];
}

function isModuleNotFoundError(error: unknown, specifier: string): boolean {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") {
    const message = error instanceof Error ? error.message : String(error);
    // Only treat as "not installed" if the message references the specific package.
    // A broken transitive dependency (e.g. missing native addon) should surface as a real error.
    return !message || message.includes(specifier);
  }

  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes(`Cannot find package '${specifier}'`) ||
    message.includes(`Cannot find module '${specifier}'`) ||
    message.includes(`Cannot resolve module '${specifier}'`)
  );
}
