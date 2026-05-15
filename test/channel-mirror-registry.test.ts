import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BotPreferencesStore } from "../src/bot-preferences.js";
import { ChannelMirrorRegistry, activeSessionSourceForContextKey } from "../src/channel-mirror-registry.js";
import type { ConnectorConfig } from "../src/config.js";
import { PromptStore, toPromptEnvelope } from "../src/prompt-store.js";
import type { ContextMetadata } from "../src/session-registry.js";

describe("ChannelMirrorRegistry", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(path.join(tmpdir(), "nordrelay-mirror-"));
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("resolves active mirror channels for a thread with queue state", () => {
    const promptStore = new PromptStore(workspace);
    const preferences = new BotPreferencesStore(workspace);
    const registry = new ChannelMirrorRegistry({
      defaultAgent: "codex",
      telegramMirrorMode: "status",
      discordMirrorMode: "full",
      slackMirrorMode: "final",
      webMirrorMode: "status",
    } as ConnectorConfig, promptStore);
    preferences.update("123", { mirrorMode: "final" });
    promptStore.enqueue("123", toPromptEnvelope("telegram queued"));
    promptStore.enqueue("discord:guild:channel", toPromptEnvelope("discord queued"));
    promptStore.enqueue("slack:T123:C123", toPromptEnvelope("slack queued"));
    promptStore.pause("discord:guild:channel");
    const contexts: ContextMetadata[] = [
      { contextKey: "123", agentId: "codex", threadId: "thread-a", updatedAt: 1 },
      { contextKey: "discord:guild:channel", agentId: "codex", threadId: "thread-a", updatedAt: 1 },
      { contextKey: "slack:T123:C123", agentId: "codex", threadId: "thread-a", updatedAt: 1 },
      { contextKey: "web:dashboard", agentId: "codex", threadId: "thread-a", updatedAt: 1 },
      { contextKey: "999", agentId: "codex", threadId: "thread-b", updatedAt: 1 },
    ];

    const mirrors = registry.activeMirrorsForThread("codex", "thread-a", contexts, preferences);

    expect(mirrors).toEqual([
      { source: "telegram", contextKey: "123", mode: "final", queueLength: 1, queuePaused: false },
      { source: "discord", contextKey: "discord:guild:channel", mode: "full", queueLength: 1, queuePaused: true },
      { source: "slack", contextKey: "slack:T123:C123", mode: "final", queueLength: 1, queuePaused: false },
      { source: "web", contextKey: "web:dashboard", mode: "status", queueLength: 0, queuePaused: false },
    ]);
    expect(registry.queueLengthForExternalSource("cli:codex:thread-a", mirrors)).toBe(3);
    expect(registry.queuePausedForExternalSource("cli:codex:thread-a", mirrors)).toBe(true);
    expect(registry.snapshot()).toHaveLength(4);
  });

  it("skips mirror channels when preferences disable mirroring", () => {
    const promptStore = new PromptStore(workspace);
    const preferences = new BotPreferencesStore(workspace);
    const registry = new ChannelMirrorRegistry({
      defaultAgent: "codex",
      telegramMirrorMode: "status",
      discordMirrorMode: "full",
      webMirrorMode: "status",
    } as ConnectorConfig, promptStore);
    preferences.update("123", { mirrorMode: "off" });

    const mirrors = registry.activeMirrorsForThread("codex", "thread-a", [
      { contextKey: "123", agentId: "codex", threadId: "thread-a", updatedAt: 1 },
    ], preferences);

    expect(mirrors).toEqual([]);
    expect(registry.snapshot()).toEqual([]);
  });

  it("classifies active session sources from channel context keys", () => {
    expect(activeSessionSourceForContextKey("123")).toBe("telegram");
    expect(activeSessionSourceForContextKey("discord:guild:channel")).toBe("discord");
    expect(activeSessionSourceForContextKey("slack:T123:C123")).toBe("slack");
    expect(activeSessionSourceForContextKey("web:dashboard")).toBe("web");
    expect(activeSessionSourceForContextKey("cli:codex:thread-a")).toBe("cli");
  });
});
