import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  AgentActivityEvent,
  AgentExternalActivity,
  AgentExternalSnapshot,
  AgentSessionUsage,
  AgentThreadRecord,
} from "./agent.js";

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

type HermesSessionRow = {
  id: unknown;
  source: unknown;
  title: unknown;
  model: unknown;
  model_config: unknown;
  started_at: unknown;
  ended_at: unknown;
  message_count: unknown;
  input_tokens: unknown;
  output_tokens: unknown;
  cache_read_tokens: unknown;
  cache_write_tokens: unknown;
  reasoning_tokens: unknown;
  estimated_cost_usd: unknown;
  actual_cost_usd: unknown;
  first_user_message: unknown;
  last_active: unknown;
};

type HermesMessageRow = {
  id: unknown;
  role: unknown;
  content: unknown;
  tool_name: unknown;
  timestamp: unknown;
  token_count: unknown;
  reasoning: unknown;
  reasoning_content: unknown;
};

export interface HermesStateOptions {
  hermesHome?: string;
  stateDbPath?: string;
  workspace?: string;
}

export interface HermesSessionRecord extends AgentThreadRecord {
  agentId: "hermes";
  source: string;
  sessionPath: string;
  messageCount: number;
  endedAt: Date | null;
  usage?: AgentSessionUsage;
}

export interface HermesSessionDiagnostics {
  stateDbPath: string;
  status: "active" | "stale" | "idle" | "unavailable";
  reason: string;
  lineCount: number;
  updatedAt: Date | null;
}

const betterSqlite3Module = await import("better-sqlite3").catch(() => null);
const BetterSqlite3 = (
  (betterSqlite3Module as { default?: DatabaseCtor } | null)?.default ??
  (betterSqlite3Module as DatabaseCtor | null)
) as DatabaseCtor | null;

export function getDefaultHermesHome(): string {
  return path.join(os.homedir(), ".hermes");
}

export function resolveHermesStateDbPath(options: HermesStateOptions = {}): string {
  if (options.stateDbPath?.trim()) {
    return options.stateDbPath;
  }
  const home = options.hermesHome ?? process.env.HERMES_HOME ?? getDefaultHermesHome();
  return path.join(home, "state.db");
}

export function listHermesSessions(
  limit = 20,
  options: HermesStateOptions = {},
): HermesSessionRecord[] {
  return withHermesDatabase(options, (db, stateDbPath) => {
    const rows = db.prepare(`
      SELECT
        s.id,
        s.source,
        s.title,
        s.model,
        s.model_config,
        s.started_at,
        s.ended_at,
        s.message_count,
        s.input_tokens,
        s.output_tokens,
        s.cache_read_tokens,
        s.cache_write_tokens,
        s.reasoning_tokens,
        s.estimated_cost_usd,
        s.actual_cost_usd,
        COALESCE((
          SELECT SUBSTR(REPLACE(REPLACE(m.content, X'0A', ' '), X'0D', ' '), 1, 500)
          FROM messages m
          WHERE m.session_id = s.id AND m.role = 'user' AND m.content IS NOT NULL
          ORDER BY m.timestamp ASC, m.id ASC
          LIMIT 1
        ), '') AS first_user_message,
        COALESCE((
          SELECT MAX(m2.timestamp)
          FROM messages m2
          WHERE m2.session_id = s.id
        ), s.started_at) AS last_active
      FROM sessions s
      ORDER BY last_active DESC, s.started_at DESC
      LIMIT ?
    `).all(limit) as HermesSessionRow[];
    return rows.map((row) => mapHermesSessionRow(row, stateDbPath, options.workspace));
  }) ?? [];
}

export function getHermesSession(
  id: string,
  options: HermesStateOptions = {},
): HermesSessionRecord | null {
  const normalized = id.trim();
  if (!normalized) {
    return null;
  }
  return withHermesDatabase(options, (db, stateDbPath) => {
    const row = db.prepare(`
      SELECT
        s.id,
        s.source,
        s.title,
        s.model,
        s.model_config,
        s.started_at,
        s.ended_at,
        s.message_count,
        s.input_tokens,
        s.output_tokens,
        s.cache_read_tokens,
        s.cache_write_tokens,
        s.reasoning_tokens,
        s.estimated_cost_usd,
        s.actual_cost_usd,
        COALESCE((
          SELECT SUBSTR(REPLACE(REPLACE(m.content, X'0A', ' '), X'0D', ' '), 1, 500)
          FROM messages m
          WHERE m.session_id = s.id AND m.role = 'user' AND m.content IS NOT NULL
          ORDER BY m.timestamp ASC, m.id ASC
          LIMIT 1
        ), '') AS first_user_message,
        COALESCE((
          SELECT MAX(m2.timestamp)
          FROM messages m2
          WHERE m2.session_id = s.id
        ), s.started_at) AS last_active
      FROM sessions s
      WHERE s.id = ? OR s.id LIKE ?
      ORDER BY LENGTH(s.id) ASC, last_active DESC
      LIMIT 1
    `).get(normalized, `${escapeLikePrefix(normalized)}%`) as HermesSessionRow | undefined;
    return row ? mapHermesSessionRow(row, stateDbPath, options.workspace) : null;
  }) ?? null;
}

export function getHermesSessionActivity(
  id: string,
  options: HermesStateOptions & { staleAfterMs?: number; nowMs?: number } = {},
): AgentExternalActivity | null {
  return getHermesSessionSnapshot(id, { ...options, maxEvents: 0 })?.activity ?? null;
}

export function getHermesSessionActivityLog(
  id: string,
  limit = 50,
  options: HermesStateOptions = {},
): AgentActivityEvent[] {
  const snapshot = getHermesSessionSnapshot(id, { ...options, maxEvents: Math.max(1, limit) });
  return snapshot?.events.slice(-Math.max(1, limit)) ?? [];
}

export function getHermesSessionSnapshot(
  id: string,
  options: HermesStateOptions & {
    afterLine?: number;
    maxEvents?: number;
    staleAfterMs?: number;
    nowMs?: number;
  } = {},
): AgentExternalSnapshot | null {
  const record = getHermesSession(id, options);
  if (!record) {
    return null;
  }
  const messages = listHermesMessages(record.id, options);
  const parsed = parseHermesActivityEvents(messages, record.id, options.afterLine ?? 0);
  const latestUser = [...parsed.events].reverse().find((event) => event.kind === "user");
  const latestAgent = [...parsed.events].reverse().find((event) => event.kind === "agent");
  const latestTerminal = [...parsed.events].reverse().find((event) => event.kind === "task" && event.status && event.status !== "started");
  const latestTool = [...parsed.events].reverse().find((event) => event.kind === "tool" && event.toolName);
  const latestTimestamp = parsed.latestTimestamp ?? record.updatedAt;
  const hasAssistantAfterUser = Boolean(latestUser && latestAgent && latestAgent.lineNumber > latestUser.lineNumber);
  const terminalAfterUser = Boolean(latestUser && latestTerminal && latestTerminal.lineNumber > latestUser.lineNumber);
  const openTurn = Boolean(latestUser && !hasAssistantAfterUser && !terminalAfterUser);
  const staleAfterMs = options.staleAfterMs ?? 5 * 60 * 1000;
  const nowMs = options.nowMs ?? Date.now();
  const stale = Boolean(openTurn && latestTimestamp && nowMs - latestTimestamp.getTime() > staleAfterMs);
  const active = openTurn && !stale;
  const maxEvents = options.maxEvents ?? 50;
  const afterLine = options.afterLine ?? 0;
  const events = maxEvents <= 0
    ? []
    : parsed.events.filter((event) => event.lineNumber > afterLine).slice(-maxEvents);

  return {
    agentId: "hermes",
    agentLabel: "Hermes",
    threadId: record.id,
    sourcePath: record.sessionPath,
    sourceLabel: "Hermes state DB",
    lineCount: messages.length,
    activity: {
      agentId: "hermes",
      agentLabel: "Hermes",
      threadId: record.id,
      sourcePath: record.sessionPath,
      sourceLabel: "Hermes state DB",
      active,
      stale,
      turnId: latestUser?.turnId ?? latestTerminal?.turnId ?? null,
      startedAt: latestUser?.timestamp ?? null,
      updatedAt: latestTimestamp,
    },
    events,
    latestAgentMessage: latestAgent?.text ?? null,
    latestUserMessage: latestUser?.text ?? null,
    latestToolName: latestTool?.toolName ?? null,
  };
}

export function getHermesSessionDiagnostics(
  id: string | null | undefined,
  options: HermesStateOptions & { staleAfterMs?: number; nowMs?: number } = {},
): HermesSessionDiagnostics {
  const stateDbPath = resolveHermesStateDbPath(options);
  if (!BetterSqlite3) {
    return {
      stateDbPath,
      status: "unavailable",
      reason: "better-sqlite3 is not available",
      lineCount: 0,
      updatedAt: null,
    };
  }
  if (!existsSync(stateDbPath)) {
    return {
      stateDbPath,
      status: "unavailable",
      reason: "Hermes state.db not found",
      lineCount: 0,
      updatedAt: null,
    };
  }
  if (!id) {
    return {
      stateDbPath,
      status: "unavailable",
      reason: "no active Hermes session",
      lineCount: 0,
      updatedAt: null,
    };
  }
  const snapshot = getHermesSessionSnapshot(id, { ...options, maxEvents: 0 });
  if (!snapshot) {
    return {
      stateDbPath,
      status: "unavailable",
      reason: "Hermes session not found",
      lineCount: 0,
      updatedAt: null,
    };
  }
  const status = snapshot.activity.active ? "active" : snapshot.activity.stale ? "stale" : "idle";
  return {
    stateDbPath,
    status,
    reason: snapshot.activity.active
      ? "latest Hermes user turn has no assistant response yet"
      : snapshot.activity.stale
        ? "open Hermes turn exceeded stale timeout"
        : "latest Hermes turn has a terminal response",
    lineCount: snapshot.lineCount,
    updatedAt: snapshot.activity.updatedAt,
  };
}

export function listHermesWorkspaces(options: HermesStateOptions = {}): string[] {
  const workspaces = new Set<string>();
  if (options.workspace?.trim()) {
    workspaces.add(options.workspace);
  }
  const rows = withHermesDatabase(options, (db) => db.prepare(`
    SELECT source, model_config
    FROM sessions
    ORDER BY COALESCE(ended_at, started_at) DESC, started_at DESC
    LIMIT 500
  `).all() as Array<{ source: unknown; model_config: unknown }>) ?? [];
  for (const row of rows) {
    const workspace = extractHermesWorkspace(row);
    if (workspace) {
      workspaces.add(workspace);
    }
  }
  return [...workspaces].sort((left, right) => left.localeCompare(right));
}

export function listHermesMessages(id: string, options: HermesStateOptions = {}): HermesMessageRow[] {
  return withHermesDatabase(options, (db) => db.prepare(`
    SELECT id, role, content, tool_name, timestamp, token_count, reasoning, reasoning_content
    FROM messages
    WHERE session_id = ?
    ORDER BY timestamp ASC, id ASC
  `).all(id) as HermesMessageRow[]) ?? [];
}

function parseHermesActivityEvents(
  messages: HermesMessageRow[],
  sessionId: string,
  afterLine: number,
): { events: AgentActivityEvent[]; latestTimestamp: Date | null } {
  const events: AgentActivityEvent[] = [];
  let latestTimestamp: Date | null = null;
  let currentTurnId: string | null = null;

  for (const [index, message] of messages.entries()) {
    const lineNumber = index + 1;
    const timestamp = unixSecondsToDate(message.timestamp);
    if (timestamp && (!latestTimestamp || timestamp > latestTimestamp)) {
      latestTimestamp = timestamp;
    }
    const role = stringValue(message.role);
    const text = extractHermesMessageText(message);
    const toolName = extractHermesToolName(message);
    const reasoningText = extractHermesReasoningText(message);
    if (role === "user") {
      currentTurnId = `hermes-${sessionId}-${lineNumber}`;
      pushEvent(events, afterLine, {
        lineNumber,
        kind: "task",
        timestamp,
        type: "turn",
        turnId: currentTurnId,
        status: "started",
        text,
        toolName: null,
        phase: null,
      });
      pushEvent(events, afterLine, {
        lineNumber,
        kind: "user",
        timestamp,
        type: "message",
        turnId: currentTurnId,
        status: null,
        text,
        toolName: null,
        phase: null,
      });
      continue;
    }
    if (role === "assistant") {
      if (reasoningText) {
        pushEvent(events, afterLine, {
          lineNumber,
          kind: "tool",
          timestamp,
          type: "reasoning",
          turnId: currentTurnId,
          status: "finished",
          text: reasoningText,
          toolName: "reasoning",
          phase: null,
        });
      }
      if (toolName && !text) {
        pushEvent(events, afterLine, {
          lineNumber,
          kind: "tool",
          timestamp,
          type: "tool_call",
          turnId: currentTurnId,
          status: "started",
          text: null,
          toolName,
          phase: null,
        });
        continue;
      }
      if (reasoningText && !text) {
        continue;
      }
      pushEvent(events, afterLine, {
        lineNumber,
        kind: "agent",
        timestamp,
        type: "message",
        turnId: currentTurnId,
        status: "completed",
        text,
        toolName: null,
        phase: null,
      });
      pushEvent(events, afterLine, {
        lineNumber,
        kind: "task",
        timestamp,
        type: "turn",
        turnId: currentTurnId,
        status: "completed",
        text: null,
        toolName: null,
        phase: null,
      });
      continue;
    }
    if (role === "tool") {
      pushEvent(events, afterLine, {
        lineNumber,
        kind: "tool",
        timestamp,
        type: "tool",
        turnId: currentTurnId,
        status: "started",
        text: null,
        toolName: toolName ?? "tool",
        phase: null,
      });
      pushEvent(events, afterLine, {
        lineNumber,
        kind: "tool",
        timestamp,
        type: "tool",
        turnId: currentTurnId,
        status: "finished",
        text,
        toolName: toolName ?? "tool",
        phase: null,
      });
    }
  }
  return { events, latestTimestamp };
}

function mapHermesSessionRow(
  row: HermesSessionRow,
  stateDbPath: string,
  workspace: string | undefined,
): HermesSessionRecord {
  const usage = mapHermesUsage(row);
  const firstUserMessage = stringValue(row.first_user_message);
  const title = stringValue(row.title) ?? summarizeTitle(firstUserMessage);
  return {
    id: String(row.id ?? ""),
    title,
    cwd: extractHermesWorkspace(row, workspace) ?? process.cwd(),
    model: stringValue(row.model),
    reasoningEffort: parseReasoningFromModelConfig(row.model_config),
    createdAt: unixSecondsToDate(row.started_at) ?? new Date(0),
    updatedAt: unixSecondsToDate(row.last_active) ?? unixSecondsToDate(row.started_at) ?? new Date(0),
    firstUserMessage,
    agentId: "hermes",
    sessionPath: stateDbPath,
    source: stringValue(row.source) ?? "unknown",
    messageCount: numberValue(row.message_count) ?? 0,
    endedAt: unixSecondsToDate(row.ended_at),
    usage,
  };
}

function mapHermesUsage(row: HermesSessionRow): AgentSessionUsage | undefined {
  const input = numberValue(row.input_tokens) ?? 0;
  const output = numberValue(row.output_tokens) ?? 0;
  const cacheRead = numberValue(row.cache_read_tokens) ?? 0;
  const cacheWrite = numberValue(row.cache_write_tokens) ?? 0;
  const reasoning = numberValue(row.reasoning_tokens) ?? 0;
  const cost = numberValue(row.actual_cost_usd) ?? numberValue(row.estimated_cost_usd) ?? undefined;
  if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0 && reasoning === 0 && cost === undefined) {
    return undefined;
  }
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total: input + output + cacheRead + cacheWrite + reasoning,
    cost,
  };
}

function parseReasoningFromModelConfig(value: unknown): string | null {
  const raw = stringValue(value);
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const agent = objectValue(parsed.agent);
    return stringValue(parsed.reasoning_effort) ?? stringValue(agent?.reasoning_effort);
  } catch {
    return null;
  }
}

function extractHermesWorkspace(
  row: { source: unknown; model_config: unknown },
  fallback?: string,
): string | null {
  const parsed = parseJsonValue(stringValue(row.model_config));
  const config = objectValue(parsed);
  const agent = objectValue(config?.agent);
  const candidates = [
    stringValue(config?.cwd),
    stringValue(config?.workspace),
    stringValue(config?.working_directory),
    stringValue(config?.workingDirectory),
    stringValue(config?.project_dir),
    stringValue(config?.projectDir),
    stringValue(config?.repo_path),
    stringValue(config?.repository),
    stringValue(agent?.cwd),
    stringValue(agent?.workspace),
    workspaceFromSource(row.source),
    fallback,
  ];

  for (const candidate of candidates) {
    if (candidate?.trim() && path.isAbsolute(candidate.trim())) {
      return path.normalize(candidate.trim());
    }
  }
  return fallback?.trim() ? fallback : null;
}

function workspaceFromSource(value: unknown): string | null {
  const raw = stringValue(value);
  if (!raw) {
    return null;
  }
  if (path.isAbsolute(raw)) {
    return raw;
  }
  if (raw.startsWith("file://")) {
    const pathname = raw.slice("file://".length);
    try {
      return decodeURIComponent(pathname);
    } catch {
      return pathname;
    }
  }
  const keyValueMatch = raw.match(/(?:cwd|workspace|workdir|path|dir)=([^;,]+)/i);
  if (keyValueMatch?.[1] && path.isAbsolute(keyValueMatch[1].trim())) {
    return keyValueMatch[1].trim();
  }
  const prefixedPathMatch = raw.match(/^[a-z0-9_-]+:(\/.+)$/i);
  if (prefixedPathMatch?.[1] && path.isAbsolute(prefixedPathMatch[1].trim())) {
    return prefixedPathMatch[1].trim();
  }
  return null;
}

function withHermesDatabase<T>(
  options: HermesStateOptions,
  fn: (db: DatabaseInstance, stateDbPath: string) => T,
): T | null {
  if (!BetterSqlite3) {
    return null;
  }
  const stateDbPath = resolveHermesStateDbPath(options);
  if (!existsSync(stateDbPath)) {
    return null;
  }
  let db: DatabaseInstance | null = null;
  try {
    db = new BetterSqlite3(stateDbPath, { readonly: true, fileMustExist: true });
    return fn(db, stateDbPath);
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

function pushEvent(events: AgentActivityEvent[], afterLine: number, event: AgentActivityEvent): void {
  if (event.lineNumber > afterLine) {
    events.push(event);
  }
}

function unixSecondsToDate(value: unknown): Date | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value * 1000);
  }
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return new Date(numeric * 1000);
    }
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : new Date(parsed);
  }
  return null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function extractHermesMessageText(message: HermesMessageRow): string | null {
  const raw = stringValue(message.content);
  if (!raw) {
    return null;
  }
  const parsed = parseJsonValue(raw);
  return parsed ? extractTextFromValue(parsed) ?? raw : raw;
}

function extractHermesReasoningText(message: HermesMessageRow): string | null {
  const direct = stringValue(message.reasoning_content) ?? stringValue(message.reasoning);
  if (!direct) {
    return null;
  }
  const parsed = parseJsonValue(direct);
  return parsed ? extractTextFromValue(parsed) ?? direct : direct;
}

function extractHermesToolName(message: HermesMessageRow): string | null {
  const direct = stringValue(message.tool_name);
  if (direct) {
    return direct;
  }
  const parsed = parseJsonValue(stringValue(message.content));
  return parsed ? extractToolNameFromValue(parsed) : null;
}

function parseJsonValue(raw: string | null): unknown {
  if (!raw) {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) {
    return null;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

function extractTextFromValue(value: unknown): string | null {
  if (typeof value === "string") {
    return value.trim() || null;
  }
  if (Array.isArray(value)) {
    const text = value.map(extractTextFromValue).filter(Boolean).join("\n").trim();
    return text || null;
  }
  const object = objectValue(value);
  if (!object) {
    return null;
  }
  const direct =
    stringValue(object.text) ??
    stringValue(object.content) ??
    stringValue(object.message) ??
    stringValue(object.output) ??
    stringValue(object.result);
  if (direct) {
    return direct;
  }
  if (Array.isArray(object.content)) {
    return extractTextFromValue(object.content);
  }
  return null;
}

function extractToolNameFromValue(value: unknown): string | null {
  const object = objectValue(value);
  if (!object) {
    if (Array.isArray(value)) {
      for (const entry of value) {
        const name = extractToolNameFromValue(entry);
        if (name) return name;
      }
    }
    return null;
  }
  const functionObject = objectValue(object.function);
  const toolCall = objectValue(object.tool_call) ?? objectValue(object.toolCall);
  return (
    stringValue(object.tool_name) ??
    stringValue(object.toolName) ??
    stringValue(object.name) ??
    stringValue(functionObject?.name) ??
    extractToolNameFromValue(toolCall)
  );
}

function escapeLikePrefix(value: string): string {
  return value.replace(/[%_\\]/g, (char) => `\\${char}`);
}

function summarizeTitle(text: string | null): string | null {
  if (!text) {
    return null;
  }
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= 60 ? normalized : `${normalized.slice(0, 57)}...`;
}
