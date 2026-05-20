import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { agentLabel, type AgentId, type AgentPromptObject } from "../src/agents/shared/agent.js";
import {
  _resetImportHook,
  _setCommandHook,
  _setDecodeHook,
  _setImportHook,
} from "../src/artifacts/voice.js";
import { relayRuntimeSendUploadPrompt } from "../src/runtime/relay-runtime-prompt-queue-artifacts.js";
import type { RelayRuntimeDelegate } from "../src/runtime/relay-runtime-delegate.js";
import type { PromptEnvelope } from "../src/state/prompt-store.js";

describe("audio attachment policy", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "nordrelay-audio-policy-"));
    delete process.env.OPENAI_API_KEY;
    _resetImportHook();
    _setDecodeHook(async () => new Float32Array(32));
    _setCommandHook(async () => ({ code: 1, signal: null, stdout: "", stderr: "missing faster-whisper" }));
  });

  afterEach(() => {
    _resetImportHook();
    vi.restoreAllMocks();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("transcribes audio for Codex without forwarding the raw audio file", async () => {
    mockTranscript("hello from audio");
    const { runtime, envelopes, activities } = runtimeForAgent("codex");

    await relayRuntimeSendUploadPrompt(runtime, {
      correlationId: "cid-audio-codex",
      files: [audioFile()],
    });

    const input = envelopes[0]?.input as AgentPromptObject;
    expect(input.text).toContain("hello from audio");
    expect(input.stagedFileInstructions).toBeUndefined();
    expect(activities.some((event) => event.type === "attachment_filtered")).toBe(true);
  });

  it("does not send unsupported raw audio to Claude Code when transcription fails", async () => {
    mockTranscriptFailure();
    const { runtime, envelopes, activities } = runtimeForAgent("claude-code");

    const result = await relayRuntimeSendUploadPrompt(runtime, {
      correlationId: "cid-audio-claude",
      files: [audioFile()],
    });

    expect(result.transcribeOnly).toBe(true);
    expect(envelopes).toHaveLength(0);
    expect(activities.some((event) => event.type === "attachment_filtered")).toBe(true);
  });

  it("keeps raw audio attachments for agents that may process audio directly", async () => {
    mockTranscriptFailure();
    const { runtime, envelopes } = runtimeForAgent("pi");

    await relayRuntimeSendUploadPrompt(runtime, {
      text: "Please process this voice note.",
      correlationId: "cid-audio-pi",
      files: [audioFile()],
    });

    const input = envelopes[0]?.input as AgentPromptObject;
    expect(input.text).toBe("Please process this voice note.");
    expect(input.stagedFileInstructions).toContain("voice-note.webm");
    expect(input.stagedFileInstructions).toContain("audio/webm");
  });

  function runtimeForAgent(agentId: AgentId): {
    runtime: RelayRuntimeDelegate;
    envelopes: PromptEnvelope[];
    activities: Array<{ type?: string }>;
  } {
    const envelopes: PromptEnvelope[] = [];
    const activities: Array<{ type?: string }> = [];
    const info = {
      agentId,
      agentLabel: agentLabel(agentId),
      threadId: `thread-${agentId}`,
      workspace: tempDir,
    };
    return {
      envelopes,
      activities,
      runtime: {
        config: {
          maxFileSize: 1024 * 1024,
          voicePreferredBackend: "auto",
          voiceDefaultLanguage: undefined,
        },
        getSession: async () => ({
          getInfo: () => info,
        }),
        appendActivity: (event: { type?: string }) => activities.push(event),
        sendEnvelope: async (envelope: PromptEnvelope) => {
          envelopes.push(envelope);
          return { queued: false, correlationId: envelope.correlationId };
        },
      } as unknown as RelayRuntimeDelegate,
    };
  }

  function audioFile() {
    return {
      name: "voice-note.webm",
      mimeType: "audio/webm",
      data: Buffer.from("audio"),
    };
  }

  function mockTranscript(text: string): void {
    _setImportHook(async (specifier) => {
      if (specifier !== "parakeet-coreml") {
        throw new Error(`unexpected import: ${specifier}`);
      }
      return {
        ParakeetAsrEngine: class {
          async initialize(): Promise<void> {}
          async transcribe(): Promise<{ text: string; durationMs: number }> {
            return { text, durationMs: 12 };
          }
        },
      };
    });
  }

  function mockTranscriptFailure(): void {
    _setImportHook(async () => {
      const error = new Error("Cannot find package 'parakeet-coreml'") as Error & { code?: string };
      error.code = "ERR_MODULE_NOT_FOUND";
      throw error;
    });
  }
});
