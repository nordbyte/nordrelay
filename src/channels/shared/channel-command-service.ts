import { listAgentAdapterDescriptors } from "../../agents/shared/agent-adapter.js";
import type { AgentActivityEvent, AgentHandbackResult, AgentId, AgentSessionInfo } from "../../agents/shared/agent.js";
import { enabledAgents } from "../../agents/shared/agent-factory.js";
import type { AuditEvent } from "../../access/audit-log.js";
import {
  type BotPreferencesStore,
  formatQuietHours,
  isQuietNow,
  parseMirrorMode,
  parseNotifyMode,
  parseQuietHours,
  parseVoiceBackendPreference,
  type ChannelMirrorMode,
  type ChannelNotifyMode,
  type QuietHours,
} from "../../state/bot-preferences.js";
import {
  logTailRequests,
  parseLogsCommand,
  renderAgentsAction,
  renderChannelsAction,
  renderLogTailsAction,
  type ChannelActionResponse,
} from "./channel-actions.js";
import { listChannelDescriptors } from "./channel-adapter.js";
import type { ConnectorConfig } from "../../core/config.js";
import { friendlyErrorText } from "../../core/error-messages.js";
import { escapeHTML } from "../../core/format.js";
import {
  getConnectorHealth,
  getVersionChecks,
  readConnectorState,
  readFormattedLogTail,
} from "../../support/operations.js";
import { PeerStore } from "../../peers/peer-store.js";
import {
  formatCliPathHTML,
  formatCliPathPlain,
  renderActivityTimeline,
  renderAuditEvents,
  renderProgressHTML,
  renderProgressPlain,
  parseToggle,
  renderVersionCheckHTML,
  renderVersionCheckPlain,
  type ActivityOptions,
  type BusyState,
  type TurnProgress,
} from "./bot-rendering.js";
import { renderSessionInfoHTML, renderSessionInfoPlain } from "./session-format.js";
import { getAvailableBackends } from "../../artifacts/voice.js";
import { renderNodeTargetAction, renderNodeTargetPreference } from "./channel-node-targets.js";

export type CommandChannelSource = "telegram" | "discord" | "slack" | "matrix" | "web";

export interface ChannelPreferenceCommandOptions {
  source: CommandChannelSource;
  contextKey: string;
  argument: string;
  preferencesStore: BotPreferencesStore;
}

export interface ChannelMirrorCommandOptions extends ChannelPreferenceCommandOptions {
  cliMirrorSupported?: boolean;
  agentLabel?: string;
}

export class ChannelCommandService {
  constructor(private readonly config: ConnectorConfig) {}

  renderChannels(): ChannelActionResponse {
    return renderChannelsAction(listChannelDescriptors(this.config));
  }

  renderAgents(agentIds: AgentId[] = enabledAgents(this.config)): ChannelActionResponse {
    return renderAgentsAction(listAgentAdapterDescriptors(), agentIds);
  }

  renderPeers(): ChannelActionResponse {
    const peers = new PeerStore().listPublic();
    if (peers.length === 0) {
      return {
        plain: "No NordRelay peers configured.",
        html: "No NordRelay peers configured.",
      };
    }
    const plain = peers.map((peer) => [
      `${peer.name} (${peer.id}) ${peer.enabled ? "enabled" : "disabled"}`,
      `URL: ${peer.url ?? "-"}`,
      `Node: ${peer.nodeId}`,
      `Scopes: ${peer.scopes.join(", ") || "-"}`,
      peer.remoteStatus || peer.lastLatencyMs !== undefined ? `Health: ${peer.remoteStatus ?? "seen"}${peer.lastLatencyMs !== undefined ? ` / ${peer.lastLatencyMs}ms` : ""}${peer.remoteVersion ? ` / v${peer.remoteVersion}` : ""}` : "",
      Object.keys(peer.workspaceAliases ?? {}).length > 0 ? `Aliases: ${Object.entries(peer.workspaceAliases).map(([alias, workspace]) => `${alias}=${workspace}`).join(", ")}` : "",
      peer.lastSeenAt ? `Last seen: ${peer.lastSeenAt}` : "",
      peer.lastError ? `Last error: ${peer.lastError}` : "",
    ].filter(Boolean).join("\n")).join("\n\n");
    const html = peers.map((peer) => [
      `<b>${escapeHTML(peer.name)} (${escapeHTML(peer.id)})</b> <code>${peer.enabled ? "enabled" : "disabled"}</code>`,
      `<b>URL:</b> <code>${escapeHTML(peer.url ?? "-")}</code>`,
      `<b>Node:</b> <code>${escapeHTML(peer.nodeId)}</code>`,
      `<b>Scopes:</b> <code>${escapeHTML(peer.scopes.join(", ") || "-")}</code>`,
      peer.remoteStatus || peer.lastLatencyMs !== undefined ? `<b>Health:</b> <code>${escapeHTML(`${peer.remoteStatus ?? "seen"}${peer.lastLatencyMs !== undefined ? ` / ${peer.lastLatencyMs}ms` : ""}${peer.remoteVersion ? ` / v${peer.remoteVersion}` : ""}`)}</code>` : "",
      Object.keys(peer.workspaceAliases ?? {}).length > 0 ? `<b>Aliases:</b> <code>${escapeHTML(Object.entries(peer.workspaceAliases).map(([alias, workspace]) => `${alias}=${workspace}`).join(", "))}</code>` : "",
      peer.lastSeenAt ? `<b>Last seen:</b> <code>${escapeHTML(peer.lastSeenAt)}</code>` : "",
      peer.lastError ? `<b>Last error:</b> <code>${escapeHTML(peer.lastError)}</code>` : "",
    ].filter(Boolean).join("\n")).join("\n\n");
    return { plain, html };
  }

  renderTargetPreference(options: ChannelPreferenceCommandOptions): ChannelActionResponse {
    return renderNodeTargetPreference(options);
  }

  renderNodeTargets(options: ChannelPreferenceCommandOptions): ChannelActionResponse {
    return renderNodeTargetPreference(options);
  }

  renderNodeTargetAction(options: ChannelPreferenceCommandOptions & { action: string }): ChannelActionResponse {
    return renderNodeTargetAction({
      contextKey: options.contextKey,
      preferencesStore: options.preferencesStore,
      action: options.action,
    });
  }

  async renderLogs(argument: string): Promise<ChannelActionResponse> {
    const logRequest = parseLogsCommand(argument);
    const logs = await Promise.all(logTailRequests(logRequest.target).map(async (request) => ({
      title: request.title,
      tail: await readFormattedLogTail(logRequest.lines, request.path),
    })));
    return renderLogTailsAction(logs);
  }

  async renderVersion(): Promise<ChannelActionResponse> {
    const health = await getConnectorHealth(cliPathOptions(this.config));
    const state = await readConnectorState();
    const versions = await getVersionChecks(cliPathOptions(this.config));
    const plain = [
      renderVersionCheckPlain(versions.nordrelay),
      `Runtime status: ${state.status ?? "unknown"}`,
      formatCliPathPlain("Codex CLI", health.codexCliPath, health.codexCli),
      renderVersionCheckPlain(versions.codex),
      formatCliPathPlain("Pi CLI", health.piCliPath, health.piCli),
      renderVersionCheckPlain(versions.pi),
      formatCliPathPlain("Hermes CLI", health.hermesCliPath, health.hermesCli),
      renderVersionCheckPlain(versions.hermes),
      formatCliPathPlain("OpenClaw CLI", health.openClawCliPath, health.openClawCli),
      renderVersionCheckPlain(versions.openclaw),
      formatCliPathPlain("Claude Code CLI", health.claudeCodeCliPath, health.claudeCodeCli),
      renderVersionCheckPlain(versions.claudeCode),
    ].join("\n");
    const html = [
      renderVersionCheckHTML(versions.nordrelay),
      `<b>Runtime status:</b> <code>${escapeHTML(state.status ?? "unknown")}</code>`,
      formatCliPathHTML("Codex CLI", health.codexCliPath, health.codexCli),
      renderVersionCheckHTML(versions.codex),
      formatCliPathHTML("Pi CLI", health.piCliPath, health.piCli),
      renderVersionCheckHTML(versions.pi),
      formatCliPathHTML("Hermes CLI", health.hermesCliPath, health.hermesCli),
      renderVersionCheckHTML(versions.hermes),
      formatCliPathHTML("OpenClaw CLI", health.openClawCliPath, health.openClawCli),
      renderVersionCheckHTML(versions.openclaw),
      formatCliPathHTML("Claude Code CLI", health.claudeCodeCliPath, health.claudeCodeCli),
      renderVersionCheckHTML(versions.claudeCode),
    ].join("\n");
    return { plain, html };
  }

  renderAuthStatus(status: { label: string; authenticated: boolean; method?: string; detail: string }): ChannelActionResponse {
    const icon = status.authenticated ? "✅" : "❌";
    return {
      plain: [
        `${icon} ${status.label} auth: ${status.authenticated ? "authenticated" : "not authenticated"}`,
        `Method: ${status.method ?? "-"}`,
        `Detail: ${status.detail}`,
      ].join("\n"),
      html: [
        `<b>${icon} ${escapeHTML(status.label)} auth:</b> <code>${status.authenticated ? "authenticated" : "not authenticated"}</code>`,
        `<b>Method:</b> <code>${escapeHTML(status.method ?? "-")}</code>`,
        `<b>Detail:</b> <code>${escapeHTML(status.detail)}</code>`,
      ].join("\n"),
    };
  }

  renderAuthActionResult(action: "login" | "logout", result: { success: boolean; message: string }): ChannelActionResponse {
    const label = action === "login" ? "Login" : "Logout";
    const icon = result.success ? "✅" : "❌";
    return {
      plain: [`${icon} ${label} ${result.success ? "started" : "failed"}.`, "", result.message].join("\n"),
      html: [`<b>${icon} ${escapeHTML(label)} ${result.success ? "started" : "failed"}.</b>`, "", `<code>${escapeHTML(result.message)}</code>`].join("\n"),
    };
  }

  renderHostAuthInstruction(label: string, command: string, action: "login" | "logout"): ChannelActionResponse {
    const text = `${label} ${action} is not managed remotely. Run this on the host: ${command}`;
    return {
      plain: text,
      html: `<b>${escapeHTML(label)} ${escapeHTML(action)} is not managed remotely.</b>\nRun this on the host:\n<code>${escapeHTML(command)}</code>`,
    };
  }

  renderProgress(progress: TurnProgress | undefined, queueLength: number, busyState: BusyState, info: AgentSessionInfo): ChannelActionResponse {
    return {
      plain: renderProgressPlain(progress, queueLength, busyState, info),
      html: renderProgressHTML(progress, queueLength, busyState, info),
    };
  }

  renderActivity(threadId: string, events: AgentActivityEvent[], options: ActivityOptions): ChannelActionResponse {
    return renderActivityTimeline(threadId, events, options);
  }

  renderAudit(events: AuditEvent[]): ChannelActionResponse {
    return renderAuditEvents(events);
  }

  renderMirrorPreference(options: ChannelMirrorCommandOptions): ChannelActionResponse {
    if (options.cliMirrorSupported === false) {
      const text = `CLI mirroring is not supported for ${options.agentLabel ?? "this agent"} yet.`;
      return { plain: text, html: escapeHTML(text) };
    }

    const argument = options.argument.trim();
    if (argument) {
      const normalized = argument.toLowerCase();
      if (!["off", "status", "final", "full"].includes(normalized)) {
        return usageResponse("Usage: /mirror [off|status|final|full]");
      }
      options.preferencesStore.update(options.contextKey, {
        mirrorMode: parseMirrorMode(argument, this.defaultMirrorMode(options.source)),
      });
    }

    const mode = this.effectiveMirrorMode(options.source, options.contextKey, options.preferencesStore);
    const minInterval = this.mirrorMinUpdateMs(options.source);
    return {
      plain: [
        `CLI mirroring: ${mode}`,
        `Minimum update interval: ${minInterval} ms`,
        "Modes: off, status, final, full",
      ].join("\n"),
      html: [
        `<b>CLI mirroring:</b> <code>${escapeHTML(mode)}</code>`,
        `<b>Minimum update interval:</b> <code>${minInterval} ms</code>`,
        "<b>Modes:</b> <code>off</code>, <code>status</code>, <code>final</code>, <code>full</code>",
      ].join("\n"),
    };
  }

  renderNotifyPreference(options: ChannelPreferenceCommandOptions): ChannelActionResponse {
    const argument = options.argument.trim();
    if (argument) {
      const quietMatch = argument.match(/^quiet\s+(.+)$/i);
      if (quietMatch) {
        try {
          const quietHours = quietMatch[1]!.toLowerCase() === "off" ? null : parseQuietHours(quietMatch[1]);
          options.preferencesStore.update(options.contextKey, { quietHours });
        } catch (error) {
          const text = `Invalid quiet hours: ${friendlyErrorText(error)}`;
          return { plain: text, html: escapeHTML(text) };
        }
      } else {
        const normalized = argument.toLowerCase();
        if (!["off", "minimal", "all"].includes(normalized)) {
          return usageResponse("Usage: /notify [off|minimal|all] or /notify quiet HH-HH");
        }
        options.preferencesStore.update(options.contextKey, {
          notifyMode: parseNotifyMode(argument, this.defaultNotifyMode(options.source)),
        });
      }
    }

    const mode = this.effectiveNotifyMode(options.source, options.contextKey, options.preferencesStore);
    const quietHours = this.effectiveQuietHours(options.source, options.contextKey, options.preferencesStore);
    return {
      plain: [
        `Notifications: ${mode}`,
        `Quiet hours: ${formatQuietHours(quietHours)}`,
        `Currently quiet: ${isQuietNow(quietHours) ? "yes" : "no"}`,
      ].join("\n"),
      html: [
        `<b>Notifications:</b> <code>${escapeHTML(mode)}</code>`,
        `<b>Quiet hours:</b> <code>${escapeHTML(formatQuietHours(quietHours))}</code>`,
        `<b>Currently quiet:</b> <code>${isQuietNow(quietHours) ? "yes" : "no"}</code>`,
      ].join("\n"),
    };
  }

  async renderVoicePreference(options: ChannelPreferenceCommandOptions): Promise<ChannelActionResponse> {
    const argument = options.argument.trim();
    if (argument) {
      const parts = argument.split(/\s+/);
      const key = parts[0]?.toLowerCase();
      const value = parts.slice(1).join(" ").trim();
      if (key === "backend" && value) {
        const normalized = value.toLowerCase();
        if (!["auto", "parakeet", "faster-whisper", "cohere-transcribe", "openai"].includes(normalized)) {
          return usageResponse("Usage: /voice backend auto|parakeet|faster-whisper|cohere-transcribe|openai");
        }
        options.preferencesStore.update(options.contextKey, { voiceBackend: parseVoiceBackendPreference(value) });
      } else if (key === "language") {
        options.preferencesStore.update(options.contextKey, { voiceLanguage: value && value.toLowerCase() !== "auto" ? value : null });
      } else if (key === "transcribe_only" || key === "transcribe-only") {
        const enabled = parseToggle(value);
        if (enabled === undefined) {
          return usageResponse("Usage: /voice transcribe_only on|off");
        }
        options.preferencesStore.update(options.contextKey, { voiceTranscribeOnly: enabled });
      } else {
        return usageResponse("Usage: /voice, /voice backend auto|parakeet|faster-whisper|cohere-transcribe|openai, /voice language auto|language-code, /voice transcribe_only on|off");
      }
    }

    const backends = await getAvailableBackends().catch(() => []);
    if (backends.length === 0) {
      const plain = [
        "Voice transcription is not available.",
        "",
        "Install faster-whisper + ffmpeg, install Cohere Transcribe local dependencies, install parakeet-coreml on macOS Apple Silicon, or set OPENAI_API_KEY.",
        "Cloud transcription uses OPENAI_API_KEY, not CODEX_API_KEY.",
      ].join("\n");
      const html = [
        "<b>Voice transcription is not available.</b>",
        "",
        "Install <code>faster-whisper</code> + ffmpeg, install Cohere Transcribe local dependencies, install <code>parakeet-coreml</code> on macOS Apple Silicon, or set <code>OPENAI_API_KEY</code>.",
        "<i>Cloud transcription uses OPENAI_API_KEY, not CODEX_API_KEY.</i>",
      ].join("\n");
      return { plain, html };
    }

    const prefs = options.preferencesStore.get(options.contextKey);
    const backendPreference = prefs.voiceBackend ?? this.config.voicePreferredBackend;
    const language = prefs.voiceLanguage === undefined ? this.config.voiceDefaultLanguage ?? null : prefs.voiceLanguage;
    const transcribeOnly = prefs.voiceTranscribeOnly ?? this.config.voiceTranscribeOnly;
    const joined = backends.join(" + ");
    return {
      plain: [
        `Voice backends: ${joined}`,
        `Preferred backend: ${backendPreference}`,
        `Language: ${language ?? "auto"}`,
        `Transcribe only: ${transcribeOnly ? "on" : "off"}`,
      ].join("\n"),
      html: [
        `<b>Voice backends:</b> <code>${escapeHTML(joined)}</code>`,
        `<b>Preferred backend:</b> <code>${escapeHTML(backendPreference)}</code>`,
        `<b>Language:</b> <code>${escapeHTML(language ?? "auto")}</code>`,
        `<b>Transcribe only:</b> <code>${transcribeOnly ? "on" : "off"}</code>`,
      ].join("\n"),
    };
  }

  renderWorkspaces(info: AgentSessionInfo, workspaces: string[]): ChannelActionResponse {
    const unique = [...new Set(workspaces)].filter(Boolean);
    const rows = unique.length > 0
      ? unique.map((workspace, index) => `${index + 1}. ${workspace}${workspace === info.workspace ? " (current)" : ""}`)
      : [`No workspaces found in ${info.agentLabel} state.`];
    return {
      plain: [`${info.agentLabel} workspaces:`, ...rows].join("\n"),
      html: [
        `<b>${escapeHTML(info.agentLabel)} workspaces:</b>`,
        ...rows.map((line) => `<code>${escapeHTML(line)}</code>`),
      ].join("\n"),
    };
  }

  renderHandback(result: AgentHandbackResult): ChannelActionResponse {
    const command = result.command ?? (result.threadId
      ? `cd ${shellEscape(result.workspace)} && codex resume ${shellEscape(result.threadId)}`
      : "");
    if (!result.threadId || !command) {
      const text = "This thread has not started yet, so there is no resumable thread ID. Send a message to create one, or start a new session.";
      return { plain: text, html: escapeHTML(text) };
    }
    const label = result.label ?? "Agent CLI";
    return {
      plain: [
        `Thread handed back to ${label}.`,
        "",
        "Run this in your terminal:",
        command,
        "",
        "Send any message here to start a new NordRelay thread.",
      ].join("\n"),
      html: [
        `<b>Thread handed back to ${escapeHTML(label)}.</b>`,
        "",
        "Run this in your terminal:",
        `<pre>${escapeHTML(command)}</pre>`,
        "",
        "Send any message here to start a new NordRelay thread.",
      ].join("\n"),
    };
  }

  private defaultMirrorMode(source: CommandChannelSource): ChannelMirrorMode {
    if (source === "telegram") {
      return this.config.telegramMirrorMode;
    }
    if (source === "discord") {
      return this.config.discordMirrorMode;
    }
    if (source === "slack") {
      return this.config.slackMirrorMode;
    }
    if (source === "matrix") {
      return this.config.matrixMirrorMode;
    }
    return this.config.webMirrorMode;
  }

  private mirrorMinUpdateMs(source: CommandChannelSource): number {
    if (source === "telegram") {
      return this.config.telegramMirrorMinUpdateMs;
    }
    if (source === "discord") {
      return this.config.discordMirrorMinUpdateMs;
    }
    if (source === "slack") {
      return this.config.slackMirrorMinUpdateMs;
    }
    if (source === "matrix") {
      return this.config.matrixMirrorMinUpdateMs;
    }
    return this.config.webMirrorMinUpdateMs;
  }

  private defaultNotifyMode(source: CommandChannelSource): ChannelNotifyMode {
    if (source === "telegram") {
      return this.config.telegramNotifyMode;
    }
    if (source === "discord") {
      return this.config.discordNotifyMode;
    }
    if (source === "slack") {
      return this.config.slackNotifyMode;
    }
    if (source === "matrix") {
      return this.config.matrixNotifyMode;
    }
    return this.config.notifyMode;
  }

  private defaultQuietHours(source: CommandChannelSource): QuietHours | null | undefined {
    if (source === "telegram") {
      return this.config.telegramQuietHours;
    }
    if (source === "discord") {
      return this.config.discordQuietHours;
    }
    if (source === "slack") {
      return this.config.slackQuietHours;
    }
    if (source === "matrix") {
      return this.config.matrixQuietHours;
    }
    return this.config.quietHours;
  }

  private effectiveMirrorMode(source: CommandChannelSource, contextKey: string, preferencesStore: BotPreferencesStore): ChannelMirrorMode {
    return preferencesStore.get(contextKey).mirrorMode ?? this.defaultMirrorMode(source);
  }

  private effectiveNotifyMode(source: CommandChannelSource, contextKey: string, preferencesStore: BotPreferencesStore): ChannelNotifyMode {
    return preferencesStore.get(contextKey).notifyMode ?? this.defaultNotifyMode(source);
  }

  private effectiveQuietHours(source: CommandChannelSource, contextKey: string, preferencesStore: BotPreferencesStore): QuietHours | null | undefined {
    const prefs = preferencesStore.get(contextKey);
    return prefs.quietHours === undefined ? this.defaultQuietHours(source) : prefs.quietHours;
  }
}

export function cliPathOptions(config: ConnectorConfig): {
  piCliPath?: string;
  hermesCliPath?: string;
  openClawCliPath?: string;
  claudeCodeCliPath?: string;
} {
  return {
    piCliPath: config.piCliPath,
    hermesCliPath: config.hermesCliPath,
    openClawCliPath: config.openClawCliPath,
    claudeCodeCliPath: config.claudeCodeCliPath,
  };
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function usageResponse(text: string): ChannelActionResponse {
  return { plain: text, html: escapeHTML(text) };
}
