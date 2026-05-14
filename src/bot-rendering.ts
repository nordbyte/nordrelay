import { InlineKeyboard, type Context } from "grammy";

import { CODEX_AGENT_CAPABILITIES, agentLabel, type AgentActivityEvent, type AgentExternalSnapshot, type AgentId, type AgentLaunchProfileRecord, type AgentModelRecord, type AgentPromptInput, type AgentSessionInfo } from "./agent.js";
import { getAgentDiagnostics } from "./agent-activity.js";
import { enabledAgents } from "./agent-factory.js";
import { isTelegramImagePreview, type Artifact, type ArtifactReport, type ArtifactTurnReport } from "./artifacts.js";
import type { AuditEvent } from "./audit-log.js";
import type { TelegramMirrorMode, TelegramNotifyMode, VoiceBackendPreference } from "./bot-preferences.js";
import type { ConnectorConfig } from "./config.js";
import { friendlyErrorText } from "./error-messages.js";
import { escapeHTML } from "./format.js";
import type { getConnectorHealth, VersionCheck } from "./operations.js";
import type { PromptEnvelope, QueuedPrompt } from "./prompt-store.js";
import type { SessionLock } from "./session-locks.js";
import type { SessionRegistry } from "./session-registry.js";
import type { RenderedText } from "./telegram-output.js";
import type { TelegramRateLimitMetrics } from "./telegram-rate-limit.js";

const TOOL_OUTPUT_PREVIEW_LIMIT = 500;
const STREAMING_PREVIEW_LIMIT = 3800;

export interface RateLimitBucket {
  count: number;
  resetAt: number;
  blockedUntil?: number;
}

export type TurnProgress = {
  status: "running" | "completed" | "failed";
  promptDescription: string;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
  currentTool?: string;
  lastTool?: string;
  toolCounts: Map<string, number>;
  textCharacters: number;
  error?: string;
};

export type BusyState = {
  processing: boolean;
  switching: boolean;
  transcribing: boolean;
  approving: boolean;
  external?: boolean;
};

export type ActivityFilter = "all" | "tools" | "errors" | "user" | "agent" | "tasks";

export type ActivityOptions = {
  limit: number;
  filter: ActivityFilter;
  sinceMs?: number;
  exportFile: boolean;
};

export type RuntimeDiagnostics = {
  rateLimit: TelegramRateLimitMetrics;
  externalMirrors: number;
  externalQueueTimers: number;
  queueStatusMessages: number;
  mirrorMode: TelegramMirrorMode;
  notifyMode: TelegramNotifyMode;
  quietHours: string;
  voiceBackend: VoiceBackendPreference;
  voiceLanguage: string;
  voiceTranscribeOnly: boolean;
};

export function renderVersionCheckPlain(check: VersionCheck): string {
  const icon = versionStatusIcon(check);
  const label = check.label === "NordRelay" ? "NordRelay" : `${check.label} version`;
  return `${label}: ${icon} ${formatVersionCheckDetailPlain(check)}`;
}

export function renderVersionCheckHTML(check: VersionCheck): string {
  const icon = versionStatusIcon(check);
  const label = check.label === "NordRelay" ? "NordRelay" : `${check.label} version`;
  return `<b>${escapeHTML(label)}:</b> ${icon} ${formatVersionCheckDetailHTML(check)}`;
}

export function formatCliPathPlain(label: string, cliPath: string | null, fallback: string): string {
  return cliPath ? `${label} path: ${cliPath}` : `${label}: ${fallback}`;
}

export function formatCliPathHTML(label: string, cliPath: string | null, fallback: string): string {
  return cliPath
    ? `<b>${escapeHTML(label)} path:</b> <code>${escapeHTML(cliPath)}</code>`
    : `<b>${escapeHTML(label)}:</b> <code>${escapeHTML(fallback)}</code>`;
}

export function formatVersionCheckDetailPlain(check: VersionCheck): string {
  if (check.status === "not-installed") {
    return "not installed";
  }
  if (check.status === "outdated") {
    return `${check.installedLabel} (latest ${check.latestVersion ?? "unknown"})`;
  }
  if (check.status === "current") {
    return `${check.installedLabel} (latest)`;
  }
  return `${check.installedLabel} (latest unknown${check.detail ? `: ${check.detail}` : ""})`;
}

export function formatVersionCheckDetailHTML(check: VersionCheck): string {
  if (check.status === "not-installed") {
    return "<code>not installed</code>";
  }
  if (check.status === "outdated") {
    return `<code>${escapeHTML(check.installedLabel)}</code> <i>(latest ${escapeHTML(check.latestVersion ?? "unknown")})</i>`;
  }
  if (check.status === "current") {
    return `<code>${escapeHTML(check.installedLabel)}</code> <i>(latest)</i>`;
  }
  return `<code>${escapeHTML(check.installedLabel)}</code> <i>(latest unknown${check.detail ? `: ${escapeHTML(check.detail)}` : ""})</i>`;
}

export function versionStatusIcon(check: VersionCheck): string {
  return check.status === "current" ? "✅" : "⚠️";
}

export function renderAuditEvents(events: AuditEvent[]): { plain: string; html: string } {
  if (events.length === 0) {
    return {
      plain: "Audit log is empty.",
      html: escapeHTML("Audit log is empty."),
    };
  }

  const lines = events.map((event) => {
    const time = formatLocalDateTime(new Date(event.timestamp));
    const actor = event.actor?.label || event.actor?.username || event.actor?.id || (event.actorId ? `user ${event.actorId}` : "system");
    const prompt = event.promptId ? ` · ${event.promptId}` : "";
    const detail = event.detail ? ` · ${trimLine(event.detail, 90)}` : "";
    const description = event.description ? ` · ${trimLine(event.description, 90)}` : "";
    const category = event.category ? ` · ${event.category}` : "";
    return `${time} · ${event.status.toUpperCase()} · ${event.action}${category} · ${actor}${prompt}${description}${detail}`;
  });

  return {
    plain: ["Audit:", ...lines].join("\n"),
    html: [
      "<b>Audit:</b>",
      ...lines.map((line) => escapeHTML(line)),
    ].join("\n"),
  };
}

export function renderSessionLocks(locks: SessionLock[]): { plain: string; html: string } {
  if (locks.length === 0) {
    return {
      plain: "No active session locks.",
      html: escapeHTML("No active session locks."),
    };
  }

  const lines = locks.map((lock) => {
    const expires = lock.expiresAt ? ` · expires ${formatLocalDateTime(new Date(lock.expiresAt))}` : "";
    return `${lock.contextKey} · ${formatLockOwner(lock)}${expires}`;
  });

  return {
    plain: ["Session locks:", ...lines].join("\n"),
    html: ["<b>Session locks:</b>", ...lines.map((line) => escapeHTML(line))].join("\n"),
  };
}

export function formatLockOwner(lock: SessionLock | null): string {
  if (!lock) {
    return "nobody";
  }
  const label = lock.ownerLabel || lock.ownerUserId;
  const channel = lock.ownerChannel ? ` via ${lock.ownerChannel}` : "";
  return `${label} (${lock.ownerUserId})${channel}`;
}

export function formatTelegramName(ctx: Context): string | undefined {
  const firstName = ctx.from?.first_name?.trim();
  const lastName = ctx.from?.last_name?.trim();
  const username = ctx.from?.username?.trim();
  const fullName = [firstName, lastName].filter(Boolean).join(" ").trim();
  return fullName || (username ? `@${username}` : undefined);
}

export function formatLocalDateTime(date: Date): string {
  if (Number.isNaN(date.getTime())) {
    return "-";
  }
  return [
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`,
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`,
  ].join(" ");
}

export function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

export function buildArtifactActionsKeyboard(reports: ArtifactTurnReport[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const [index, report] of reports.slice(0, 5).entries()) {
    const label = `${index + 1}`;
    keyboard
      .text(`${label} Send`, `artifact_send:${report.turnId}`)
      .text(`${label} ZIP`, `artifact_zip:${report.turnId}`)
      .text(`${label} Delete`, `artifact_delete:${report.turnId}`)
      .row();
  }
  return keyboard;
}

export function filterArtifactReports(reports: ArtifactTurnReport[], argument: string): ArtifactTurnReport[] | null {
  const normalized = argument.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  let predicate: ((artifact: Artifact) => boolean) | null = null;
  if (normalized === "images" || normalized === "image" || normalized === "photos") {
    predicate = (artifact) => isTelegramImagePreview(artifact);
  } else if (normalized === "docs" || normalized === "documents" || normalized === "files") {
    predicate = (artifact) => !isTelegramImagePreview(artifact);
  } else if (normalized.startsWith("search ")) {
    const query = normalized.slice("search ".length).trim();
    if (!query) {
      return [];
    }
    predicate = (artifact) => artifact.name.toLowerCase().includes(query);
  }

  if (!predicate) {
    return null;
  }

  return reports
    .map((report) => ({
      ...report,
      artifacts: report.artifacts.filter(predicate),
    }))
    .filter((report) => report.artifacts.length > 0);
}

export function renderProgressPlain(
  progress: TurnProgress | undefined,
  queueLength: number,
  busyState: BusyState,
  info: AgentSessionInfo,
): string {
  const busyFlags = formatBusyFlags(busyState);
  if (!progress) {
    return [
      "Progress:",
      "Status: idle",
      `Thread: ${info.threadId ?? "(not started yet)"}`,
      `Queue: ${queueLength}`,
      `Busy: ${busyFlags || "no"}`,
    ].join("\n");
  }

  const lines = [
    "Progress:",
    `Status: ${progress.status}`,
    `Prompt: ${progress.promptDescription}`,
    `Elapsed: ${formatDurationSeconds(((progress.completedAt ?? Date.now()) - progress.startedAt) / 1000)}`,
    `Current tool: ${progress.currentTool ?? "-"}`,
    `Last tool: ${progress.lastTool ?? "-"}`,
    `Tools: ${formatToolSummaryLine(progress.toolCounts) || "-"}`,
    `Output chars: ${progress.textCharacters}`,
    `Queue: ${queueLength}`,
    `Busy: ${busyFlags || "no"}`,
  ];
  if (progress.error) {
    lines.push(`Error: ${progress.error}`);
  }
  return lines.join("\n");
}

export function renderProgressHTML(
  progress: TurnProgress | undefined,
  queueLength: number,
  busyState: BusyState,
  info: AgentSessionInfo,
): string {
  const busyFlags = formatBusyFlags(busyState);
  if (!progress) {
    return [
      "<b>Progress:</b>",
      "<b>Status:</b> <code>idle</code>",
      `<b>Thread:</b> <code>${escapeHTML(info.threadId ?? "(not started yet)")}</code>`,
      `<b>Queue:</b> <code>${queueLength}</code>`,
      `<b>Busy:</b> <code>${escapeHTML(busyFlags || "no")}</code>`,
    ].join("\n");
  }

  const lines = [
    "<b>Progress:</b>",
    `<b>Status:</b> <code>${escapeHTML(progress.status)}</code>`,
    `<b>Prompt:</b> <code>${escapeHTML(progress.promptDescription)}</code>`,
    `<b>Elapsed:</b> <code>${escapeHTML(formatDurationSeconds(((progress.completedAt ?? Date.now()) - progress.startedAt) / 1000))}</code>`,
    `<b>Current tool:</b> <code>${escapeHTML(progress.currentTool ?? "-")}</code>`,
    `<b>Last tool:</b> <code>${escapeHTML(progress.lastTool ?? "-")}</code>`,
    `<b>Tools:</b> <code>${escapeHTML(formatToolSummaryLine(progress.toolCounts) || "-")}</code>`,
    `<b>Output chars:</b> <code>${progress.textCharacters}</code>`,
    `<b>Queue:</b> <code>${queueLength}</code>`,
    `<b>Busy:</b> <code>${escapeHTML(busyFlags || "no")}</code>`,
  ];
  if (progress.error) {
    lines.push(`<b>Error:</b> <code>${escapeHTML(progress.error)}</code>`);
  }
  return lines.join("\n");
}

export function renderExternalMirrorStatus(
  snapshot: AgentExternalSnapshot,
  queueLength: number,
): { plain: string; html: string } {
  const prompt = trimLine(snapshot.latestUserMessage ?? "-", 180);
  const elapsed = snapshot.activity.startedAt
    ? formatDurationSeconds((Date.now() - snapshot.activity.startedAt.getTime()) / 1000)
    : "-";
  const lines = [
    `${snapshot.agentLabel} CLI task running.`,
    `Thread: ${snapshot.threadId}`,
    `Elapsed: ${elapsed}`,
    `Prompt: ${prompt}`,
    `Last tool: ${snapshot.latestToolName ?? "-"}`,
    `Queue: ${queueLength}`,
  ];
  return {
    plain: lines.join("\n"),
    html: [
      `<b>${escapeHTML(snapshot.agentLabel)} CLI task running.</b>`,
      `<b>Thread:</b> <code>${escapeHTML(snapshot.threadId)}</code>`,
      `<b>Elapsed:</b> <code>${escapeHTML(elapsed)}</code>`,
      `<b>Prompt:</b> <code>${escapeHTML(prompt)}</code>`,
      `<b>Last tool:</b> <code>${escapeHTML(snapshot.latestToolName ?? "-")}</code>`,
      `<b>Queue:</b> <code>${queueLength}</code>`,
    ].join("\n"),
  };
}

export function renderExternalMirrorEvent(event: AgentActivityEvent): { plain: string; html: string } | null {
  if (event.kind === "task") {
    const status = event.status ?? event.type;
    const plain = `CLI task: ${status}`;
    return {
      plain,
      html: `<b>CLI task:</b> <code>${escapeHTML(status)}</code>`,
    };
  }

  if (event.kind !== "tool") {
    return null;
  }

  const status = event.status ?? event.type;
  const tool = event.toolName ?? "tool";
  const detail = event.text ? `\n${trimLine(event.text.replace(/\s+/g, " "), 180)}` : "";
  const plain = `CLI tool ${status}: ${tool}${detail}`;
  return {
    plain,
    html: `<b>CLI tool ${escapeHTML(status)}:</b> <code>${escapeHTML(tool)}</code>${detail ? `\n<code>${escapeHTML(detail.trim())}</code>` : ""}`,
  };
}

export function renderActivityTimeline(
  threadId: string,
  events: AgentActivityEvent[],
  options: ActivityOptions = { limit: 16, filter: "all", exportFile: false },
): { plain: string; html: string } {
  if (events.length === 0) {
    return {
      plain: `Activity:\nThread: ${threadId}\nFilter: ${options.filter}\nNo activity events found.`,
      html: `<b>Activity:</b>\n<b>Thread:</b> <code>${escapeHTML(threadId)}</code>\n<b>Filter:</b> <code>${escapeHTML(options.filter)}</code>\n<code>No activity events found.</code>`,
    };
  }

  const lines = events.map((event) => {
    const time = event.timestamp ? event.timestamp.toISOString().slice(11, 19) : "--:--:--";
    const label = activityEventLabel(event);
    const detail = event.text ? ` · ${trimLine(event.text.replace(/\s+/g, " ").trim(), 120)}` : "";
    const tool = event.toolName ? ` · ${event.toolName}` : "";
    return `${time} · ${label}${tool}${detail}`;
  });

  return {
    plain: ["Activity:", `Thread: ${threadId}`, `Filter: ${options.filter}`, `Events: ${events.length}`, ...lines].join("\n"),
    html: [
      "<b>Activity:</b>",
      `<b>Thread:</b> <code>${escapeHTML(threadId)}</code>`,
      `<b>Filter:</b> <code>${escapeHTML(options.filter)}</code>`,
      `<b>Events:</b> <code>${events.length}</code>`,
      ...lines.map((line) => `<code>${escapeHTML(line)}</code>`),
    ].join("\n"),
  };
}

export function parseActivityOptions(argument: string): ActivityOptions {
  const options: ActivityOptions = {
    limit: 16,
    filter: "all",
    exportFile: false,
  };
  const parts = argument.split(/\s+/).filter(Boolean);
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!.toLowerCase();
    if (/^\d+$/.test(part)) {
      options.limit = Math.min(200, Math.max(1, Number(part)));
      continue;
    }
    if (part === "export") {
      options.exportFile = true;
      continue;
    }
    if (isActivityFilter(part)) {
      options.filter = part;
      continue;
    }
    if (part === "since" && parts[index + 1]) {
      options.sinceMs = parseDurationToMs(parts[index + 1]!);
      index += 1;
    }
  }
  return options;
}

export function filterActivityEvents(events: AgentActivityEvent[], options: ActivityOptions): AgentActivityEvent[] {
  const cutoff = options.sinceMs ? Date.now() - options.sinceMs : undefined;
  return events
    .filter((event) => {
      if (cutoff && event.timestamp && event.timestamp.getTime() < cutoff) {
        return false;
      }
      switch (options.filter) {
        case "tools":
          return event.kind === "tool";
        case "errors":
          return event.status === "failed" || event.status === "error" || /error|failed/i.test(event.text ?? "");
        case "user":
          return event.kind === "user";
        case "agent":
          return event.kind === "agent";
        case "tasks":
          return event.kind === "task";
        default:
          return true;
      }
    })
    .slice(-options.limit);
}

export function isActivityFilter(value: string): value is ActivityFilter {
  return value === "all" || value === "tools" || value === "errors" || value === "user" || value === "agent" || value === "tasks";
}

export function formatAgentLaunchProfileLabel(profile: AgentLaunchProfileRecord, selected: boolean): string {
  const prefix = selected ? "✅" : profile.unsafe ? "⚠️" : "🚀";
  return `${prefix} ${profile.label} · ${trimLine(profile.behavior, 24)}`;
}

export function formatModelButtonLabel(model: AgentModelRecord, selected: boolean): string {
  const meta = [
    model.contextWindow ? formatCompactNumber(model.contextWindow) : undefined,
    model.supportsImages === true ? "img" : model.supportsImages === false ? "text" : undefined,
    model.supportsThinking === true ? "think" : undefined,
  ].filter(Boolean).join(" ");
  return trimLine(`${selected ? "✅ " : ""}${model.displayName}${meta ? ` · ${meta}` : ""}`, 58);
}

export function formatCompactNumber(value: number): string {
  if (value >= 1_000_000_000) return `${Math.round(value / 100_000_000) / 10}B`;
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`;
  if (value >= 1_000) return `${Math.round(value / 100) / 10}K`;
  return String(value);
}

export function renderAgentDiagnostics(diagnostics: ReturnType<typeof getAgentDiagnostics>): { plain: string; html: string } {
  return {
    plain: [
      `${diagnostics.agentLabel} state:`,
      ...diagnostics.lines.map((line) => `${line.label}: ${line.value}`),
    ].join("\n"),
    html: [
      `<b>${escapeHTML(diagnostics.agentLabel)} state:</b>`,
      ...diagnostics.lines.map((line) => `<b>${escapeHTML(line.label)}:</b> <code>${escapeHTML(line.value)}</code>`),
    ].join("\n"),
  };
}

export function activityEventLabel(event: AgentActivityEvent): string {
  if (event.kind === "task") {
    return `task ${event.status ?? event.type}`;
  }
  if (event.kind === "user") {
    return "user";
  }
  if (event.kind === "agent") {
    return event.phase ? `agent ${event.phase}` : "agent";
  }
  return event.status ? `tool ${event.status}` : "tool";
}

export function isEmptyArtifactReport(report: ArtifactReport): boolean {
  return report.artifacts.length === 0 && report.skippedCount === 0 && !(report.omittedCount && report.omittedCount > 0);
}

export function formatBusyFlags(state: BusyState): string {
  return Object.entries(state)
    .filter(([, enabled]) => enabled)
    .map(([name]) => name)
    .join(", ");
}

export function renderDiagnosticsPlain(
  config: ConnectorConfig,
  registry: SessionRegistry,
  health: Awaited<ReturnType<typeof getConnectorHealth>>,
  authenticated: boolean,
  role: string,
  queueLength: number,
  progress: TurnProgress | undefined,
  runtime: RuntimeDiagnostics,
): string {
  const contexts = registry.listContexts();
  return [
    "Diagnostics:",
    `Status: ${health.state.status ?? "unknown"}`,
    `Version: ${health.version}`,
    `Role: ${role}`,
    `Auth: ${authenticated ? "yes" : "no"} (${health.state.authMethod ?? "-"})`,
    `PID: ${health.state.pid ?? "-"} (${health.pidRunning ? "running" : "not running"})`,
    `App PID: ${health.state.appPid ?? "-"} (${health.appPidRunning ? "running" : "not running"})`,
    `Workspace: ${config.workspace}`,
    `State backend: ${config.stateBackend}`,
    `Telegram transport: ${config.telegramTransport}`,
    `Codex CLI: ${health.codexCli}`,
    `Pi CLI: ${health.piCli}`,
    `Hermes CLI: ${health.hermesCli}`,
    `OpenClaw CLI: ${health.openClawCli}`,
    `Claude Code CLI: ${health.claudeCodeCli}`,
    `Hermes API: ${config.hermesApiBaseUrl}`,
    `OpenClaw Gateway: ${config.openClawGatewayUrl}`,
    `Enabled agents/default: ${enabledAgents(config).join(", ")} / ${config.defaultAgent}`,
    `State DB: ${health.databasePath ?? "-"}`,
    `Log file: ${health.logFile}`,
    `Log format: ${config.logFormat}`,
    `Tool verbosity: ${config.toolVerbosity}`,
    `Telegram rate limit queued/running/retries/429: ${runtime.rateLimit.queued}/${runtime.rateLimit.running}/${runtime.rateLimit.retries}/${runtime.rateLimit.rateLimitHits}`,
    `Telegram last retry_after: ${runtime.rateLimit.lastRetryAfterSeconds ?? "-"}s`,
    `CLI mirror mode/update: ${runtime.mirrorMode} / ${config.telegramMirrorMinUpdateMs} ms`,
    `Notify/quiet: ${runtime.notifyMode} / ${runtime.quietHours}`,
    `Voice: ${runtime.voiceBackend} / ${runtime.voiceLanguage} / transcribe-only ${runtime.voiceTranscribeOnly ? "on" : "off"}`,
    `Sync interval: ${config.codexSyncIntervalMs} ms`,
    `External busy check/stale: ${config.codexExternalBusyCheckMs} ms / ${config.codexExternalBusyStaleMs} ms`,
    `External mirrors/timers/status messages: ${runtime.externalMirrors}/${runtime.externalQueueTimers}/${runtime.queueStatusMessages}`,
    `Auto-send artifacts: ${config.telegramAutoSendArtifacts ? "yes" : "no"}`,
    `Artifact ignore dirs/globs: ${config.artifactIgnoreDirs.length}/${config.artifactIgnoreGlobs.length}`,
    `Artifact retention: ${config.artifactRetentionDays}d / ${config.artifactMaxTurnDirs} turns / ${config.artifactMaxInboxDirs} inbox dirs`,
    `Workspace allowed/warn roots: ${config.workspaceAllowedRoots.length}/${config.workspaceWarnRoots.length}`,
    "User management: users/groups/telegram identities",
    `Session lock TTL: ${config.sessionLockTtlMs} ms`,
    `Audit max events: ${config.auditMaxEvents}`,
    `Loaded sessions: ${contexts.length}`,
    `Current queue: ${queueLength}`,
    `Current progress: ${progress?.status ?? "idle"}`,
  ].join("\n");
}

export function renderDiagnosticsHTML(
  config: ConnectorConfig,
  registry: SessionRegistry,
  health: Awaited<ReturnType<typeof getConnectorHealth>>,
  authenticated: boolean,
  role: string,
  queueLength: number,
  progress: TurnProgress | undefined,
  runtime: RuntimeDiagnostics,
): string {
  const contexts = registry.listContexts();
  return [
    "<b>Diagnostics:</b>",
    `<b>Status:</b> <code>${escapeHTML(health.state.status ?? "unknown")}</code>`,
    `<b>Version:</b> <code>${escapeHTML(health.version)}</code>`,
    `<b>Role:</b> <code>${escapeHTML(role)}</code>`,
    `<b>Auth:</b> <code>${authenticated ? "yes" : "no"} (${escapeHTML(health.state.authMethod ?? "-")})</code>`,
    `<b>PID:</b> <code>${escapeHTML(String(health.state.pid ?? "-"))} (${health.pidRunning ? "running" : "not running"})</code>`,
    `<b>App PID:</b> <code>${escapeHTML(String(health.state.appPid ?? "-"))} (${health.appPidRunning ? "running" : "not running"})</code>`,
    `<b>Workspace:</b> <code>${escapeHTML(config.workspace)}</code>`,
    `<b>State backend:</b> <code>${escapeHTML(config.stateBackend)}</code>`,
    `<b>Telegram transport:</b> <code>${escapeHTML(config.telegramTransport)}</code>`,
    `<b>Codex CLI:</b> <code>${escapeHTML(health.codexCli)}</code>`,
    `<b>Pi CLI:</b> <code>${escapeHTML(health.piCli)}</code>`,
    `<b>Hermes CLI:</b> <code>${escapeHTML(health.hermesCli)}</code>`,
    `<b>OpenClaw CLI:</b> <code>${escapeHTML(health.openClawCli)}</code>`,
    `<b>Claude Code CLI:</b> <code>${escapeHTML(health.claudeCodeCli)}</code>`,
    `<b>Hermes API:</b> <code>${escapeHTML(config.hermesApiBaseUrl)}</code>`,
    `<b>OpenClaw Gateway:</b> <code>${escapeHTML(config.openClawGatewayUrl)}</code>`,
    `<b>Enabled agents/default:</b> <code>${escapeHTML(`${enabledAgents(config).join(", ")} / ${config.defaultAgent}`)}</code>`,
    `<b>State DB:</b> <code>${escapeHTML(health.databasePath ?? "-")}</code>`,
    `<b>Log file:</b> <code>${escapeHTML(health.logFile)}</code>`,
    `<b>Log format:</b> <code>${escapeHTML(config.logFormat)}</code>`,
    `<b>Tool verbosity:</b> <code>${escapeHTML(config.toolVerbosity)}</code>`,
    `<b>Telegram rate limit queued/running/retries/429:</b> <code>${runtime.rateLimit.queued}/${runtime.rateLimit.running}/${runtime.rateLimit.retries}/${runtime.rateLimit.rateLimitHits}</code>`,
    `<b>Telegram last retry_after:</b> <code>${escapeHTML(String(runtime.rateLimit.lastRetryAfterSeconds ?? "-"))}s</code>`,
    `<b>CLI mirror mode/update:</b> <code>${escapeHTML(runtime.mirrorMode)} / ${config.telegramMirrorMinUpdateMs} ms</code>`,
    `<b>Notify/quiet:</b> <code>${escapeHTML(runtime.notifyMode)} / ${escapeHTML(runtime.quietHours)}</code>`,
    `<b>Voice:</b> <code>${escapeHTML(runtime.voiceBackend)} / ${escapeHTML(runtime.voiceLanguage)} / transcribe-only ${runtime.voiceTranscribeOnly ? "on" : "off"}</code>`,
    `<b>Sync interval:</b> <code>${config.codexSyncIntervalMs} ms</code>`,
    `<b>External busy check/stale:</b> <code>${config.codexExternalBusyCheckMs} ms / ${config.codexExternalBusyStaleMs} ms</code>`,
    `<b>External mirrors/timers/status messages:</b> <code>${runtime.externalMirrors}/${runtime.externalQueueTimers}/${runtime.queueStatusMessages}</code>`,
    `<b>Auto-send artifacts:</b> <code>${config.telegramAutoSendArtifacts ? "yes" : "no"}</code>`,
    `<b>Artifact ignore dirs/globs:</b> <code>${config.artifactIgnoreDirs.length}/${config.artifactIgnoreGlobs.length}</code>`,
    `<b>Artifact retention:</b> <code>${config.artifactRetentionDays}d / ${config.artifactMaxTurnDirs} turns / ${config.artifactMaxInboxDirs} inbox dirs</code>`,
    `<b>Workspace allowed/warn roots:</b> <code>${config.workspaceAllowedRoots.length}/${config.workspaceWarnRoots.length}</code>`,
    "<b>User management:</b> <code>users/groups/telegram identities</code>",
    `<b>Session lock TTL:</b> <code>${config.sessionLockTtlMs} ms</code>`,
    `<b>Audit max events:</b> <code>${config.auditMaxEvents}</code>`,
    `<b>Loaded sessions:</b> <code>${contexts.length}</code>`,
    `<b>Current queue:</b> <code>${queueLength}</code>`,
    `<b>Current progress:</b> <code>${escapeHTML(progress?.status ?? "idle")}</code>`,
  ].join("\n");
}

export function renderHealthPlain(
  health: Awaited<ReturnType<typeof getConnectorHealth>>,
  authenticated: boolean,
  role: string,
): string {
  return [
    `Status: ${health.state.status ?? "unknown"}`,
    `Version: ${health.version}`,
    `Role: ${role}`,
    `Auth: ${authenticated ? "yes" : "no"}`,
    `PID: ${health.state.pid ?? "-"} (${health.pidRunning ? "running" : "not running"})`,
    `App PID: ${health.state.appPid ?? "-"} (${health.appPidRunning ? "running" : "not running"})`,
    `Uptime: ${formatDuration(health.uptimeSeconds)}`,
    `Workspace: ${health.state.workspace ?? "-"}`,
    `Codex CLI: ${health.codexCli}`,
    `Pi CLI: ${health.piCli}`,
    `Hermes CLI: ${health.hermesCli}`,
    `OpenClaw CLI: ${health.openClawCli}`,
    `Claude Code CLI: ${health.claudeCodeCli}`,
    `Codex state DB: ${health.databasePath ?? "-"}`,
    `Log: ${health.logFile}`,
  ].join("\n");
}

export function renderHealthHTML(
  health: Awaited<ReturnType<typeof getConnectorHealth>>,
  authenticated: boolean,
  role: string,
): string {
  return [
    `<b>Status:</b> <code>${escapeHTML(health.state.status ?? "unknown")}</code>`,
    `<b>Version:</b> <code>${escapeHTML(health.version)}</code>`,
    `<b>Role:</b> <code>${escapeHTML(role)}</code>`,
    `<b>Auth:</b> <code>${authenticated ? "yes" : "no"}</code>`,
    `<b>PID:</b> <code>${escapeHTML(String(health.state.pid ?? "-"))} (${health.pidRunning ? "running" : "not running"})</code>`,
    `<b>App PID:</b> <code>${escapeHTML(String(health.state.appPid ?? "-"))} (${health.appPidRunning ? "running" : "not running"})</code>`,
    `<b>Uptime:</b> <code>${escapeHTML(formatDuration(health.uptimeSeconds))}</code>`,
    `<b>Workspace:</b> <code>${escapeHTML(health.state.workspace ?? "-")}</code>`,
    `<b>Codex CLI:</b> <code>${escapeHTML(health.codexCli)}</code>`,
    `<b>Pi CLI:</b> <code>${escapeHTML(health.piCli)}</code>`,
    `<b>Hermes CLI:</b> <code>${escapeHTML(health.hermesCli)}</code>`,
    `<b>OpenClaw CLI:</b> <code>${escapeHTML(health.openClawCli)}</code>`,
    `<b>Claude Code CLI:</b> <code>${escapeHTML(health.claudeCodeCli)}</code>`,
    `<b>Codex state DB:</b> <code>${escapeHTML(health.databasePath ?? "-")}</code>`,
    `<b>Log:</b> <code>${escapeHTML(health.logFile)}</code>`,
  ].join("\n");
}

export function parseFastModeArgument(argument: string, currentValue: boolean): boolean | undefined {
  if (!argument) {
    return !currentValue;
  }

  const normalized = argument.toLowerCase();
  if (["on", "enable", "enabled", "true", "1"].includes(normalized)) {
    return true;
  }
  if (["off", "disable", "disabled", "false", "0"].includes(normalized)) {
    return false;
  }
  return undefined;
}

export function parseToggle(argument: string): boolean | undefined {
  const normalized = argument.trim().toLowerCase();
  if (["on", "enable", "enabled", "true", "1", "yes"].includes(normalized)) {
    return true;
  }
  if (["off", "disable", "disabled", "false", "0", "no"].includes(normalized)) {
    return false;
  }
  return undefined;
}

export function parseDurationToMs(value: string): number | undefined {
  const match = value.trim().match(/^(\d+)(s|m|h|d)?$/i);
  if (!match) {
    return undefined;
  }
  const amount = Number(match[1]);
  const unit = (match[2] ?? "m").toLowerCase();
  const multiplier = unit === "s"
    ? 1000
    : unit === "h"
      ? 60 * 60 * 1000
      : unit === "d"
        ? 24 * 60 * 60 * 1000
        : 60 * 1000;
  return amount * multiplier;
}

export function extractCommandName(text: string): string | undefined {
  const match = text.trim().match(/^\/([a-zA-Z0-9_-]+)(?:@\w+)?(?:\s|$)/);
  return match?.[1]?.toLowerCase();
}

export function isPromptEnvelopeLike(value: AgentPromptInput | PromptEnvelope): value is PromptEnvelope {
  return typeof value === "object" && value !== null && "input" in value && "description" in value;
}

export function isQueuedPromptLike(value: PromptEnvelope): value is QueuedPrompt {
  return "id" in value &&
    "contextKey" in value &&
    "createdAt" in value &&
    typeof (value as QueuedPrompt).id === "string" &&
    typeof (value as QueuedPrompt).contextKey === "string" &&
    typeof (value as QueuedPrompt).createdAt === "number";
}

export function capabilitiesOf(info: AgentSessionInfo) {
  return info.capabilities ?? CODEX_AGENT_CAPABILITIES;
}

export function labelOf(info: AgentSessionInfo): string {
  return info.agentLabel ?? agentLabel(info.agentId ?? "codex");
}

export function idOf(info: AgentSessionInfo): AgentId {
  return info.agentId ?? "codex";
}

export function authHelpText(info: AgentSessionInfo): string {
  const agentId = idOf(info);
  if (agentId === "pi") {
    return "Configure the required Pi provider environment variable on the host.";
  }
  if (agentId === "hermes") {
    return "Start the Hermes API Server, configure HERMES_API_KEY when required, or use /login to start Hermes CLI auth.";
  }
  if (agentId === "openclaw") {
    return "Start the OpenClaw Gateway and configure OPENCLAW_GATEWAY_TOKEN or OPENCLAW_GATEWAY_PASSWORD when the gateway requires one.";
  }
  if (agentId === "claude-code") {
    return "Use /login to start Claude Code CLI auth, or run 'claude auth login' on the host.";
  }
  return "Use /login to start authentication, or set CODEX_API_KEY on the host.";
}

export function formatAgentSettingScope(info: AgentSessionInfo, appliedToActiveThread: boolean): string {
  const agentId = idOf(info);
  if (agentId === "hermes") {
    return appliedToActiveThread
      ? "applies to the next Hermes run in this session"
      : "applies to new Hermes sessions";
  }
  if (agentId === "pi") {
    return appliedToActiveThread
      ? "applied to the current idle Pi session and future turns"
      : "applies to new Pi sessions";
  }
  if (agentId === "openclaw") {
    return appliedToActiveThread
      ? "applies to the next OpenClaw run in this session"
      : "applies to new OpenClaw sessions";
  }
  if (agentId === "claude-code") {
    return appliedToActiveThread
      ? "applies to the next Claude Code run in this session"
      : "applies to new Claude Code sessions";
  }
  return appliedToActiveThread
    ? "applied to the current idle thread and future threads"
    : "applies to new threads";
}

export function requiresTurnApproval(info: AgentSessionInfo): boolean {
  return info.unsafeLaunch || info.approvalPolicy !== "never";
}

export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

export function formatDurationSeconds(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) {
    return `${minutes}m ${remainingSeconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function renderToolStartMessage(toolName: string): RenderedText {
  return {
    text: `<b>🔧 Running:</b> <code>${escapeHTML(toolName)}</code>`,
    fallbackText: `🔧 Running: ${toolName}`,
    parseMode: "HTML",
  };
}

export function renderToolEndMessage(toolName: string, partialResult: string, isError: boolean): RenderedText {
  const preview = summarizeToolOutput(partialResult);
  const icon = isError ? "❌" : "✅";
  const htmlLines = [`<b>${icon}</b> <code>${escapeHTML(toolName)}</code>`];
  const plainLines = [`${icon} ${toolName}`];

  if (preview) {
    htmlLines.push(`<pre>${escapeHTML(preview)}</pre>`);
    plainLines.push(preview);
  }

  return {
    text: htmlLines.join("\n"),
    fallbackText: plainLines.join("\n"),
    parseMode: "HTML",
  };
}

export function formatToolSummaryLine(toolCounts: Map<string, number>): string {
  if (toolCounts.size === 0) {
    return "";
  }

  const summarizedCounts = new Map<string, number>();
  for (const [toolName, count] of toolCounts.entries()) {
    const summaryName = summarizeToolName(toolName);
    summarizedCounts.set(summaryName, (summarizedCounts.get(summaryName) ?? 0) + count);
  }

  const entries = [...summarizedCounts.entries()].sort((left, right) => {
    const countDelta = right[1] - left[1];
    return countDelta !== 0 ? countDelta : left[0].localeCompare(right[0]);
  });
  const tools = entries
    .map(([name, count]) => formatSummaryEntry(name, count))
    .join(", ");
  return `Tools used: ${tools}`;
}

export function renderTodoList(items: Array<{ text: string; completed: boolean }>): string {
  const lines = items.map((item) => {
    const icon = item.completed ? "✅" : "⬜";
    return `${icon} ${escapeHTML(item.text)}`;
  });
  return `📋 <b>Plan</b>\n${lines.join("\n")}`;
}

export function formatTurnUsageLine(usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number }): string {
  return `🪙 in: ${usage.inputTokens} · cached: ${usage.cachedInputTokens} · out: ${usage.outputTokens}`;
}

export function summarizeToolName(toolName: string): string {
  if (toolName.startsWith("🔍 ")) {
    return "web_fetch";
  }

  if (toolName === "file_change") {
    return "file_change";
  }

  if (toolName === "⚠️ error") {
    return "error";
  }

  if (toolName.startsWith("mcp:")) {
    const tool = toolName.split("/").at(-1) ?? toolName;
    if (SUBAGENT_TOOL_NAMES.has(tool)) {
      return "subagent";
    }
    return tool;
  }

  return "bash";
}

export function formatSummaryEntry(name: string, count: number): string {
  if (count <= 1) {
    return name;
  }

  const label = name === "subagent" ? "subagents" : name;
  return `${count}x ${label}`;
}

const SUBAGENT_TOOL_NAMES = new Set(["spawn_agent", "send_input", "wait_agent", "close_agent", "resume_agent"]);

export function buildStreamingPreview(text: string): string {
  if (text.length <= STREAMING_PREVIEW_LIMIT) {
    return text;
  }

  return `${text.slice(0, STREAMING_PREVIEW_LIMIT)}\n\n… streaming (preview truncated)`;
}

export function appendWithCap(base: string, addition: string, cap: number): string {
  const combined = `${base}${addition}`;
  return combined.length <= cap ? combined : combined.slice(-cap);
}

export function summarizeToolOutput(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }

  return trimmed.length <= TOOL_OUTPUT_PREVIEW_LIMIT ? trimmed : `${trimmed.slice(-TOOL_OUTPUT_PREVIEW_LIMIT)}\n…`;
}

export function trimLine(text: string, maxLength: number): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLength) {
    return singleLine;
  }

  return `${singleLine.slice(0, maxLength - 1)}…`;
}

export function getWorkspaceShortName(workspace: string): string {
  return workspace.split(/[\\/]/).filter(Boolean).pop() ?? workspace;
}

export function formatRelativeTime(date: Date): string {
  const deltaMs = Date.now() - date.getTime();
  const deltaSeconds = Math.max(0, Math.floor(deltaMs / 1000));

  if (deltaSeconds < 60) {
    return "just now";
  }

  const deltaMinutes = Math.floor(deltaSeconds / 60);
  if (deltaMinutes < 60) {
    return `${deltaMinutes}m ago`;
  }

  const deltaHours = Math.floor(deltaMinutes / 60);
  if (deltaHours < 48) {
    return `${deltaHours}h ago`;
  }

  const deltaDays = Math.floor(deltaHours / 24);
  if (deltaDays < 14) {
    return `${deltaDays}d ago`;
  }

  const deltaWeeks = Math.floor(deltaDays / 7);
  return `${deltaWeeks}w ago`;
}

export function filterSessions<T extends {
  id: string;
  title: string | null;
  cwd: string;
  model: string | null;
  firstUserMessage: string | null;
}>(sessions: T[], query: string): T[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return sessions;
  }

  return sessions.filter((session) =>
    [
      session.id,
      session.title ?? "",
      session.cwd,
      session.model ?? "",
      session.firstUserMessage ?? "",
    ].some((value) => value.toLowerCase().includes(normalized)),
  );
}

export function orderPinnedSessions<T extends { id: string }>(sessions: T[], pinnedThreadIds: string[]): T[] {
  const pinnedIndex = new Map(pinnedThreadIds.map((threadId, index) => [threadId, index]));
  return [...sessions].sort((left, right) => {
    const leftPinned = pinnedIndex.get(left.id);
    const rightPinned = pinnedIndex.get(right.id);
    if (leftPinned !== undefined && rightPinned !== undefined) {
      return leftPinned - rightPinned;
    }
    if (leftPinned !== undefined) {
      return -1;
    }
    if (rightPinned !== undefined) {
      return 1;
    }
    return 0;
  });
}

export function consumeRateLimit(
  buckets: Map<string, RateLimitBucket>,
  key: string,
  limit: number,
  windowMs: number,
  blockMs: number,
): { limited: boolean; retryAfterMs?: number } {
  const now = Date.now();
  const existing = buckets.get(key);
  if (existing?.blockedUntil && existing.blockedUntil > now) {
    return { limited: true, retryAfterMs: existing.blockedUntil - now };
  }
  const bucket = !existing || existing.resetAt <= now ? { count: 0, resetAt: now + windowMs } : existing;
  bucket.count += 1;
  if (bucket.count > limit) {
    bucket.blockedUntil = now + blockMs;
    buckets.set(key, bucket);
    return { limited: true, retryAfterMs: blockMs };
  }
  buckets.set(key, bucket);
  return { limited: false };
}

export function resetRateLimit(buckets: Map<string, RateLimitBucket>, key: string): void {
  buckets.delete(key);
}

export function renderPromptFailure(accumulatedText: string, error: unknown): string {
  const message = friendlyErrorText(error);
  return accumulatedText.trim() ? `${accumulatedText.trim()}\n\n⚠️ ${message}` : `⚠️ ${message}`;
}

export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
