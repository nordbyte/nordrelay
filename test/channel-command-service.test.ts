import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BotPreferencesStore } from "../src/bot-preferences.js";
import { ChannelCommandService } from "../src/channel-command-service.js";
import type { ConnectorConfig } from "../src/config.js";

describe("ChannelCommandService preference commands", () => {
  let workspace: string;
  let preferencesStore: BotPreferencesStore;
  let service: ChannelCommandService;

  beforeEach(() => {
    workspace = mkdtempSync(path.join(tmpdir(), "nordrelay-command-service-"));
    preferencesStore = new BotPreferencesStore(workspace);
    service = new ChannelCommandService({
      telegramMirrorMode: "status",
      telegramMirrorMinUpdateMs: 4000,
      telegramNotifyMode: "minimal",
      telegramQuietHours: null,
      discordMirrorMode: "full",
      discordMirrorMinUpdateMs: 7000,
      discordNotifyMode: "all",
      discordQuietHours: null,
      voicePreferredBackend: "auto",
      voiceDefaultLanguage: undefined,
      voiceTranscribeOnly: false,
    } as ConnectorConfig);
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("updates mirror mode with channel-specific defaults and output", () => {
    const response = service.renderMirrorPreference({
      source: "discord",
      contextKey: "discord:guild:channel",
      argument: "status",
      preferencesStore,
      cliMirrorSupported: true,
      agentLabel: "Codex",
    });

    expect(preferencesStore.get("discord:guild:channel").mirrorMode).toBe("status");
    expect(response.plain).toContain("CLI mirroring: status");
    expect(response.plain).toContain("Minimum update interval: 7000 ms");
  });

  it("handles notify quiet hours consistently across channels", () => {
    const response = service.renderNotifyPreference({
      source: "telegram",
      contextKey: "123",
      argument: "quiet 22-7",
      preferencesStore,
    });

    expect(preferencesStore.get("123").quietHours).toEqual({ startHour: 22, endHour: 7 });
    expect(response.plain).toContain("Notifications: minimal");
    expect(response.plain).toContain("Quiet hours: 22-07");
  });

  it("returns usage without mutating preferences for invalid voice input", async () => {
    const response = await service.renderVoicePreference({
      source: "telegram",
      contextKey: "123",
      argument: "transcribe_only maybe",
      preferencesStore,
    });

    expect(response.plain).toBe("Usage: /voice transcribe_only on|off");
    expect(preferencesStore.get("123").voiceTranscribeOnly).toBeUndefined();
  });
});
