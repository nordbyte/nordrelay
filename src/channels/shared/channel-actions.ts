import type { AgentAdapterDescriptor } from "../../agents/shared/agent-adapter.js";
import type { AgentId } from "../../agents/shared/agent.js";
import { formatAgentFeatureSummaryHTML, formatAgentFeatureSummaryPlain } from "../../agents/shared/agent-feature-matrix.js";
import type { AgentUpdateJobSnapshot } from "../../agents/shared/agent-updates.js";
import { totalArtifactSize, type ArtifactTurnReport } from "../../artifacts/artifacts.js";
import type { ChannelDescriptor } from "./channel-adapter.js";
import { escapeHTML } from "../../core/format.js";
import { getAgentUpdateLogPath, getUpdateLogPath, type FormattedLogTail, type SelfUpdateResult } from "../../support/operations.js";
import type { QueuedPrompt } from "../../state/prompt-store.js";
import { formatFileSize } from "./session-format.js";

export interface ChannelActionButton {
  label: string;
  action: string;
}

export interface ChannelActionResponse {
  plain: string;
  html: string;
  buttons?: ChannelActionButton[][];
}

export type LogTarget = "connector" | "update" | "agent-updates" | "all";

export function renderChannelsAction(descriptors: ChannelDescriptor[]): ChannelActionResponse {
  const plain = [
    "Channel adapters:",
    ...descriptors.map((descriptor) => {
      const status = descriptor.status === "available"
        ? descriptor.enabled === false ? "available / disabled" : "available / enabled"
        : "planned";
      return `${descriptor.label}: ${status} · ${descriptor.capabilities.join(", ")}`;
    }),
  ].join("\n");
  const html = [
    "<b>Channel adapters:</b>",
    ...descriptors.map((descriptor) => {
      const statusIcon = descriptor.status === "available" ? "✅" : "🟡";
      const status = descriptor.status === "available"
        ? descriptor.enabled === false ? "available / disabled" : "available / enabled"
        : descriptor.status;
      const notes = descriptor.notes ? `\n  ${escapeHTML(descriptor.notes)}` : "";
      return `${statusIcon} <b>${escapeHTML(descriptor.label)}</b> <code>${escapeHTML(status)}</code>\n  <code>${escapeHTML(descriptor.capabilities.join(", "))}</code>${notes}`;
    }),
  ].join("\n");
  return { plain, html };
}

export function renderAgentsAction(descriptors: AgentAdapterDescriptor[], enabledAgents: AgentId[]): ChannelActionResponse {
  const enabled = new Set(enabledAgents);
  const plain = [
    "Agent adapters:",
    ...descriptors.flatMap((descriptor) => [
      `${descriptor.label}: ${descriptor.status}${descriptor.status === "available" ? ` · ${enabled.has(descriptor.id) ? "enabled" : "disabled"}` : ""}`,
      ...formatAgentFeatureSummaryPlain(descriptor.capabilities).map((line) => `  ${line}`),
    ]),
  ].join("\n");
  const html = [
    "<b>Agent adapters:</b>",
    ...descriptors.map((descriptor) => {
      const status = descriptor.status === "available" ? `${enabled.has(descriptor.id) ? "enabled" : "disabled"}` : "planned";
      const notes = descriptor.notes ? `\n  ${escapeHTML(descriptor.notes)}` : "";
      return [
        `${descriptor.status === "available" ? "✅" : "🟡"} <b>${escapeHTML(descriptor.label)}</b> <code>${escapeHTML(status)}</code>${notes}`,
        ...formatAgentFeatureSummaryHTML(descriptor.capabilities).map((line) => `  ${line}`),
      ].join("\n");
    }),
  ].join("\n");
  return { plain, html };
}

export function renderAgentUpdatePickerAction(descriptors: AgentAdapterDescriptor[]): ChannelActionResponse {
  const available = descriptors.filter((descriptor) => descriptor.status === "available");
  const buttons = available.map((descriptor) => [{ label: `Update ${descriptor.label}`, action: `agent-update:start:${descriptor.id}` }]);
  buttons.push([{ label: "Show update jobs", action: "agent-update:jobs" }]);
  return {
    plain: [
      "Agent updates:",
      ...available.map((descriptor) => `${descriptor.label}: /update ${descriptor.id}`),
      "",
      "Use /update install <agent> for missing CLIs and /update jobs to list running and recent agent updates.",
    ].join("\n"),
    html: [
      "<b>Agent updates:</b>",
      ...available.map((descriptor) => `<b>${escapeHTML(descriptor.label)}:</b> <code>/update ${escapeHTML(descriptor.id)}</code>`),
      "",
      "Use <code>/update install &lt;agent&gt;</code> for missing CLIs and <code>/update jobs</code> to list running and recent agent updates.",
    ].join("\n"),
    buttons,
  };
}

export function parseAgentUpdateId(value: string | undefined): AgentId | null {
  const normalized = value?.toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized === "claude") {
    return "claude-code";
  }
  return ["codex", "pi", "hermes", "openclaw", "claude-code"].includes(normalized)
    ? normalized as AgentId
    : null;
}

export function renderAgentUpdateJobsAction(jobs: AgentUpdateJobSnapshot[]): ChannelActionResponse {
  if (jobs.length === 0) {
    return {
      plain: "No agent update jobs yet. Use /update agents to start one.",
      html: "No agent update jobs yet. Use <code>/update agents</code> to start one.",
    };
  }
  const limited = jobs.slice(0, 10);
  return {
    plain: [
      "Agent update jobs:",
      ...limited.map((job) => `${job.id}: ${job.agentLabel} ${job.operation ?? "update"} · ${job.status} · ${formatLocalDateTime(new Date(job.updatedAt))}`),
      "",
      "Use /update log <id>, /update cancel <id>, or /update input <id> <text>.",
    ].join("\n"),
    html: [
      "<b>Agent update jobs:</b>",
      ...limited.map((job) => `<code>${escapeHTML(job.id)}</code> ${escapeHTML(job.agentLabel)} ${escapeHTML(job.operation ?? "update")} · <b>${escapeHTML(job.status)}</b> · <code>${escapeHTML(formatLocalDateTime(new Date(job.updatedAt)))}</code>`),
      "",
      "Use <code>/update log &lt;id&gt;</code>, <code>/update cancel &lt;id&gt;</code>, or <code>/update input &lt;id&gt; &lt;text&gt;</code>.",
    ].join("\n"),
  };
}

export function renderAgentUpdateJobAction(job: AgentUpdateJobSnapshot): ChannelActionResponse {
  const command = [job.command, ...job.args].join(" ");
  const inputLine = job.canInput
    ? `If the updater asks a question, reply with /update input ${job.id} <text>.`
    : "This update job is no longer accepting input.";
  const tail = trimLine(job.outputTail || "(waiting for output)", 1200);
  return {
    plain: [
      `${job.agentLabel} ${job.operation ?? "update"} ${job.status}.`,
      `ID: ${job.id}`,
      `Method: ${job.method}`,
      `Command: ${command}`,
      `Started: ${formatLocalDateTime(new Date(job.startedAt))}`,
      job.finishedAt ? `Finished: ${formatLocalDateTime(new Date(job.finishedAt))}` : undefined,
      job.error ? `Error: ${job.error}` : undefined,
      `Log: ${job.logPath}`,
      `Agent update log: ${getAgentUpdateLogPath()}`,
      inputLine,
      "",
      tail,
    ].filter(Boolean).join("\n"),
    html: [
      `<b>${escapeHTML(job.agentLabel)} ${escapeHTML(job.operation ?? "update")} ${escapeHTML(job.status)}.</b>`,
      `<b>ID:</b> <code>${escapeHTML(job.id)}</code>`,
      `<b>Method:</b> <code>${escapeHTML(job.method)}</code>`,
      `<b>Command:</b> <code>${escapeHTML(command)}</code>`,
      `<b>Started:</b> <code>${escapeHTML(formatLocalDateTime(new Date(job.startedAt)))}</code>`,
      job.finishedAt ? `<b>Finished:</b> <code>${escapeHTML(formatLocalDateTime(new Date(job.finishedAt)))}</code>` : undefined,
      job.error ? `<b>Error:</b> ${escapeHTML(job.error)}` : undefined,
      `<b>Log:</b> <code>${escapeHTML(job.logPath)}</code>`,
      `<b>Agent update log:</b> <code>${escapeHTML(getAgentUpdateLogPath())}</code>`,
      escapeHTML(inputLine),
      "",
      `<pre>${escapeHTML(tail)}</pre>`,
    ].filter(Boolean).join("\n"),
    buttons: [
      [
        { label: "Full log", action: `agent-update:log:${job.id}` },
        ...(job.canInput ? [{ label: "Cancel", action: `agent-update:cancel:${job.id}` }] : []),
      ],
    ],
  };
}

export function renderAgentUpdateLogAction(result: { job: AgentUpdateJobSnapshot; plain: string }): ChannelActionResponse {
  const tail = trimLine(result.plain || "(empty)", 3000);
  return {
    plain: [
      `${result.job.agentLabel} ${result.job.operation ?? "update"} log`,
      `ID: ${result.job.id}`,
      `Status: ${result.job.status}`,
      `File: ${result.job.logPath}`,
      "",
      tail,
    ].join("\n"),
    html: [
      `<b>${escapeHTML(result.job.agentLabel)} ${escapeHTML(result.job.operation ?? "update")} log</b>`,
      `<b>ID:</b> <code>${escapeHTML(result.job.id)}</code>`,
      `<b>Status:</b> <code>${escapeHTML(result.job.status)}</code>`,
      `<b>File:</b> <code>${escapeHTML(result.job.logPath)}</code>`,
      "",
      `<pre>${escapeHTML(tail)}</pre>`,
    ].join("\n"),
  };
}

export function renderSelfUpdateStartedAction(update: SelfUpdateResult): ChannelActionResponse {
  return {
    plain: [
      "Update started.",
      `Method: ${update.method}`,
      update.summary,
      `Source: ${update.sourceRoot}`,
      `Log: ${update.logPath}`,
      "Use /logs update after the restart or inspect update.log on the host.",
      "Use /update agents for agent CLI updates.",
    ].join("\n"),
    html: [
      "<b>Update started.</b>",
      `<b>Method:</b> <code>${escapeHTML(update.method)}</code>`,
      escapeHTML(update.summary),
      `<b>Source:</b> <code>${escapeHTML(update.sourceRoot)}</code>`,
      `<b>Log:</b> <code>${escapeHTML(update.logPath)}</code>`,
      `Use <code>/logs update</code> after the restart or inspect <code>${escapeHTML(getUpdateLogPath())}</code> on the host.`,
      "Use <code>/update agents</code> for agent CLI updates.",
    ].join("\n"),
  };
}

export function parseLogsCommand(argument: string): { target: LogTarget; lines: number } {
  const tokens = argument.split(/\s+/).filter(Boolean);
  let target: LogTarget = "connector";
  let lines = 80;

  for (const token of tokens) {
    const normalized = token.toLowerCase();
    if (normalized === "connector" || normalized === "main") {
      target = "connector";
      continue;
    }
    if (normalized === "update" || normalized === "self-update" || normalized === "self") {
      target = "update";
      continue;
    }
    if (normalized === "agent" || normalized === "agents" || normalized === "agent-update" || normalized === "agent-updates") {
      target = "agent-updates";
      continue;
    }
    if (normalized === "all") {
      target = "all";
      continue;
    }

    const parsedLines = Number.parseInt(token, 10);
    if (!Number.isNaN(parsedLines)) {
      lines = parsedLines;
    }
  }

  return { target, lines };
}

export function logTailRequests(target: LogTarget): Array<{ title: string; path?: string }> {
  if (target === "all") {
    return [
      { title: "Connector" },
      { title: "Update", path: getUpdateLogPath() },
      { title: "Agent updates", path: getAgentUpdateLogPath() },
    ];
  }
  return [{ title: logTargetTitle(target), path: logTargetPath(target) }];
}

export function renderLogTailsAction(logs: Array<{ title: string; tail: FormattedLogTail }>): ChannelActionResponse {
  return {
    plain: logs.map(({ title, tail }) => renderLogTailPlain(title, tail)).join("\n\n"),
    html: logs.map(({ title, tail }) => renderLogTailHTML(title, tail)).join("\n\n"),
  };
}

export function renderArtifactReportsAction(reports: ArtifactTurnReport[]): ChannelActionResponse {
  const lines = reports.slice(0, 5).map((report, index) => {
    const size = formatFileSize(totalArtifactSize(report.artifacts));
    const skipped = report.skippedCount > 0 ? `, ${report.skippedCount} skipped` : "";
    return `${index + 1}. ${report.turnId} · ${formatRelativeTime(report.updatedAt)} · ${report.artifacts.length} file${report.artifacts.length === 1 ? "" : "s"} · ${size}${skipped}`;
  });
  const usage = "Tap an action below, or use /artifacts latest, /artifacts zip latest, /artifacts images, /artifacts docs, /artifacts search <text>, or /artifacts delete <turn-id>.";
  return {
    plain: ["Recent artifacts:", ...lines, "", usage].join("\n"),
    html: ["<b>Recent artifacts:</b>", ...lines.map(escapeHTML), "", escapeHTML(usage)].join("\n"),
  };
}

export function renderArtifactUsageAction(usage: {
  managedBytes: number;
  referencedBytes: number;
  maxTotalBytes: number;
  usagePercent: number | null;
  warnPercent: number;
  status: string;
  indexedTurns: number;
  indexedFiles: number;
  skippedFiles: number;
  newestUpdatedAt?: string;
  largestTurn?: { turnId: string; sizeBytes: number };
}): ChannelActionResponse {
  const quota = usage.maxTotalBytes > 0
    ? `${formatFileSize(usage.managedBytes)} / ${formatFileSize(usage.maxTotalBytes)} (${Math.round(usage.usagePercent ?? 0)}%)`
    : `${formatFileSize(usage.managedBytes)} managed`;
  const lines = [
    "Artifact quota:",
    `Status: ${usage.status}`,
    `Quota: ${quota}`,
    `Referenced: ${formatFileSize(usage.referencedBytes)}`,
    `Turns: ${usage.indexedTurns}`,
    `Files: ${usage.indexedFiles}`,
    `Skipped: ${usage.skippedFiles}`,
    usage.newestUpdatedAt ? `Newest: ${formatRelativeTime(new Date(usage.newestUpdatedAt))}` : undefined,
    usage.largestTurn ? `Largest: ${usage.largestTurn.turnId} (${formatFileSize(usage.largestTurn.sizeBytes)})` : undefined,
  ].filter((line): line is string => Boolean(line));
  return {
    plain: lines.join("\n"),
    html: [
      "<b>Artifact quota:</b>",
      `<b>Status:</b> <code>${escapeHTML(usage.status)}</code>`,
      `<b>Quota:</b> <code>${escapeHTML(quota)}</code>`,
      `<b>Referenced:</b> <code>${escapeHTML(formatFileSize(usage.referencedBytes))}</code>`,
      `<b>Turns:</b> <code>${usage.indexedTurns}</code>`,
      `<b>Files:</b> <code>${usage.indexedFiles}</code>`,
      `<b>Skipped:</b> <code>${usage.skippedFiles}</code>`,
      usage.newestUpdatedAt ? `<b>Newest:</b> <code>${escapeHTML(formatRelativeTime(new Date(usage.newestUpdatedAt)))}</code>` : undefined,
      usage.largestTurn ? `<b>Largest:</b> <code>${escapeHTML(usage.largestTurn.turnId)}</code> (${escapeHTML(formatFileSize(usage.largestTurn.sizeBytes))})` : undefined,
    ].filter((line): line is string => Boolean(line)).join("\n"),
  };
}

export function renderArtifactCleanupAction(plan: {
  dryRun: boolean;
  candidates: Array<{ kind: string; id: string; sizeBytes: number; reasons: string[] }>;
  removedTurnDirs: number;
  removedInboxDirs: number;
  removedBytes: number;
}): ChannelActionResponse {
  const title = plan.dryRun ? "Artifact cleanup preview:" : "Artifact cleanup completed:";
  const candidates = plan.candidates.slice(0, 8).map((candidate) =>
    `${candidate.kind} ${candidate.id} · ${formatFileSize(candidate.sizeBytes)} · ${candidate.reasons.join(", ") || "cleanup"}`,
  );
  const lines = [
    title,
    `${plan.candidates.length} candidate(s), ${formatFileSize(plan.removedBytes)}, ${plan.removedTurnDirs} turn dirs, ${plan.removedInboxDirs} inbox dirs.`,
    ...candidates,
    plan.candidates.length > candidates.length ? `${plan.candidates.length - candidates.length} more not shown.` : undefined,
  ].filter((line): line is string => Boolean(line));
  return {
    plain: lines.join("\n"),
    html: [
      `<b>${escapeHTML(title)}</b>`,
      `<code>${plan.candidates.length}</code> candidate(s), <code>${escapeHTML(formatFileSize(plan.removedBytes))}</code>, <code>${plan.removedTurnDirs}</code> turn dirs, <code>${plan.removedInboxDirs}</code> inbox dirs.`,
      ...candidates.map(escapeHTML),
      plan.candidates.length > candidates.length ? escapeHTML(`${plan.candidates.length - candidates.length} more not shown.`) : undefined,
    ].filter((line): line is string => Boolean(line)).join("\n"),
  };
}

export function renderArtifactDeliveryAction(mode: string, scope = "user"): ChannelActionResponse {
  const usage = "Modes: manual-only, summary, summary-with-actions, auto-files, auto-zip, images-only, off.";
  return {
    plain: [`Artifact delivery for ${scope}: ${mode}`, usage, "Use /artifacts delivery <mode>."].join("\n"),
    html: [
      `<b>Artifact delivery for ${escapeHTML(scope)}:</b> <code>${escapeHTML(mode)}</code>`,
      escapeHTML(usage),
      "Use <code>/artifacts delivery &lt;mode&gt;</code>.",
    ].join("\n"),
  };
}

export function renderQueueListAction(queue: QueuedPrompt[], paused: boolean): ChannelActionResponse {
  if (queue.length === 0) {
    return {
      plain: paused ? "Queue is empty and paused." : "Queue is empty.",
      html: escapeHTML(paused ? "Queue is empty and paused." : "Queue is empty."),
    };
  }
  const lines = queue.map((item, index) => {
    const age = formatRelativeTime(new Date(item.createdAt));
    const attempts = item.attempts && item.attempts > 0 ? ` · attempts ${item.attempts}` : "";
    const error = item.lastError ? ` · last error: ${trimLine(item.lastError, 80)}` : "";
    const scheduled = item.notBefore && item.notBefore > Date.now()
      ? `scheduled ${formatLocalDateTime(new Date(item.notBefore))}`
      : index === 0 ? "next" : `after ${index} queued item${index === 1 ? "" : "s"}`;
    return `${index + 1}. ${item.id} · ${age} · ${scheduled}${attempts}${error} · ${item.description}`;
  });
  return {
    plain: [paused ? "Queued prompts (paused):" : "Queued prompts:", ...lines].join("\n"),
    html: [paused ? "<b>Queued prompts:</b> <code>paused</code>" : "<b>Queued prompts:</b>", ...lines.map(escapeHTML)].join("\n"),
  };
}

export function renderQueuedPromptDetailAction(item: QueuedPrompt): ChannelActionResponse {
  const lines = [
    "Queued prompt:",
    `ID: ${item.id}`,
    `Created: ${formatLocalDateTime(new Date(item.createdAt))}`,
    item.notBefore ? `Scheduled: ${formatLocalDateTime(new Date(item.notBefore))}` : undefined,
    `Attempts: ${item.attempts ?? 0}`,
    item.lastError ? `Last error: ${item.lastError}` : undefined,
    `Description: ${item.description}`,
  ].filter((line): line is string => Boolean(line));
  return {
    plain: lines.join("\n"),
    html: [
      "<b>Queued prompt:</b>",
      `<b>ID:</b> <code>${escapeHTML(item.id)}</code>`,
      `<b>Created:</b> <code>${escapeHTML(formatLocalDateTime(new Date(item.createdAt)))}</code>`,
      item.notBefore ? `<b>Scheduled:</b> <code>${escapeHTML(formatLocalDateTime(new Date(item.notBefore)))}</code>` : undefined,
      `<b>Attempts:</b> <code>${item.attempts ?? 0}</code>`,
      item.lastError ? `<b>Last error:</b> ${escapeHTML(item.lastError)}` : undefined,
      `<b>Description:</b> ${escapeHTML(item.description)}`,
    ].filter((line): line is string => Boolean(line)).join("\n"),
  };
}

function logTargetTitle(target: LogTarget): string {
  if (target === "update") {
    return "Update";
  }
  if (target === "agent-updates") {
    return "Agent updates";
  }
  return "Connector";
}

function logTargetPath(target: LogTarget): string | undefined {
  if (target === "update") {
    return getUpdateLogPath();
  }
  if (target === "agent-updates") {
    return getAgentUpdateLogPath();
  }
  return undefined;
}

function renderLogTailPlain(title: string, tail: FormattedLogTail): string {
  return [
    `${title} log tail`,
    `File: ${tail.filePath}`,
    `Updated: ${tail.updatedAt ? formatLocalDateTime(tail.updatedAt) : "-"}`,
    `Lines: ${tail.lineCount}/${tail.requestedLines}`,
    "",
    tail.plain || "(empty)",
  ].join("\n");
}

function renderLogTailHTML(title: string, tail: FormattedLogTail): string {
  const body = tail.plain
    ? tail.plain.split("\n").map(renderLogLineHTML).join("\n")
    : "<code>(empty)</code>";
  return [
    `<b>${escapeHTML(title)} log tail</b>`,
    `<b>File:</b> <code>${escapeHTML(tail.filePath)}</code>`,
    `<b>Updated:</b> <code>${escapeHTML(tail.updatedAt ? formatLocalDateTime(tail.updatedAt) : "-")}</code>`,
    `<b>Lines:</b> <code>${tail.lineCount}/${tail.requestedLines}</code>`,
    "",
    body,
  ].join("\n");
}

function renderLogLineHTML(line: string): string {
  const structured = line.match(/^(?<timestamp>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}|unknown time\s*)\s+(?<level>INFO|WARN|ERROR)\s+(?<message>.*)$/);
  if (structured?.groups) {
    const level = structured.groups.level;
    const levelHtml = level === "INFO" ? escapeHTML(level) : `<b>${escapeHTML(level)}</b>`;
    return [
      `<code>${escapeHTML(structured.groups.timestamp.trim())}</code>`,
      levelHtml,
      escapeHTML(structured.groups.message),
    ].join(" ");
  }

  return escapeHTML(line);
}

function formatLocalDateTime(date: Date): string {
  if (Number.isNaN(date.getTime())) {
    return "-";
  }
  return [
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`,
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`,
  ].join(" ");
}

function formatRelativeTime(date: Date): string {
  const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  return `${Math.round(hours / 24)}d ago`;
}

function trimLine(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, Math.max(0, maxLength - 3))}...` : normalized;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}
