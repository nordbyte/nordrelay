import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { readFile } from "node:fs/promises";

export interface TranscriptionResult {
  text: string;
  backend: "parakeet" | "faster-whisper" | "openai";
  durationMs: number;
}

export type TranscriptionBackend = "parakeet" | "faster-whisper" | "openai";

export interface TranscriptionOptions {
  preferredBackend?: TranscriptionBackend | "auto";
  language?: string | null;
  fasterWhisperModel?: string;
}

// Minimal interface for the parakeet-coreml engine instance.
interface ParakeetEngine {
  initialize(): Promise<void>;
  transcribe(samples: Float32Array): Promise<unknown>;
}

const PARAKEET_SPECIFIER = "parakeet-coreml";
const FFMPEG_INSTALL_MESSAGE = "ffmpeg not found. Install it with: sudo apt-get install ffmpeg or brew install ffmpeg";
const NO_BACKEND_ERROR = `Voice messages require a transcription backend.

Option 1: Install faster-whisper for local Linux transcription:
  python3 -m venv .venv
  .venv/bin/python -m pip install faster-whisper
  Add FASTER_WHISPER_PYTHON=.venv/bin/python to your .env file

Option 2: Install Parakeet for local macOS Apple Silicon transcription (free, private, ~1.5GB download):
  npm install parakeet-coreml
Also requires ffmpeg: sudo apt-get install ffmpeg or brew install ffmpeg

Option 3: Set OPENAI_API_KEY for cloud transcription (~$0.006/min):
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

const _require = createRequire(import.meta.url);
let _importModule: (specifier: string) => Promise<unknown> = async (specifier) => _require(specifier);
let _decodeAudio: (filePath: string) => Promise<Float32Array> = decodeAudioToSamples;
let _runCommand: CommandRunner = runCommand;
let _engine: ParakeetEngine | null = null;
let _fasterWhisperAvailable: boolean | undefined;

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
}

export function _resetImportHook(): void {
  _importModule = async (specifier) => _require(specifier);
  _decodeAudio = decodeAudioToSamples;
  _runCommand = runCommand;
  _engine = null;
  _fasterWhisperAvailable = undefined;
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

  if (hasOpenAIApiKey()) {
    backends.push("openai");
  }

  return backends;
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

function decodeAudioToSamples(filePath: string): Promise<Float32Array> {
  return new Promise<Float32Array>((resolve, reject) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;

    const ffmpeg = spawn("ffmpeg", ["-i", filePath, "-ar", "16000", "-ac", "1", "-f", "f32le", "pipe:1"], {
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

function resolveFasterWhisperPython(): string {
  return process.env.FASTER_WHISPER_PYTHON?.trim() || process.env.WHISPER_PYTHON?.trim() || "python3";
}

function hasOpenAIApiKey(): boolean {
  return Boolean(process.env.OPENAI_API_KEY?.trim());
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
  const all: TranscriptionBackend[] = ["parakeet", "faster-whisper", "openai"];
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
