import path from "node:path";

import type { AgentExternalSnapshot, AgentId, AgentSessionInfo, AgentSessionService } from "../agents/shared/agent.js";
import { getExternalSnapshotForSession } from "../agents/shared/agent-activity.js";
import type { AgentUpdateJobSnapshot } from "../agents/shared/agent-updates.js";
import type { StagedFile } from "../artifacts/attachments.js";
import type { ConnectorConfig } from "../core/config.js";
import type { getConnectorHealth, getVersionChecks } from "../support/operations.js";
import type {
  ActiveSessionDto,
  RelayEvent,
  UnifiedJobDto,
  UploadPromptResult,
  WebAdapterHealthDto,
  WebTaskDto,
} from "./relay-runtime-types.js";
import type { WebActivityEvent } from "../web/web-state.js";

export function cliHealthForAgent(agentId: AgentId, health: Awaited<ReturnType<typeof getConnectorHealth>>): WebAdapterHealthDto["cli"] {
  if (agentId === "pi") {
    return { path: health.piCliPath, label: health.piCli, version: health.piCliVersion };
  }
  if (agentId === "hermes") {
    return { path: health.hermesCliPath, label: health.hermesCli, version: health.hermesCliVersion };
  }
  if (agentId === "openclaw") {
    return { path: health.openClawCliPath, label: health.openClawCli, version: health.openClawCliVersion };
  }
  if (agentId === "claude-code") {
    return { path: health.claudeCodeCliPath, label: health.claudeCodeCli, version: health.claudeCodeCliVersion };
  }
  return { path: health.codexCliPath, label: health.codexCli, version: health.codexCliVersion };
}

export function versionCheckForAgent(agentId: AgentId, versions: Awaited<ReturnType<typeof getVersionChecks>>) {
  if (agentId === "pi") return versions.pi;
  if (agentId === "hermes") return versions.hermes;
  if (agentId === "openclaw") return versions.openclaw;
  if (agentId === "claude-code") return versions.claudeCode;
  return versions.codex;
}

export function hostLoginCommand(info: AgentSessionInfo, config: ConnectorConfig): string {
  if (info.agentId === "hermes") {
    return `${config.hermesCliPath ?? "hermes"} login --no-browser`;
  }
  if (info.agentId === "claude-code") {
    return `${config.claudeCodeCliPath ?? "claude"} auth login`;
  }
  if (info.agentId === "pi") {
    return `${config.piCliPath ?? "pi"} auth login`;
  }
  if (info.agentId === "openclaw") {
    return `${config.openClawCliPath ?? "openclaw"} login`;
  }
  return "codex login --device-auth";
}

export function hostLogoutCommand(info: AgentSessionInfo, config: ConnectorConfig): string {
  if (info.agentId === "hermes") {
    return `${config.hermesCliPath ?? "hermes"} logout`;
  }
  if (info.agentId === "claude-code") {
    return `${config.claudeCodeCliPath ?? "claude"} auth logout`;
  }
  if (info.agentId === "pi") {
    return `${config.piCliPath ?? "pi"} auth logout`;
  }
  if (info.agentId === "openclaw") {
    return `${config.openClawCliPath ?? "openclaw"} logout`;
  }
  return "codex logout";
}

export function activeSessionPriority(session: ActiveSessionDto): number {
  if (session.status === "running") {
    return 3;
  }
  return session.contextKey.startsWith("cli:") ? 1 : 2;
}

export function shouldRefreshActiveSessions(event: RelayEvent): boolean {
  return event.type === "activity_update" ||
    event.type === "queue_update" ||
    event.type === "session_update" ||
    event.type === "status" ||
    event.type === "turn_start" ||
    event.type === "text_delta" ||
    event.type === "tool_start" ||
    event.type === "tool_update" ||
    event.type === "tool_end" ||
    event.type === "todo_update" ||
    event.type === "turn_complete" ||
    event.type === "turn_error";
}

export function isPromptTerminalActivity(event: WebActivityEvent): boolean {
  return event.status === "completed" ||
    event.status === "failed" ||
    event.status === "aborted" ||
    event.type === "prompt_completed" ||
    event.type === "prompt_failed" ||
    event.type === "prompt_aborted";
}

export function isExternalSnapshotSuppressedByManagedAbort(
  snapshot: AgentExternalSnapshot | null | undefined,
  events: WebActivityEvent[],
): boolean {
  if (!snapshot?.activity.active || !snapshot.threadId) {
    return false;
  }
  const startedAtMs = snapshot.activity.startedAt?.getTime();
  if (typeof startedAtMs !== "number" || !Number.isFinite(startedAtMs)) {
    return false;
  }
  return events.some((event) => {
    if (event.type !== "prompt_aborted" || event.status !== "aborted") {
      return false;
    }
    if (event.source === "cli" || event.threadId !== snapshot.threadId) {
      return false;
    }
    if (event.agentId && event.agentId !== snapshot.agentId) {
      return false;
    }
    const eventAtMs = Date.parse(event.timestamp);
    return Number.isFinite(eventAtMs) && eventAtMs >= startedAtMs - 5_000;
  });
}

export function isSessionBusyWithExternalSnapshot(
  session: AgentSessionService,
  config: ConnectorConfig,
  activityForThread: (threadId: string) => WebActivityEvent[],
): boolean {
  if (session.isProcessing()) {
    return true;
  }
  const external = getExternalSnapshotForSession(session, config, { maxEvents: 0 });
  return Boolean(external?.activity.active && !isExternalSnapshotSuppressedByManagedAbort(external, activityForThread(external.threadId)));
}

export function taskToUnifiedJob(
  id: string,
  kind: UnifiedJobDto["kind"],
  title: string,
  task: WebTaskDto,
  options: Pick<UnifiedJobDto, "canCancel" | "canRetry" | "canReadLog">,
): UnifiedJobDto {
  return {
    id,
    kind,
    title,
    status: task.status,
    source: task.source,
    agentId: task.agentId,
    agentLabel: task.agentLabel,
    threadId: task.threadId,
    workspace: task.workspace,
    startedAt: task.startedAt,
    updatedAt: task.updatedAt,
    durationMs: task.durationMs,
    correlationId: task.correlationId,
    summary: task.prompt || task.detail,
    logTail: task.currentTool || task.lastTool ? `Current tool: ${task.currentTool ?? "-"}\nLast tool: ${task.lastTool ?? "-"}` : undefined,
    ...options,
  };
}

export function activityToUnifiedJob(
  event: WebActivityEvent,
  kind: UnifiedJobDto["kind"],
  title: string,
  options: Pick<UnifiedJobDto, "canCancel" | "canRetry" | "canReadLog">,
): UnifiedJobDto {
  return {
    id: `${kind}:${event.id}`,
    kind,
    title,
    status: event.status,
    source: event.source,
    agentId: event.agentId,
    threadId: event.threadId,
    workspace: event.workspace,
    owner: event.actor,
    startedAt: event.timestamp,
    updatedAt: event.timestamp,
    finishedAt: event.timestamp,
    durationMs: event.durationMs,
    correlationId: event.correlationId,
    summary: event.prompt || event.detail,
    logPath: event.detail,
    logTail: event.detail,
    ...options,
  };
}

export function promptActivityToUnifiedJob(event: WebActivityEvent): UnifiedJobDto {
  const status: UnifiedJobDto["status"] = event.status === "info" ? "completed" : event.status;
  const sourceLabel = event.source === "web"
    ? "WebUI"
    : event.source === "telegram"
      ? "Telegram"
      : event.source === "discord"
        ? "Discord"
        : event.source === "slack"
          ? "Slack"
          : "CLI";
  const promptKey = event.threadId ?? event.contextKey ?? event.id;
  return {
    id: `prompt:${event.source}:${promptKey}:${event.id}`,
    kind: event.source === "cli" ? "external-turn" : "web-turn",
    title: `${sourceLabel} prompt`,
    status,
    source: event.source,
    agentId: event.agentId,
    threadId: event.threadId,
    workspace: event.workspace,
    owner: event.actor,
    correlationId: event.correlationId,
    startedAt: event.timestamp,
    updatedAt: event.timestamp,
    finishedAt: status === "running" || status === "queued" ? undefined : event.timestamp,
    durationMs: event.durationMs,
    summary: event.prompt || event.detail,
    logTail: event.detail,
    canCancel: status === "running" && event.source === "web",
    canRetry: status !== "running",
    canReadLog: Boolean(event.detail || event.prompt),
  };
}

export function agentUpdateStatusToUnified(status: AgentUpdateJobSnapshot["status"]): UnifiedJobDto["status"] {
  if (status === "cancelled") return "aborted";
  if (status === "running") return "running";
  if (status === "completed") return "completed";
  return "failed";
}

export function dedupeJobs(jobs: UnifiedJobDto[]): UnifiedJobDto[] {
  const seen = new Set<string>();
  return jobs.filter((job) => {
    if (seen.has(job.id)) {
      return false;
    }
    seen.add(job.id);
    return true;
  });
}

export function normalizeMimeType(value: string | undefined, name: string): string {
  const configured = value?.trim();
  if (configured) {
    return configured;
  }
  const extension = path.extname(name).toLowerCase();
  if ([".jpg", ".jpeg"].includes(extension)) return "image/jpeg";
  if (extension === ".png") return "image/png";
  if (extension === ".gif") return "image/gif";
  if (extension === ".webp") return "image/webp";
  if (extension === ".mp3") return "audio/mpeg";
  if (extension === ".wav") return "audio/wav";
  if (extension === ".ogg" || extension === ".oga") return "audio/ogg";
  if (extension === ".m4a") return "audio/mp4";
  if (extension === ".webm") return "audio/webm";
  return "application/octet-stream";
}

export function uploadFileDtos(files: StagedFile[]): UploadPromptResult["files"] {
  return files.map((file) => ({
    name: file.safeName,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
  }));
}
