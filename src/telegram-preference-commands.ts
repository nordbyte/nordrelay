import type { Bot, Context } from "grammy";

import {
  type BotPreferencesStore,
  formatQuietHours,
  isQuietNow,
  parseMirrorMode,
  parseNotifyMode,
  parseQuietHours,
  parseVoiceBackendPreference,
  type QuietHours,
  type TelegramMirrorMode,
  type TelegramNotifyMode,
  type VoiceBackendPreference,
} from "./bot-preferences.js";
import {
  capabilitiesOf,
  idOf,
  labelOf,
  parseToggle,
} from "./bot-rendering.js";
import type { ConnectorConfig } from "./config.js";
import type { TelegramContextKey } from "./context-key.js";
import { friendlyErrorText } from "./error-messages.js";
import { escapeHTML } from "./format.js";
import { getAvailableBackends } from "./voice.js";
import {
  evaluateWorkspacePolicy,
  filterAllowedWorkspaces,
  renderWorkspacePolicyLine,
} from "./workspace-policy.js";
import type { GetTelegramContextSession } from "./telegram-command-types.js";
import { safeReply } from "./telegram-output.js";

export interface TelegramPreferenceCommandOptions {
  bot: Bot<Context>;
  config: ConnectorConfig;
  preferencesStore: BotPreferencesStore;
  getContextSession: GetTelegramContextSession;
  getEffectiveMirrorMode: (contextKey: TelegramContextKey) => TelegramMirrorMode;
  getEffectiveNotifyMode: (contextKey: TelegramContextKey) => TelegramNotifyMode;
  getEffectiveQuietHours: (contextKey: TelegramContextKey) => QuietHours | null | undefined;
  getEffectiveVoiceBackend: (contextKey: TelegramContextKey) => VoiceBackendPreference;
  getEffectiveVoiceLanguage: (contextKey: TelegramContextKey) => string | null | undefined;
  isVoiceTranscribeOnly: (contextKey: TelegramContextKey) => boolean;
}

export function registerTelegramPreferenceCommands(options: TelegramPreferenceCommandOptions): void {
  options.bot.command("mirror", async (ctx) => {
    const contextSession = await options.getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }
    const { contextKey, session } = contextSession;
    if (!capabilitiesOf(session.getInfo()).cliMirror) {
      const text = `CLI mirroring is not supported for ${labelOf(session.getInfo())} yet.`;
      await safeReply(ctx, escapeHTML(text), { fallbackText: text });
      return;
    }
    const argument = (ctx.message?.text ?? "").replace(/^\/mirror(?:@\w+)?\s*/i, "").trim();
    if (argument) {
      const mode = parseMirrorMode(argument, options.getEffectiveMirrorMode(contextKey));
      if (!["off", "status", "final", "full"].includes(argument.toLowerCase())) {
        await safeReply(ctx, escapeHTML("Usage: /mirror [off|status|final|full]"), {
          fallbackText: "Usage: /mirror [off|status|final|full]",
        });
        return;
      }
      options.preferencesStore.update(contextKey, { mirrorMode: mode });
    }

    const mode = options.getEffectiveMirrorMode(contextKey);
    const plain = [
      `CLI mirroring: ${mode}`,
      `Minimum update interval: ${options.config.telegramMirrorMinUpdateMs} ms`,
      "Modes: off, status, final, full",
    ].join("\n");
    const html = [
      `<b>CLI mirroring:</b> <code>${escapeHTML(mode)}</code>`,
      `<b>Minimum update interval:</b> <code>${options.config.telegramMirrorMinUpdateMs} ms</code>`,
      "<b>Modes:</b> <code>off</code>, <code>status</code>, <code>final</code>, <code>full</code>",
    ].join("\n");
    await safeReply(ctx, html, { fallbackText: plain });
  });

  options.bot.command("notify", async (ctx) => {
    const contextSession = await options.getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }
    const { contextKey } = contextSession;
    const argument = (ctx.message?.text ?? "").replace(/^\/notify(?:@\w+)?\s*/i, "").trim();
    if (argument) {
      const quietMatch = argument.match(/^quiet\s+(.+)$/i);
      if (quietMatch) {
        let quietHours: QuietHours | null;
        try {
          quietHours = quietMatch[1]!.toLowerCase() === "off" ? null : parseQuietHours(quietMatch[1]);
        } catch (error) {
          await safeReply(ctx, escapeHTML(`Invalid quiet hours: ${friendlyErrorText(error)}`), {
            fallbackText: `Invalid quiet hours: ${friendlyErrorText(error)}`,
          });
          return;
        }
        options.preferencesStore.update(contextKey, { quietHours });
      } else {
        const mode = parseNotifyMode(argument, options.getEffectiveNotifyMode(contextKey));
        if (!["off", "minimal", "all"].includes(argument.toLowerCase())) {
          await safeReply(ctx, escapeHTML("Usage: /notify [off|minimal|all] or /notify quiet HH-HH"), {
            fallbackText: "Usage: /notify [off|minimal|all] or /notify quiet HH-HH",
          });
          return;
        }
        options.preferencesStore.update(contextKey, { notifyMode: mode });
      }
    }

    const mode = options.getEffectiveNotifyMode(contextKey);
    const quietHours = options.getEffectiveQuietHours(contextKey);
    const plain = [
      `Notifications: ${mode}`,
      `Quiet hours: ${formatQuietHours(quietHours)}`,
      `Currently quiet: ${isQuietNow(quietHours) ? "yes" : "no"}`,
    ].join("\n");
    const html = [
      `<b>Notifications:</b> <code>${escapeHTML(mode)}</code>`,
      `<b>Quiet hours:</b> <code>${escapeHTML(formatQuietHours(quietHours))}</code>`,
      `<b>Currently quiet:</b> <code>${isQuietNow(quietHours) ? "yes" : "no"}</code>`,
    ].join("\n");
    await safeReply(ctx, html, { fallbackText: plain });
  });

  options.bot.command("workspaces", async (ctx) => {
    const contextSession = await options.getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }
    const { session } = contextSession;
    const agentName = labelOf(session.getInfo());
    const workspaces = filterAllowedWorkspaces(session.listWorkspaces(), options.config);
    const currentWorkspace = session.getInfo().workspace;
    const lines = workspaces.slice(0, 20).map((workspace, index) => {
      const prefix = workspace === currentWorkspace ? "*" : `${index + 1}.`;
      const policy = renderWorkspacePolicyLine(workspace, options.config);
      return `${prefix} ${workspace}${policy ? ` (${policy})` : ""}`;
    });
    const currentPolicy = evaluateWorkspacePolicy(currentWorkspace, options.config);
    const header = [
      "Workspaces:",
      `Current: ${currentWorkspace}`,
      currentPolicy.warning ? `Current warning: ${currentPolicy.warning}` : undefined,
      options.config.workspaceAllowedRoots.length > 0 ? `Allowed roots: ${options.config.workspaceAllowedRoots.join(", ")}` : "Allowed roots: unrestricted",
      "",
    ].filter((line): line is string => Boolean(line));
    const plain = [...header, ...(lines.length > 0 ? lines : [`No workspaces found in ${agentName} state.`])].join("\n");
    const html = [
      "<b>Workspaces:</b>",
      `<b>Current:</b> <code>${escapeHTML(currentWorkspace)}</code>`,
      currentPolicy.warning ? `<b>Current warning:</b> <code>${escapeHTML(currentPolicy.warning)}</code>` : undefined,
      `<b>Allowed roots:</b> <code>${escapeHTML(options.config.workspaceAllowedRoots.length > 0 ? options.config.workspaceAllowedRoots.join(", ") : "unrestricted")}</code>`,
      "",
      ...(lines.length > 0 ? lines.map((line) => `<code>${escapeHTML(line)}</code>`) : [`<code>No workspaces found in ${escapeHTML(agentName)} state.</code>`]),
    ].filter((line): line is string => Boolean(line)).join("\n");
    await safeReply(ctx, html, { fallbackText: plain });
  });

  options.bot.command("voice", async (ctx) => {
    if (!ctx.chat) {
      return;
    }

    const contextSession = await options.getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }
    const { contextKey } = contextSession;
    const argument = (ctx.message?.text ?? "").replace(/^\/voice(?:@\w+)?\s*/i, "").trim();
    if (argument) {
      const parts = argument.split(/\s+/);
      const key = parts[0]?.toLowerCase();
      const value = parts.slice(1).join(" ").trim();
      if (key === "backend" && value) {
        options.preferencesStore.update(contextKey, { voiceBackend: parseVoiceBackendPreference(value) });
      } else if (key === "language") {
        options.preferencesStore.update(contextKey, { voiceLanguage: value && value.toLowerCase() !== "auto" ? value : null });
      } else if (key === "transcribe_only" || key === "transcribe-only") {
        const enabled = parseToggle(value);
        if (enabled === undefined) {
          await safeReply(ctx, escapeHTML("Usage: /voice transcribe_only on|off"), {
            fallbackText: "Usage: /voice transcribe_only on|off",
          });
          return;
        }
        options.preferencesStore.update(contextKey, { voiceTranscribeOnly: enabled });
      } else {
        await safeReply(ctx, escapeHTML("Usage: /voice, /voice backend auto|parakeet|faster-whisper|openai, /voice language auto|<code>, /voice transcribe_only on|off"), {
          fallbackText: "Usage: /voice, /voice backend auto|parakeet|faster-whisper|openai, /voice language auto|<code>, /voice transcribe_only on|off",
        });
        return;
      }
    }

    const backends = await getAvailableBackends().catch(() => []);

    if (backends.length === 0) {
      await safeReply(
        ctx,
        [
          "<b>Voice transcription is not available.</b>",
          "",
          "Install <code>faster-whisper</code> + ffmpeg, install <code>parakeet-coreml</code> on macOS Apple Silicon, or set <code>OPENAI_API_KEY</code>.",
          "<i>Cloud transcription uses OPENAI_API_KEY, not CODEX_API_KEY.</i>",
        ].join("\n"),
        {
          fallbackText: [
            "Voice transcription is not available.",
            "",
            "Install faster-whisper + ffmpeg, install parakeet-coreml on macOS Apple Silicon, or set OPENAI_API_KEY.",
            "Cloud transcription uses OPENAI_API_KEY, not CODEX_API_KEY.",
          ].join("\n"),
        },
      );
      return;
    }

    const joined = backends.join(" + ");
    const backendPreference = options.getEffectiveVoiceBackend(contextKey);
    const language = options.getEffectiveVoiceLanguage(contextKey);
    const transcribeOnly = options.isVoiceTranscribeOnly(contextKey);
    const plain = [
      `Voice backends: ${joined}`,
      `Preferred backend: ${backendPreference}`,
      `Language: ${language ?? "auto"}`,
      `Transcribe only: ${transcribeOnly ? "on" : "off"}`,
    ].join("\n");
    const html = [
      `<b>Voice backends:</b> <code>${escapeHTML(joined)}</code>`,
      `<b>Preferred backend:</b> <code>${escapeHTML(backendPreference)}</code>`,
      `<b>Language:</b> <code>${escapeHTML(language ?? "auto")}</code>`,
      `<b>Transcribe only:</b> <code>${transcribeOnly ? "on" : "off"}</code>`,
    ].join("\n");
    await safeReply(ctx, html, {
      fallbackText: plain,
    });
  });
}
