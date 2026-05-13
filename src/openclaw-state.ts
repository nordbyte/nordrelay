import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

import type {
  AgentActivityEvent,
  AgentExternalActivity,
  AgentExternalSnapshot,
  AgentSessionUsage,
  AgentThreadRecord,
} from "./agent.js";

export interface OpenClawStateOptions {
  cliPath?: string;
  openClawHome?: string;
  stateDir?: string;
  workspace?: string;
  openClawAgentId?: string;
  staleAfterMs?: number;
  nowMs?: number;
  sessionsJson?: unknown;
}

export interface OpenClawSessionRecord extends AgentThreadRecord {
  agentId: "openclaw";
  openClawAgentId: string | null;
  sessionPath?: string;
  sessionKey: string;
  status: string | null;
  active: boolean;
  usage?: AgentSessionUsage;
  raw?: unknown;
}

export interface OpenClawSessionDiagnostics {
  sourcePath: string;
  status: "active" | "stale" | "idle" | "unavailable";
  reason: string;
  lineCount: number;
  updatedAt: Date | null;
}

export function getDefaultOpenClawHome(): string {
  return path.join(os.homedir(), ".openclaw");
}

export function resolveOpenClawStateDir(options: OpenClawStateOptions = {}): string {
  return options.stateDir
    ?? process.env.OPENCLAW_STATE_DIR
    ?? options.openClawHome
    ?? process.env.OPENCLAW_HOME
    ?? getDefaultOpenClawHome();
}

export function listOpenClawSessions(
  limit = 20,
  options: OpenClawStateOptions = {},
): OpenClawSessionRecord[] {
  const payload = options.sessionsJson ?? readOpenClawSessionsJson(limit, options);
  return parseOpenClawSessionsPayload(payload, options)
    .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime())
    .slice(0, Math.max(1, limit));
}

export function getOpenClawSession(
  id: string,
  options: OpenClawStateOptions = {},
): OpenClawSessionRecord | null {
  const normalized = id.trim();
  if (!normalized) {
    return null;
  }
  const sessions = listOpenClawSessions(500, options);
  return sessions.find((record) => record.id === normalized || record.sessionKey === normalized)
    ?? sessions.find((record) => record.id.startsWith(normalized) || record.sessionKey.startsWith(normalized))
    ?? null;
}

export function listOpenClawWorkspaces(options: OpenClawStateOptions = {}): string[] {
  const workspaces = new Set<string>();
  for (const record of listOpenClawSessions(500, options)) {
    if (record.cwd) {
      workspaces.add(record.cwd);
    }
  }
  if (options.workspace) {
    workspaces.add(options.workspace);
  }
  return [...workspaces].sort((left, right) => left.localeCompare(right));
}

export function getOpenClawSessionActivity(
  id: string,
  options: OpenClawStateOptions = {},
): AgentExternalActivity | null {
  return getOpenClawSessionSnapshot(id, { ...options, maxEvents: 0 })?.activity ?? null;
}

export function getOpenClawSessionActivityLog(
  id: string,
  limit = 50,
  options: OpenClawStateOptions = {},
): AgentActivityEvent[] {
  return getOpenClawSessionSnapshot(id, { ...options, maxEvents: Math.max(1, limit) })?.events ?? [];
}

export function getOpenClawSessionSnapshot(
  id: string,
  options: OpenClawStateOptions & { afterLine?: number; maxEvents?: number } = {},
): AgentExternalSnapshot | null {
  const record = getOpenClawSession(id, options);
  if (!record) {
    return null;
  }
  const events = parseOpenClawActivityEvents(record, options.afterLine ?? 0);
  const latestUser = [...events].reverse().find((event) => event.kind === "user");
  const latestAgent = [...events].reverse().find((event) => event.kind === "agent");
  const latestTerminal = [...events].reverse().find((event) => event.kind === "task" && event.status && event.status !== "started");
  const latestTool = [...events].reverse().find((event) => event.kind === "tool" && event.toolName);
  const latestTimestamp = events.at(-1)?.timestamp ?? record.updatedAt;
  const staleAfterMs = options.staleAfterMs ?? 5 * 60 * 1000;
  const nowMs = options.nowMs ?? Date.now();
  const stale = Boolean(record.active && latestTimestamp && nowMs - latestTimestamp.getTime() > staleAfterMs);
  const maxEvents = options.maxEvents ?? 50;
  const lineCount = Math.max(events.length, record.active ? 1 : 0);
  const returnedEvents = maxEvents <= 0 ? [] : events.slice(-maxEvents);

  return {
    agentId: "openclaw",
    agentLabel: "OpenClaw",
    threadId: record.id,
    sourcePath: record.sessionPath ?? sourcePath(options),
    sourceLabel: "OpenClaw sessions",
    lineCount,
    activity: {
      agentId: "openclaw",
      agentLabel: "OpenClaw",
      threadId: record.id,
      sourcePath: record.sessionPath ?? sourcePath(options),
      sourceLabel: "OpenClaw sessions",
      active: record.active && !stale,
      stale,
      turnId: latestUser?.turnId ?? latestTerminal?.turnId ?? record.id,
      startedAt: latestUser?.timestamp ?? (record.active ? record.updatedAt : null),
      updatedAt: latestTimestamp,
    },
    events: returnedEvents,
    latestAgentMessage: latestAgent?.text ?? null,
    latestUserMessage: latestUser?.text ?? record.firstUserMessage,
    latestToolName: latestTool?.toolName ?? null,
  };
}

export function getOpenClawSessionDiagnostics(
  id: string | null | undefined,
  options: OpenClawStateOptions = {},
): OpenClawSessionDiagnostics {
  const source = sourcePath(options);
  if (!id) {
    return {
      sourcePath: source,
      status: "unavailable",
      reason: "no active OpenClaw session",
      lineCount: 0,
      updatedAt: null,
    };
  }
  const snapshot = getOpenClawSessionSnapshot(id, { ...options, maxEvents: 0 });
  if (!snapshot) {
    return {
      sourcePath: source,
      status: "unavailable",
      reason: "OpenClaw session not found",
      lineCount: 0,
      updatedAt: null,
    };
  }
  const status = snapshot.activity.active ? "active" : snapshot.activity.stale ? "stale" : "idle";
  const reason = snapshot.activity.active
    ? "OpenClaw session reports an active run"
    : snapshot.activity.stale
      ? "OpenClaw active run exceeded stale timeout"
      : "OpenClaw session is idle";
  return {
    sourcePath: snapshot.sourcePath,
    status,
    reason,
    lineCount: snapshot.lineCount,
    updatedAt: snapshot.activity.updatedAt,
  };
}

export function parseOpenClawSessionsPayload(payload: unknown, options: OpenClawStateOptions = {}): OpenClawSessionRecord[] {
  const root = objectValue(payload);
  const storePaths = new Map<string, string>();
  for (const store of arrayValue(root?.stores)) {
    const storeObject = objectValue(store);
    const agentId = stringValue(storeObject?.agentId) ?? stringValue(storeObject?.agent_id);
    const storePath = stringValue(storeObject?.path) ?? stringValue(storeObject?.storePath);
    if (agentId && storePath) {
      storePaths.set(agentId, storePath);
    }
  }
  const sessions = arrayValue(root?.sessions ?? payload);
  return sessions
    .map((entry) => mapOpenClawSession(entry, options, storePaths))
    .filter((record): record is OpenClawSessionRecord => Boolean(record));
}

function readOpenClawSessionsJson(limit: number, options: OpenClawStateOptions): unknown {
  const cliPath = options.cliPath ?? process.env.OPENCLAW_CLI_PATH ?? "openclaw";
  const args = ["sessions", "--all-agents", "--limit", String(Math.max(1, limit)), "--json"];
  const result = spawnSync(cliPath, args, {
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
    env: process.env,
  });
  if (result.error || result.status !== 0) {
    return { sessions: [] };
  }
  try {
    return JSON.parse(result.stdout.trim() || "{}") as unknown;
  } catch {
    return { sessions: [] };
  }
}

function mapOpenClawSession(
  raw: unknown,
  options: OpenClawStateOptions,
  storePaths: Map<string, string>,
): OpenClawSessionRecord | null {
  const object = objectValue(raw);
  if (!object) {
    return null;
  }
  const key = stringValue(object.key)
    ?? stringValue(object.sessionKey)
    ?? stringValue(object.session_key)
    ?? stringValue(object.id)
    ?? stringValue(object.sessionId)
    ?? stringValue(object.session_id);
  if (!key) {
    return null;
  }
  const id = stringValue(object.id)
    ?? stringValue(object.sessionId)
    ?? stringValue(object.session_id)
    ?? key;
  const openClawAgentId = stringValue(object.agentId)
    ?? stringValue(object.agent_id)
    ?? parseAgentFromSessionKey(key)
    ?? options.openClawAgentId
    ?? null;
  const sessionPath = stringValue(object.path)
    ?? stringValue(object.storePath)
    ?? stringValue(object.store_path)
    ?? (openClawAgentId ? storePaths.get(openClawAgentId) : undefined);
  const workspace = stringValue(object.workspace)
    ?? stringValue(object.cwd)
    ?? workspaceFromSource(stringValue(object.source))
    ?? options.workspace
    ?? process.cwd();
  const createdAt = dateValue(object.createdAt)
    ?? dateValue(object.created_at)
    ?? dateValue(object.startedAt)
    ?? dateValue(object.started_at)
    ?? new Date();
  const updatedAt = dateValue(object.updatedAt)
    ?? dateValue(object.updated_at)
    ?? dateValue(object.lastActive)
    ?? dateValue(object.last_active)
    ?? dateValue(object.endedAt)
    ?? dateValue(object.ended_at)
    ?? createdAt;
  const firstUserMessage = stringValue(object.firstUserMessage)
    ?? stringValue(object.first_user_message)
    ?? firstMessageText(object);
  const status = stringValue(object.status);
  const active = booleanValue(object.active)
    ?? booleanValue(object.running)
    ?? booleanValue(object.inProgress)
    ?? booleanValue(object.in_progress)
    ?? booleanValue(object.isRunning)
    ?? statusIsActive(status);

  return {
    id,
    sessionKey: key,
    title: stringValue(object.title),
    cwd: workspace,
    model: stringValue(object.model),
    reasoningEffort: stringValue(object.thinking)
      ?? stringValue(object.thinkingLevel)
      ?? stringValue(object.thinking_level)
      ?? stringValue(object.reasoningEffort)
      ?? stringValue(object.reasoning_effort),
    createdAt,
    updatedAt,
    firstUserMessage,
    agentId: "openclaw",
    sessionPath,
    openClawAgentId,
    status,
    active,
    usage: usageFromSession(object),
    raw,
  };
}

function parseOpenClawActivityEvents(record: OpenClawSessionRecord, afterLine: number): AgentActivityEvent[] {
  const raw = objectValue(record.raw);
  const sourceEvents = arrayValue(raw?.events ?? raw?.messages ?? raw?.turns ?? raw?.transcript);
  const events: AgentActivityEvent[] = [];
  let lineNumber = 0;
  if (record.active) {
    lineNumber += 1;
    events.push({
      lineNumber,
      kind: "task",
      timestamp: record.updatedAt,
      type: "run",
      turnId: record.id,
      status: "started",
      text: record.status,
      toolName: null,
      phase: null,
    });
  }
  for (const event of sourceEvents) {
    const object = objectValue(event);
    if (!object) continue;
    lineNumber += 1;
    const parsed = mapActivityObject(object, lineNumber, record.id);
    if (parsed) events.push(parsed);
  }
  if (!record.active && events.some((event) => event.kind === "user") && !events.some((event) => event.kind === "task" && event.status !== "started")) {
    lineNumber += 1;
    events.push({
      lineNumber,
      kind: "task",
      timestamp: record.updatedAt,
      type: "run",
      turnId: record.id,
      status: statusIsFailure(record.status) ? "failed" : "completed",
      text: record.status,
      toolName: null,
      phase: null,
    });
  }
  if (events.length === 0 && record.firstUserMessage) {
    events.push({
      lineNumber: 1,
      kind: "user",
      timestamp: record.createdAt,
      type: "message",
      turnId: record.id,
      status: null,
      text: record.firstUserMessage,
      toolName: null,
      phase: null,
    });
  }
  return events.filter((event) => event.lineNumber > afterLine);
}

function mapActivityObject(object: Record<string, unknown>, lineNumber: number, fallbackTurnId: string): AgentActivityEvent | null {
  const role = stringValue(object.role)?.toLowerCase();
  const type = stringValue(object.type) ?? stringValue(object.event) ?? role ?? "message";
  const status = stringValue(object.status);
  const timestamp = dateValue(object.timestamp) ?? dateValue(object.createdAt) ?? dateValue(object.created_at);
  const text = stringValue(object.text)
    ?? stringValue(object.content)
    ?? stringValue(object.message)
    ?? stringValue(object.summary);
  const toolName = stringValue(object.toolName)
    ?? stringValue(object.tool_name)
    ?? stringValue(object.name)
    ?? stringValue(object.tool);
  const turnId = stringValue(object.turnId) ?? stringValue(object.turn_id) ?? stringValue(object.runId) ?? fallbackTurnId;

  if (role === "user") {
    return { lineNumber, kind: "user", timestamp, type, turnId, status, text, toolName: null, phase: null };
  }
  if (role === "assistant" || role === "agent") {
    return { lineNumber, kind: "agent", timestamp, type, turnId, status, text, toolName: null, phase: stringValue(object.phase) };
  }
  if (role === "tool" || toolName || type.includes("tool")) {
    return {
      lineNumber,
      kind: "tool",
      timestamp,
      type,
      turnId,
      status: status === "completed" ? "finished" : status ?? (type.includes("start") ? "started" : "finished"),
      text,
      toolName: toolName ?? "tool",
      phase: null,
    };
  }
  if (type.includes("run") || type.includes("task")) {
    return { lineNumber, kind: "task", timestamp, type, turnId, status, text, toolName: null, phase: null };
  }
  return text ? { lineNumber, kind: "agent", timestamp, type, turnId, status, text, toolName: null, phase: null } : null;
}

function sourcePath(options: OpenClawStateOptions): string {
  return path.join(resolveOpenClawStateDir(options), "sessions");
}

function parseAgentFromSessionKey(key: string): string | null {
  const match = key.match(/^agent:([^:]+):/);
  return match?.[1] ?? null;
}

function workspaceFromSource(source: string | null): string | null {
  if (!source) return null;
  if (path.isAbsolute(source)) return source;
  const match = source.match(/(?:cwd|workspace)=([^,;]+)/i);
  return match && path.isAbsolute(match[1]!) ? match[1]! : null;
}

function firstMessageText(object: Record<string, unknown>): string | null {
  for (const entry of arrayValue(object.messages ?? object.transcript ?? object.events)) {
    const row = objectValue(entry);
    if (stringValue(row?.role)?.toLowerCase() === "user") {
      return stringValue(row?.text) ?? stringValue(row?.content) ?? stringValue(row?.message);
    }
  }
  return null;
}

function usageFromSession(object: Record<string, unknown>): AgentSessionUsage | undefined {
  const usage = objectValue(object.usage) ?? object;
  const input = numberValue(usage.input) ?? numberValue(usage.inputTokens) ?? numberValue(usage.input_tokens) ?? 0;
  const output = numberValue(usage.output) ?? numberValue(usage.outputTokens) ?? numberValue(usage.output_tokens) ?? 0;
  const cacheRead = numberValue(usage.cacheRead) ?? numberValue(usage.cache_read_tokens) ?? 0;
  const cacheWrite = numberValue(usage.cacheWrite) ?? numberValue(usage.cache_write_tokens) ?? 0;
  const total = input + output + cacheRead + cacheWrite;
  if (total <= 0) {
    return undefined;
  }
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total,
    cost: numberValue(usage.cost) ?? numberValue(usage.estimated_cost_usd) ?? undefined,
  };
}

function statusIsActive(status: string | null): boolean {
  return Boolean(status && /^(active|running|processing|queued|pending|accepted)$/i.test(status));
}

function statusIsFailure(status: string | null): boolean {
  return Boolean(status && /^(failed|error)$/i.test(status));
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function dateValue(value: unknown): Date | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value > 10_000_000_000 ? value : value * 1000);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}
