import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { resolveCodexDir } from "./codex-home.js";
import {
  isCodexApprovalPolicy,
  isCodexSandboxMode,
  type CodexApprovalPolicy,
  type CodexSandboxMode,
} from "./codex-launch.js";
import type { AgentApprovalRequest } from "../shared/agent.js";

export interface CodexThreadRecord {
  id: string;
  title: string;
  cwd: string;
  model: string | null;
  reasoningEffort: string | null;
  sandboxMode: CodexSandboxMode | null;
  approvalPolicy: CodexApprovalPolicy | null;
  createdAt: Date;
  updatedAt: Date;
  firstUserMessage: string;
}

export interface CodexModelRecord {
  slug: string;
  displayName: string;
}

export interface CodexTokenUsageRecord {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

export interface CodexRateLimitWindow {
  usedPercent: number;
  remainingPercent: number;
  windowMinutes: number;
  resetsAt: Date | null;
}

export interface CodexRateLimitUsage {
  limitId: string | null;
  limitName: string | null;
  planType: string | null;
  primary: CodexRateLimitWindow | null;
  secondary: CodexRateLimitWindow | null;
}

export interface CodexSessionUsage {
  contextWindow: number | null;
  contextUsedPercent: number | null;
  lastTokenUsage: CodexTokenUsageRecord | null;
  totalTokenUsage: CodexTokenUsageRecord | null;
  rateLimits: CodexRateLimitUsage | null;
  updatedAt: Date | null;
}

export interface CodexThreadActivity {
  threadId: string;
  rolloutPath: string;
  active: boolean;
  stale: boolean;
  turnId: string | null;
  startedAt: Date | null;
  updatedAt: Date | null;
}

export type CodexApprovalRequest = AgentApprovalRequest;

export type CodexActivityEventKind = "task" | "user" | "agent" | "tool" | "approval";

export interface CodexActivityEvent {
  lineNumber: number;
  kind: CodexActivityEventKind;
  timestamp: Date | null;
  type: string;
  turnId: string | null;
  status: string | null;
  text: string | null;
  toolName: string | null;
  phase: string | null;
  approval?: CodexApprovalRequest;
}

export interface CodexRolloutSnapshot {
  threadId: string;
  rolloutPath: string;
  lineCount: number;
  activity: CodexThreadActivity;
  sandboxMode: CodexSandboxMode | null;
  approvalPolicy: CodexApprovalPolicy | null;
  events: CodexActivityEvent[];
  latestAgentMessage: string | null;
  latestUserMessage: string | null;
  latestToolName: string | null;
  pendingApprovals: CodexApprovalRequest[];
}

const ROLLOUT_CACHE_MAX_EVENTS = 200;
const USAGE_TAIL_INITIAL_BYTES = 1024 * 1024;
const USAGE_TAIL_MAX_BYTES = 16 * 1024 * 1024;
const WINDOWS_EXTENDED_PATH_PREFIX = "\\\\?\\";
const WINDOWS_EXTENDED_UNC_PREFIX = "\\\\?\\UNC\\";

type CachedRolloutSnapshot = {
  byteOffset: number;
  parsed: CodexRolloutSnapshot;
};

type CachedSessionUsage = {
  size: number;
  modifiedAtMs: number;
  parsed: CodexSessionUsage | null;
};

const rolloutSnapshotCache = new Map<string, CachedRolloutSnapshot>();
const sessionUsageCache = new Map<string, CachedSessionUsage>();

export const FALLBACK_MODELS: CodexModelRecord[] = [
  { slug: "gpt-5.5", displayName: "GPT-5.5" },
  { slug: "gpt-5.4", displayName: "GPT-5.4" },
  { slug: "gpt-5.4-mini", displayName: "GPT-5.4-Mini" },
  { slug: "gpt-5", displayName: "GPT-5" },
  { slug: "o4-mini", displayName: "o4-mini" },
  { slug: "o3", displayName: "o3" },
  { slug: "o3-mini", displayName: "o3-mini" },
  { slug: "gpt-4o", displayName: "GPT-4o" },
];

type DatabaseCtor = new (
  path: string,
  options?: { readonly?: boolean; fileMustExist?: boolean },
) => {
  prepare(sql: string): {
    all(...args: unknown[]): unknown[];
    get(...args: unknown[]): unknown;
  };
  close(): void;
};
type DatabaseInstance = InstanceType<DatabaseCtor>;
type ThreadRow = {
  id: unknown;
  title: unknown;
  cwd: unknown;
  model: unknown;
  reasoning_effort: unknown;
  sandbox_policy: unknown;
  approval_mode: unknown;
  created_at: unknown;
  updated_at: unknown;
  first_user_message: unknown;
};

type WorkspaceRow = {
  cwd: unknown;
};

type RolloutPathRow = {
  rollout_path: unknown;
};

const betterSqlite3Module = await import("better-sqlite3").catch(() => null);
const BetterSqlite3 = (
  (betterSqlite3Module as { default?: DatabaseCtor } | null)?.default ??
  (betterSqlite3Module as DatabaseCtor | null)
) as DatabaseCtor | null;

export function findLatestDatabase(): string | null {
  const codexDir = getCodexDir();
  if (!codexDir || !existsSync(codexDir)) {
    return null;
  }

  try {
    const candidates = readdirSync(codexDir)
      .filter((file) => /^state_.*\.sqlite$/i.test(file))
      .map((file) => {
        const fullPath = path.join(codexDir, file);
        return {
          path: fullPath,
          modifiedAtMs: statSync(fullPath).mtimeMs,
        };
      })
      .sort((left, right) => right.modifiedAtMs - left.modifiedAtMs);

    return candidates[0]?.path ?? null;
  } catch {
    return null;
  }
}

export function listThreads(limit = 20): CodexThreadRecord[] {
  return withDatabase((db) => {
    const query = db.prepare(`
      SELECT id, title, cwd, model, reasoning_effort, sandbox_policy, approval_mode, created_at, updated_at, first_user_message
      FROM threads
      WHERE (archived = 0 OR archived IS NULL)
      ORDER BY updated_at DESC
      LIMIT ?
    `);

    const rows = query.all(limit) as ThreadRow[];
    return rows.map(mapThreadRow);
  }) ?? [];
}

export function getThread(id: string): CodexThreadRecord | null {
  return (
    withDatabase((db) => {
      const query = db.prepare(`
        SELECT id, title, cwd, model, reasoning_effort, sandbox_policy, approval_mode, created_at, updated_at, first_user_message
        FROM threads
        WHERE archived = 0 AND id = ?
        LIMIT 1
      `);

      const row = query.get(id) as ThreadRow | undefined;
      return row ? mapThreadRow(row) : null;
    }) ?? null
  );
}

export function getThreadUsage(id: string): CodexSessionUsage | null {
  const rolloutPath = getThreadRolloutPath(id);
  if (!rolloutPath || !existsSync(rolloutPath)) {
    return null;
  }

  try {
    const stat = statSync(rolloutPath);
    const cached = sessionUsageCache.get(rolloutPath);
    if (cached && cached.size === stat.size && cached.modifiedAtMs === stat.mtimeMs) {
      return cached.parsed;
    }
    const parsed = parseUsageFromRolloutTail(rolloutPath, stat.size);
    sessionUsageCache.set(rolloutPath, {
      size: stat.size,
      modifiedAtMs: stat.mtimeMs,
      parsed,
    });
    return parsed;
  } catch {
    return null;
  }
}

export function getThreadActivity(
  id: string,
  options: { staleAfterMs?: number; nowMs?: number } = {},
): CodexThreadActivity | null {
  return getThreadRolloutSnapshot(id, { ...options, maxEvents: 0 })?.activity ?? null;
}

export function getThreadRolloutSnapshot(
  id: string,
  options: { staleAfterMs?: number; nowMs?: number; afterLine?: number; maxEvents?: number } = {},
): CodexRolloutSnapshot | null {
  const rolloutPath = getThreadRolloutPath(id);
  if (!rolloutPath || !existsSync(rolloutPath)) {
    return null;
  }

  try {
    const fileModifiedAtMs = statSync(rolloutPath).mtimeMs;
    const parsed = readCachedRolloutSnapshot(id, rolloutPath);
    return finalizeRolloutSnapshot(parsed, fileModifiedAtMs, options);
  } catch {
    return null;
  }
}

export function getThreadActivityLog(id: string, limit = 20): CodexActivityEvent[] {
  const snapshot = getThreadRolloutSnapshot(id, { maxEvents: limit });
  return snapshot?.events ?? [];
}

export function listWorkspaces(): string[] {
  return (
    withDatabase((db) => {
      const query = db.prepare(`
        SELECT DISTINCT cwd
        FROM threads
        WHERE (archived = 0 OR archived IS NULL) AND cwd IS NOT NULL AND cwd != ''
        ORDER BY cwd ASC
      `);

      const rows = query.all() as WorkspaceRow[];
      return Array.from(new Set(rows
        .map((row) => (typeof row.cwd === "string" ? normalizeCodexWorkspacePath(row.cwd) : ""))
        .filter(Boolean)))
        .sort();
    }) ?? []
  );
}

export function listModels(): CodexModelRecord[] {
  const modelsPath = getModelsCachePath();
  if (!modelsPath || !existsSync(modelsPath)) {
    return FALLBACK_MODELS;
  }

  try {
    const payload = JSON.parse(readFileSync(modelsPath, "utf8")) as {
      models?: Array<{ slug?: unknown; display_name?: unknown; visibility?: unknown }>;
    };

    const models = (payload.models ?? [])
      .filter((model) => model && typeof model === "object")
      .filter((model) => model.visibility !== "hidden")
      .map((model) => ({
        slug: typeof model.slug === "string" ? model.slug : "",
        displayName: typeof model.display_name === "string" ? model.display_name : "",
      }))
      .filter((model) => model.slug && model.displayName);

    return models.length > 0 ? models : FALLBACK_MODELS;
  } catch {
    return FALLBACK_MODELS;
  }
}

export function getThreadRolloutPath(id: string): string | null {
  return (
    withDatabase((db) => {
      const query = db.prepare(`
        SELECT rollout_path
        FROM threads
        WHERE archived = 0 AND id = ?
        LIMIT 1
      `);

      const row = query.get(id) as RolloutPathRow | undefined;
      return typeof row?.rollout_path === "string" && row.rollout_path.trim()
        ? row.rollout_path
        : null;
    }) ?? null
  );
}

function parseUsageFromRollout(contents: string): CodexSessionUsage | null {
  for (const line of iterateLinesReverse(contents)) {
    if (!line.includes('"token_count"')) {
      continue;
    }

    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    const payload = readObject(readObject(event)?.payload);
    if (payload?.type !== "token_count") {
      continue;
    }

    let updatedAt: Date | null = null;
    const timestamp = readString(readObject(event)?.timestamp);
    if (timestamp) {
      const parsedTimestamp = new Date(timestamp);
      if (!Number.isNaN(parsedTimestamp.getTime())) {
        updatedAt = parsedTimestamp;
      }
    }

    const info = readObject(payload.info);
    const totalTokenUsage = parseTokenUsage(readObject(info?.total_token_usage));
    const lastTokenUsage = parseTokenUsage(readObject(info?.last_token_usage));
    const parsedContextWindow = readNumber(info?.model_context_window);
    const contextWindow = parsedContextWindow !== null && parsedContextWindow > 0
      ? parsedContextWindow
      : null;
    const contextUsedPercent = lastTokenUsage && contextWindow
      ? Math.min(100, (lastTokenUsage.totalTokens / contextWindow) * 100)
      : null;
    const rateLimits = parseRateLimits(readObject(payload.rate_limits));
    if (!lastTokenUsage && !totalTokenUsage && !rateLimits) {
      continue;
    }

    return {
      contextWindow,
      contextUsedPercent,
      lastTokenUsage,
      totalTokenUsage,
      rateLimits,
      updatedAt,
    };
  }

  return null;
}

function parseUsageFromRolloutTail(rolloutPath: string, size: number): CodexSessionUsage | null {
  if (size <= USAGE_TAIL_INITIAL_BYTES) {
    return parseUsageFromRollout(readFileSync(rolloutPath, "utf8"));
  }

  let length = Math.min(size, USAGE_TAIL_INITIAL_BYTES);
  while (length < size && length <= USAGE_TAIL_MAX_BYTES) {
    const parsed = parseUsageFromRollout(readFileRangeUtf8(rolloutPath, size - length, length));
    if (parsed) {
      return parsed;
    }
    length = Math.min(size, length * 2);
  }

  if (length >= size) {
    return parseUsageFromRollout(readFileSync(rolloutPath, "utf8"));
  }

  return parseUsageFromRollout(readFileRangeUtf8(rolloutPath, size - USAGE_TAIL_MAX_BYTES, USAGE_TAIL_MAX_BYTES));
}

function readCachedRolloutSnapshot(threadId: string, rolloutPath: string): CodexRolloutSnapshot {
  const size = statSync(rolloutPath).size;
  const cached = rolloutSnapshotCache.get(rolloutPath);
  if (cached && size >= cached.byteOffset) {
    const suffix = size > cached.byteOffset
      ? readFileRangeUtf8(rolloutPath, cached.byteOffset, size - cached.byteOffset)
      : "";
    if (!suffix.trim()) {
      return cached.parsed;
    }

    const parsed = parseRolloutSnapshot(threadId, rolloutPath, suffix, {
      base: cached.parsed,
      maxEvents: ROLLOUT_CACHE_MAX_EVENTS,
    });
    rolloutSnapshotCache.set(rolloutPath, { byteOffset: size, parsed });
    return parsed;
  }

  const contents = readFileSync(rolloutPath, "utf8");
  const parsed = parseRolloutSnapshot(threadId, rolloutPath, contents, {
    maxEvents: ROLLOUT_CACHE_MAX_EVENTS,
  });
  rolloutSnapshotCache.set(rolloutPath, {
    byteOffset: Buffer.byteLength(contents),
    parsed,
  });
  return parsed;
}

function readFileRangeUtf8(filePath: string, position: number, length: number): string {
  if (length <= 0) {
    return "";
  }
  const fd = openSync(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(length);
    const bytesRead = readSync(fd, buffer, 0, length, position);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function* iterateLinesReverse(contents: string): Generator<string> {
  let end = contents.length;
  while (end > 0) {
    let start = contents.lastIndexOf("\n", end - 1);
    const lineStart = start === -1 ? 0 : start + 1;
    let line = contents.slice(lineStart, end);
    if (line.endsWith("\r")) {
      line = line.slice(0, -1);
    }
    if (line.trim()) {
      yield line;
    }
    if (start === -1) {
      break;
    }
    end = start;
  }
}

function parseRolloutSnapshot(
  threadId: string,
  rolloutPath: string,
  contents: string,
  options: { afterLine?: number; maxEvents?: number; base?: CodexRolloutSnapshot } = {},
): CodexRolloutSnapshot {
  let activeTurnId: string | null = options.base?.activity.active ? options.base.activity.turnId : null;
  let startedAt: Date | null = options.base?.activity.active ? options.base.activity.startedAt : null;
  let updatedAt: Date | null = options.base?.activity.updatedAt ?? null;
  let sandboxMode: CodexSandboxMode | null = options.base?.sandboxMode ?? null;
  let approvalPolicy: CodexApprovalPolicy | null = options.base?.approvalPolicy ?? null;
  let latestAgentMessage: string | null = options.base?.latestAgentMessage ?? null;
  let latestUserMessage: string | null = options.base?.latestUserMessage ?? null;
  let latestToolName: string | null = options.base?.latestToolName ?? null;
  const pendingApprovals = new Map<string, CodexApprovalRequest>(
    (options.base?.pendingApprovals ?? []).map((approval) => [approval.callId, approval]),
  );
  const events: CodexActivityEvent[] = [...(options.base?.events ?? [])];
  const lines = contents.split(/\r?\n/);
  const lineNumberOffset = options.base?.lineCount ?? 0;
  let lineCount = lineNumberOffset;
  const afterLine = options.afterLine ?? 0;
  const maxEvents = options.maxEvents ?? Number.POSITIVE_INFINITY;
  const pushEvent = (event: CodexActivityEvent): void => {
    if (maxEvents <= 0 || event.lineNumber <= afterLine) {
      return;
    }
    events.push(event);
    if (Number.isFinite(maxEvents) && events.length > maxEvents) {
      events.splice(0, events.length - maxEvents);
    }
  };

  for (const [index, line] of lines.entries()) {
    if (!line.trim()) {
      continue;
    }
    lineCount += 1;
    if (
      !line.includes('"task_') &&
      !line.includes('"turn_') &&
      !line.includes('"user_message"') &&
      !line.includes('"agent_message"') &&
      !line.includes('"function_call"') &&
      !activeTurnId
    ) {
      continue;
    }

    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    const eventObject = readObject(event);
    const payload = readObject(eventObject?.payload);
    const eventTimestamp = parseTimestamp(readString(eventObject?.timestamp));
    const lineNumber = lineNumberOffset + index + 1;
    if (activeTurnId && eventTimestamp) {
      updatedAt = eventTimestamp;
    }

    const type = readString(payload?.type) ?? readString(eventObject?.type);
    if (!type) {
      continue;
    }

    if (type === "turn_context") {
      sandboxMode = parseSandboxPolicy(payload?.sandbox_policy) ?? sandboxMode;
      approvalPolicy = parseApprovalMode(payload?.approval_policy) ?? approvalPolicy;
      continue;
    }

    if (type === "task_started") {
      activeTurnId = readString(payload?.turn_id);
      startedAt = parseUnixSeconds(readNumber(payload?.started_at)) ?? eventTimestamp;
      updatedAt = eventTimestamp ?? startedAt;
      pushEvent({
        lineNumber,
        kind: "task",
        timestamp: eventTimestamp,
        type,
        turnId: activeTurnId,
        status: "started",
        text: null,
        toolName: null,
        phase: null,
      });
      continue;
    }

    if (isTaskTerminalEvent(type)) {
      const turnId = readString(payload?.turn_id);
      pushEvent({
        lineNumber,
        kind: "task",
        timestamp: eventTimestamp,
        type,
        turnId,
        status: terminalStatusForEvent(type),
        text: readString(payload?.last_agent_message),
        toolName: null,
        phase: null,
      });
      if (!activeTurnId || !turnId || turnId === activeTurnId) {
        activeTurnId = null;
        startedAt = null;
        updatedAt = eventTimestamp ?? updatedAt;
        pendingApprovals.clear();
      }
      continue;
    }

    if (type === "user_message") {
      latestUserMessage = readString(payload?.message);
      pushEvent({
        lineNumber,
        kind: "user",
        timestamp: eventTimestamp,
        type,
        turnId: activeTurnId,
        status: null,
        text: latestUserMessage,
        toolName: null,
        phase: null,
      });
      continue;
    }

    if (type === "agent_message") {
      latestAgentMessage = readString(payload?.message);
      pushEvent({
        lineNumber,
        kind: "agent",
        timestamp: eventTimestamp,
        type,
        turnId: activeTurnId,
        status: null,
        text: latestAgentMessage,
        toolName: null,
        phase: readString(payload?.phase),
      });
      continue;
    }

    if (type === "function_call") {
      latestToolName = readString(payload?.name);
      const callId = readString(payload?.call_id);
      pushEvent({
        lineNumber,
        kind: "tool",
        timestamp: eventTimestamp,
        type,
        turnId: activeTurnId,
        status: "started",
        text: null,
        toolName: latestToolName,
        phase: null,
      });
      const approval = parseFunctionCallApproval({
        threadId,
        rolloutPath,
        lineNumber,
        turnId: activeTurnId,
        timestamp: eventTimestamp,
        callId,
        toolName: latestToolName,
        rawArguments: readString(payload?.arguments),
      });
      if (approval) {
        pendingApprovals.set(approval.callId, approval);
        pushEvent({
          lineNumber,
          kind: "approval",
          timestamp: eventTimestamp,
          type,
          turnId: activeTurnId,
          status: "pending",
          text: approval.command,
          toolName: approval.toolName,
          phase: null,
          approval,
        });
      }
      continue;
    }

    if (type === "function_call_output") {
      const callId = readString(payload?.call_id);
      const approval = callId ? pendingApprovals.get(callId) : undefined;
      if (callId) {
        pendingApprovals.delete(callId);
      }
      pushEvent({
        lineNumber,
        kind: "tool",
        timestamp: eventTimestamp,
        type,
        turnId: activeTurnId,
        status: "finished",
        text: null,
        toolName: approval?.toolName ?? null,
        phase: null,
      });
    }
  }

  return {
    threadId,
    rolloutPath,
    lineCount,
    activity: {
      threadId,
      rolloutPath,
      active: Boolean(activeTurnId),
      stale: false,
      turnId: activeTurnId,
      startedAt,
      updatedAt,
    },
    sandboxMode,
    approvalPolicy,
    events,
    latestAgentMessage,
    latestUserMessage,
    latestToolName,
    pendingApprovals: [...pendingApprovals.values()],
  };
}

function parseFunctionCallApproval(input: {
  threadId: string;
  rolloutPath: string;
  lineNumber: number;
  turnId: string | null;
  timestamp: Date | null;
  callId: string | null;
  toolName: string | null;
  rawArguments: string | null;
}): CodexApprovalRequest | null {
  if (!input.callId || !input.rawArguments) {
    return null;
  }

  let args: Record<string, unknown> | null = null;
  try {
    args = readObject(JSON.parse(input.rawArguments));
  } catch {
    args = null;
  }
  if (!args) {
    return null;
  }

  const sandboxPermissions = readString(args.sandbox_permissions);
  if (sandboxPermissions !== "require_escalated") {
    return null;
  }

  const command = readString(args.cmd) ?? readString(args.command);
  if (!command?.trim()) {
    return null;
  }

  const prefixRule = Array.isArray(args.prefix_rule)
    ? args.prefix_rule.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];

  return {
    id: createApprovalId(input.threadId, input.rolloutPath, input.callId, input.lineNumber),
    callId: input.callId,
    toolName: input.toolName ?? "tool",
    command,
    workdir: readString(args.workdir),
    reason: readString(args.justification) ?? readString(args.reason),
    prefixRule,
    sandboxPermissions,
    lineNumber: input.lineNumber,
    turnId: input.turnId,
    requestedAt: input.timestamp,
    sourcePath: input.rolloutPath,
  };
}

function createApprovalId(threadId: string, rolloutPath: string, callId: string, lineNumber: number): string {
  return createHash("sha256")
    .update(threadId)
    .update("\0")
    .update(rolloutPath)
    .update("\0")
    .update(callId)
    .update("\0")
    .update(String(lineNumber))
    .digest("hex")
    .slice(0, 12);
}

function finalizeRolloutSnapshot(
  snapshot: CodexRolloutSnapshot,
  fileModifiedAtMs: number,
  options: { staleAfterMs?: number; nowMs?: number; afterLine?: number; maxEvents?: number },
): CodexRolloutSnapshot {
  const updatedAtMs = Math.max(snapshot.activity.updatedAt?.getTime() ?? 0, fileModifiedAtMs);
  const updatedAt = updatedAtMs > 0 ? new Date(updatedAtMs) : snapshot.activity.updatedAt;
  const staleAfterMs = options.staleAfterMs ?? 5 * 60 * 1000;
  const nowMs = options.nowMs ?? Date.now();
  const stale = Boolean(
    snapshot.activity.active &&
      updatedAt &&
      staleAfterMs > 0 &&
      nowMs - updatedAt.getTime() > staleAfterMs,
  );
  const afterLine = options.afterLine ?? 0;
  const maxEvents = options.maxEvents ?? Number.POSITIVE_INFINITY;
  const filteredEvents = snapshot.events.filter((event) => event.lineNumber > afterLine);
  const events = maxEvents <= 0 ? [] : filteredEvents.slice(-maxEvents);
  const hasPendingApprovals = snapshot.pendingApprovals.length > 0;

  return {
    ...snapshot,
    activity: {
      ...snapshot.activity,
      updatedAt,
      stale: hasPendingApprovals ? false : stale,
      active: snapshot.activity.active && (hasPendingApprovals || !stale),
    },
    events,
  };
}

function isTaskTerminalEvent(type: string): boolean {
  return [
    "task_complete",
    "task_failed",
    "task_error",
    "turn_aborted",
    "turn_complete",
    "turn_failed",
    "turn_error",
  ].includes(type);
}

function terminalStatusForEvent(type: string): string {
  if (type.includes("abort")) {
    return "aborted";
  }
  if (type.includes("fail") || type.includes("error")) {
    return "failed";
  }
  return "completed";
}

function parseTokenUsage(value: Record<string, unknown> | null): CodexTokenUsageRecord | null {
  if (!value) {
    return null;
  }

  const inputTokens = readNumber(value.input_tokens);
  const cachedInputTokens = readNumber(value.cached_input_tokens);
  const outputTokens = readNumber(value.output_tokens);
  const reasoningOutputTokens = readNumber(value.reasoning_output_tokens);
  const totalTokens = readNumber(value.total_tokens);
  if (
    inputTokens === null ||
    cachedInputTokens === null ||
    outputTokens === null ||
    reasoningOutputTokens === null ||
    totalTokens === null
  ) {
    return null;
  }

  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens,
  };
}

function parseRateLimits(value: Record<string, unknown> | null): CodexRateLimitUsage | null {
  if (!value) {
    return null;
  }

  return {
    limitId: readString(value.limit_id),
    limitName: readString(value.limit_name),
    planType: readString(value.plan_type),
    primary: parseRateLimitWindow(readObject(value.primary)),
    secondary: parseRateLimitWindow(readObject(value.secondary)),
  };
}

function parseRateLimitWindow(value: Record<string, unknown> | null): CodexRateLimitWindow | null {
  if (!value) {
    return null;
  }

  const usedPercent = readNumber(value.used_percent);
  const windowMinutes = readNumber(value.window_minutes);
  if (usedPercent === null || windowMinutes === null) {
    return null;
  }

  const resetSeconds = readNumber(value.resets_at);
  return {
    usedPercent,
    remainingPercent: Math.max(0, 100 - usedPercent),
    windowMinutes,
    resetsAt: resetSeconds === null ? null : new Date(resetSeconds * 1000),
  };
}

function mapThreadRow(row: ThreadRow): CodexThreadRecord {
  return {
    id: typeof row.id === "string" ? row.id : String(row.id ?? ""),
    title: typeof row.title === "string" ? row.title : "",
    cwd: typeof row.cwd === "string" ? normalizeCodexWorkspacePath(row.cwd) : "",
    model: typeof row.model === "string" ? row.model : null,
    reasoningEffort: typeof row.reasoning_effort === "string" ? row.reasoning_effort : null,
    sandboxMode: parseSandboxPolicy(row.sandbox_policy),
    approvalPolicy: parseApprovalMode(row.approval_mode),
    createdAt: fromUnixSeconds(row.created_at),
    updatedAt: fromUnixSeconds(row.updated_at),
    firstUserMessage: typeof row.first_user_message === "string" ? row.first_user_message : "",
  };
}

function normalizeCodexWorkspacePath(value: string): string {
  if (value.startsWith(WINDOWS_EXTENDED_UNC_PREFIX)) {
    return `\\\\${value.slice(WINDOWS_EXTENDED_UNC_PREFIX.length)}`;
  }
  if (value.startsWith(WINDOWS_EXTENDED_PATH_PREFIX)) {
    return value.slice(WINDOWS_EXTENDED_PATH_PREFIX.length);
  }
  return value;
}

function parseApprovalMode(value: unknown): CodexApprovalPolicy | null {
  return typeof value === "string" && isCodexApprovalPolicy(value) ? value : null;
}

function parseSandboxPolicy(value: unknown): CodexSandboxMode | null {
  const objectValue = readObject(value);
  if (objectValue) {
    const type = readString(objectValue.type);
    return type && isCodexSandboxMode(type) ? type : null;
  }

  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  if (isCodexSandboxMode(value)) {
    return value;
  }

  try {
    const parsed = JSON.parse(value) as { type?: unknown };
    return typeof parsed.type === "string" && isCodexSandboxMode(parsed.type) ? parsed.type : null;
  } catch {
    return null;
  }
}

function fromUnixSeconds(value: unknown): Date {
  return typeof value === "number" ? new Date(value * 1000) : new Date(0);
}

function parseUnixSeconds(value: number | null): Date | null {
  return value === null ? null : new Date(value * 1000);
}

function parseTimestamp(value: string | null): Date | null {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function readObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function withDatabase<T>(fn: (db: DatabaseInstance) => T): T | null {
  if (!BetterSqlite3) {
    return null;
  }

  const databasePath = findLatestDatabase();
  if (!databasePath) {
    return null;
  }

  let db: DatabaseInstance | null = null;
  try {
    db = new BetterSqlite3(databasePath, { readonly: true, fileMustExist: true });
    return fn(db);
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // Ignore close failures.
    }
  }
}

function getCodexDir(): string | null {
  return resolveCodexDir();
}

function getModelsCachePath(): string | null {
  const codexDir = getCodexDir();
  return codexDir ? path.join(codexDir, "models_cache.json") : null;
}
