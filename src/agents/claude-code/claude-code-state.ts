import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  AgentActivityEvent,
  AgentExternalActivity,
  AgentExternalSnapshot,
  AgentSessionUsage,
  AgentThreadRecord,
} from "../shared/agent.js";

type JsonObject = Record<string, unknown>;

export interface ClaudeCodeStateOptions {
  claudeHome?: string;
  configDir?: string;
  workspace?: string;
}

export interface ClaudeCodeSessionRecord extends AgentThreadRecord {
  agentId: "claude-code";
  sessionPath: string;
  projectKey: string;
  messageCount: number;
  usage?: AgentSessionUsage;
}

export interface ClaudeCodeSessionDiagnostics {
  projectsDir: string;
  sessionPath: string | null;
  status: "active" | "stale" | "idle" | "unavailable";
  reason: string;
  lineCount: number;
  updatedAt: Date | null;
}

export function getDefaultClaudeCodeHome(): string {
  return path.join(os.homedir(), ".claude");
}

export function resolveClaudeCodeProjectsDir(options: ClaudeCodeStateOptions = {}): string {
  const configDir = options.configDir ?? process.env.CLAUDE_CONFIG_DIR;
  const home = options.claudeHome ?? getDefaultClaudeCodeHome();
  return path.join(configDir || home, "projects");
}

export function listClaudeCodeSessions(
  limit = 20,
  options: ClaudeCodeStateOptions = {},
): ClaudeCodeSessionRecord[] {
  const projectsDir = resolveClaudeCodeProjectsDir(options);
  if (!existsSync(projectsDir)) {
    return [];
  }

  const records: ClaudeCodeSessionRecord[] = [];
  for (const projectKey of safeReadDir(projectsDir)) {
    const projectPath = path.join(projectsDir, projectKey);
    if (!safeStat(projectPath)?.isDirectory()) {
      continue;
    }
    for (const fileName of safeReadDir(projectPath)) {
      if (!fileName.endsWith(".jsonl")) {
        continue;
      }
      const sessionPath = path.join(projectPath, fileName);
      const record = readClaudeCodeSessionRecord(sessionPath, projectKey, options);
      if (record) {
        records.push(record);
      }
    }
  }

  return records
    .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime())
    .slice(0, Math.max(1, limit));
}

export function getClaudeCodeSession(
  idOrPath: string,
  options: ClaudeCodeStateOptions = {},
): ClaudeCodeSessionRecord | null {
  const normalized = idOrPath.trim();
  if (!normalized) {
    return null;
  }
  if (existsSync(normalized)) {
    return readClaudeCodeSessionRecord(normalized, path.basename(path.dirname(normalized)), options);
  }
  return listClaudeCodeSessions(500, options).find((record) =>
    record.id === normalized ||
    record.id.startsWith(normalized) ||
    path.basename(record.sessionPath, ".jsonl") === normalized ||
    record.sessionPath === normalized,
  ) ?? null;
}

export function getClaudeCodeSessionActivity(
  idOrPath: string,
  options: ClaudeCodeStateOptions & { staleAfterMs?: number; nowMs?: number } = {},
): AgentExternalActivity | null {
  return getClaudeCodeSessionSnapshot(idOrPath, { ...options, maxEvents: 0 })?.activity ?? null;
}

export function getClaudeCodeSessionActivityLog(
  idOrPath: string,
  limit = 50,
  options: ClaudeCodeStateOptions = {},
): AgentActivityEvent[] {
  return getClaudeCodeSessionSnapshot(idOrPath, { ...options, maxEvents: Math.max(1, limit) })?.events ?? [];
}

export function getClaudeCodeSessionSnapshot(
  idOrPath: string,
  options: ClaudeCodeStateOptions & {
    afterLine?: number;
    maxEvents?: number;
    staleAfterMs?: number;
    nowMs?: number;
  } = {},
): AgentExternalSnapshot | null {
  const record = getClaudeCodeSession(idOrPath, options);
  if (!record) {
    return null;
  }
  return readClaudeCodeSessionSnapshot(record, options);
}

export function getClaudeCodeSessionDiagnostics(
  idOrPath: string | null | undefined,
  options: ClaudeCodeStateOptions & { staleAfterMs?: number; nowMs?: number } = {},
): ClaudeCodeSessionDiagnostics {
  const projectsDir = resolveClaudeCodeProjectsDir(options);
  if (!idOrPath) {
    return {
      projectsDir,
      sessionPath: null,
      lineCount: 0,
      status: "unavailable",
      reason: "no active Claude Code session",
      updatedAt: null,
    };
  }
  const snapshot = getClaudeCodeSessionSnapshot(idOrPath, { ...options, maxEvents: 0 });
  if (!snapshot) {
    return {
      projectsDir,
      sessionPath: null,
      lineCount: 0,
      status: "unavailable",
      reason: "Claude Code session file not found or unreadable",
      updatedAt: null,
    };
  }
  const status = snapshot.activity.active ? "active" : snapshot.activity.stale ? "stale" : "idle";
  return {
    projectsDir,
    sessionPath: snapshot.sourcePath,
    lineCount: snapshot.lineCount,
    status,
    reason: snapshot.activity.active
      ? "latest Claude Code user turn has no terminal response yet"
      : snapshot.activity.stale
        ? "open Claude Code turn exceeded stale timeout"
        : "latest Claude Code turn has a terminal response",
    updatedAt: snapshot.activity.updatedAt,
  };
}

export function listClaudeCodeWorkspaces(options: ClaudeCodeStateOptions = {}): string[] {
  const workspaces = new Set<string>();
  if (options.workspace) {
    workspaces.add(options.workspace);
  }
  for (const record of listClaudeCodeSessions(500, options)) {
    if (record.cwd) {
      workspaces.add(record.cwd);
    }
  }
  return [...workspaces].sort((left, right) => left.localeCompare(right));
}

export function readClaudeCodeSessionRecord(
  sessionPath: string,
  projectKey?: string,
  options: ClaudeCodeStateOptions = {},
): ClaudeCodeSessionRecord | null {
  try {
    const fileStat = statSync(sessionPath);
    const lines = readJsonlLines(sessionPath);
    const fileSessionId = path.basename(sessionPath, ".jsonl");
    let id = fileSessionId;
    let createdAt = fileStat.birthtimeMs > 0 ? fileStat.birthtime : fileStat.mtime;
    let updatedAt = fileStat.mtime;
    let cwd = options.workspace ?? (projectKey ? decodeClaudeCodeProjectKey(projectKey) : path.dirname(sessionPath));
    let model: string | null = null;
    let reasoningEffort: string | null = null;
    let firstUserMessage: string | null = null;
    let lastAssistantText: string | null = null;
    let title: string | null = null;
    let messageCount = 0;
    let usage: AgentSessionUsage | undefined;

    for (const { entry } of lines) {
      id = stringValue(entry.session_id) ?? stringValue(entry.sessionId) ?? id;
      cwd = stringValue(entry.cwd) ?? stringValue(objectValue(entry.message)?.cwd) ?? cwd;
      title = stringValue(entry.customTitle) ?? stringValue(entry.summary) ?? title;
      model = stringValue(entry.model) ?? stringValue(objectValue(entry.message)?.model) ?? model;
      reasoningEffort = reasoningValue(entry) ?? reasoningEffort;

      const timestamp = dateValue(entry.timestamp) ?? dateValue(entry.created_at) ?? dateValue(entry.createdAt);
      if (timestamp) {
        if (timestamp < createdAt) {
          createdAt = timestamp;
        }
        if (timestamp > updatedAt) {
          updatedAt = timestamp;
        }
      }

      const type = stringValue(entry.type);
      if (type === "summary") {
        title = stringValue(entry.summary) ?? title;
      }
      if (type === "user" || type === "assistant") {
        messageCount += 1;
      }
      if (type === "user" && !isToolResultEntry(entry) && !firstUserMessage) {
        firstUserMessage = extractEntryText(entry);
      } else if (type === "assistant") {
        const assistantText = extractEntryText(entry);
        if (assistantText) {
          lastAssistantText = assistantText;
        }
      } else if (type === "result") {
        usage = usageFromObject(entry.usage) ?? usage;
      }

      usage = usageFromObject(objectValue(entry.message)?.usage) ?? usage;
    }

    return {
      id,
      title: title ?? summarizeTitle(firstUserMessage ?? lastAssistantText),
      cwd,
      model,
      reasoningEffort,
      createdAt,
      updatedAt,
      firstUserMessage,
      agentId: "claude-code",
      sessionPath,
      projectKey: projectKey ?? path.basename(path.dirname(sessionPath)),
      messageCount,
      usage,
    };
  } catch {
    return null;
  }
}

function readClaudeCodeSessionSnapshot(
  record: ClaudeCodeSessionRecord,
  options: {
    afterLine?: number;
    maxEvents?: number;
    staleAfterMs?: number;
    nowMs?: number;
  } = {},
): AgentExternalSnapshot | null {
  try {
    const fileStat = statSync(record.sessionPath);
    const rows = readJsonlLines(record.sessionPath);
    const parsed = parseClaudeCodeActivityEvents(rows, record.id, options.afterLine ?? 0);
    const latestUser = [...parsed.events].reverse().find((event) => event.kind === "user");
    const latestAgent = [...parsed.events].reverse().find((event) => event.kind === "agent");
    const latestTerminal = [...parsed.events].reverse().find((event) => event.kind === "task" && event.status && event.status !== "started");
    const latestTool = [...parsed.events].reverse().find((event) => event.kind === "tool" && event.toolName);
    const latestTimestamp = parsed.latestTimestamp ?? fileStat.mtime;
    const hasAssistantAfterUser = Boolean(latestUser && latestAgent && latestAgent.lineNumber > latestUser.lineNumber);
    const terminalAfterUser = Boolean(latestUser && latestTerminal && latestTerminal.lineNumber > latestUser.lineNumber);
    const openTurn = Boolean(latestUser && !hasAssistantAfterUser && !terminalAfterUser);
    const staleAfterMs = options.staleAfterMs ?? 5 * 60 * 1000;
    const nowMs = options.nowMs ?? Date.now();
    const stale = openTurn && nowMs - latestTimestamp.getTime() > staleAfterMs;
    const active = openTurn && !stale;
    const maxEvents = options.maxEvents ?? 50;
    const events = maxEvents <= 0 ? [] : parsed.events.slice(-maxEvents);

    return {
      agentId: "claude-code",
      agentLabel: "Claude Code",
      threadId: record.id,
      sourcePath: record.sessionPath,
      sourceLabel: "Claude Code transcript",
      lineCount: rows.length,
      activity: {
        agentId: "claude-code",
        agentLabel: "Claude Code",
        threadId: record.id,
        sourcePath: record.sessionPath,
        sourceLabel: "Claude Code transcript",
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
  } catch {
    return null;
  }
}

function parseClaudeCodeActivityEvents(
  rows: Array<{ lineNumber: number; entry: JsonObject }>,
  sessionId: string,
  afterLine: number,
): { events: AgentActivityEvent[]; latestTimestamp: Date | null } {
  const events: AgentActivityEvent[] = [];
  let latestTimestamp: Date | null = null;
  let currentTurnId: string | null = null;
  const toolNamesById = new Map<string, string>();

  for (const { lineNumber, entry } of rows) {
    const timestamp = dateValue(entry.timestamp) ?? dateValue(entry.createdAt) ?? dateValue(entry.created_at);
    if (timestamp && (!latestTimestamp || timestamp > latestTimestamp)) {
      latestTimestamp = timestamp;
    }
    const type = stringValue(entry.type) ?? "entry";
    const subtype = stringValue(entry.subtype);

    if (type === "user") {
      if (isToolResultEntry(entry)) {
      for (const tool of extractToolResults(entry)) {
        pushEvent(events, afterLine, {
            lineNumber,
            kind: "tool",
            timestamp,
            type: "tool_result",
            turnId: currentTurnId,
            status: tool.isError ? "failed" : "finished",
            text: tool.text,
            toolName: tool.name ?? (tool.id ? toolNamesById.get(tool.id) : undefined) ?? "tool",
            phase: null,
          });
        }
        continue;
      }
      currentTurnId = `claude-code-${sessionId}-${lineNumber}`;
      const text = extractEntryText(entry);
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
        type,
        turnId: currentTurnId,
        status: null,
        text,
        toolName: null,
        phase: null,
      });
      continue;
    }

    if (type === "assistant") {
      for (const tool of extractToolUses(entry)) {
        if (tool.id && tool.name) {
          toolNamesById.set(tool.id, tool.name);
        }
        pushEvent(events, afterLine, {
          lineNumber,
          kind: "tool",
          timestamp,
          type: "tool_use",
          turnId: currentTurnId,
          status: "started",
          text: tool.text,
          toolName: tool.name ?? "tool",
          phase: null,
        });
      }
      const text = extractEntryText(entry);
      if (text) {
        pushEvent(events, afterLine, {
          lineNumber,
          kind: "agent",
          timestamp,
          type,
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
      }
      continue;
    }

    if (type === "result") {
      pushEvent(events, afterLine, {
        lineNumber,
        kind: "task",
        timestamp,
        type: subtype ?? type,
        turnId: currentTurnId,
        status: subtype && subtype !== "success" ? "failed" : "completed",
        text: stringValue(entry.result) ?? firstString(entry.errors),
        toolName: null,
        phase: null,
      });
      continue;
    }

    if (type === "system" && subtype === "session_state_changed") {
      const state = stringValue(entry.state);
      if (state === "running" || state === "requires_action") {
        pushEvent(events, afterLine, {
          lineNumber,
          kind: "task",
          timestamp,
          type: subtype,
          turnId: currentTurnId,
          status: "started",
          text: state,
          toolName: null,
          phase: state,
        });
      } else if (state === "idle") {
        pushEvent(events, afterLine, {
          lineNumber,
          kind: "task",
          timestamp,
          type: subtype,
          turnId: currentTurnId,
          status: "completed",
          text: state,
          toolName: null,
          phase: state,
        });
      }
      continue;
    }

    if (type === "tool_progress" || subtype === "task_progress" || subtype === "task_started" || subtype === "task_notification") {
      pushEvent(events, afterLine, {
        lineNumber,
        kind: "tool",
        timestamp,
        type: subtype ?? type,
        turnId: currentTurnId,
        status: subtype === "task_notification" ? "finished" : "started",
        text: stringValue(entry.description) ?? stringValue(entry.summary) ?? stringValue(entry.output_file),
        toolName: stringValue(entry.tool_name) ?? stringValue(entry.last_tool_name) ?? stringValue(entry.task_type) ?? "task",
        phase: null,
      });
    }
  }

  return { events, latestTimestamp };
}

function readJsonlLines(filePath: string): Array<{ lineNumber: number; entry: JsonObject }> {
  return readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line, index) => ({ lineNumber: index + 1, line }))
    .filter(({ line }) => line.trim().length > 0)
    .map(({ lineNumber, line }) => ({ lineNumber, entry: safeJsonParse(line) }))
    .filter((row): row is { lineNumber: number; entry: JsonObject } => Boolean(row.entry));
}

function isToolResultEntry(entry: JsonObject): boolean {
  const message = objectValue(entry.message);
  const content = message?.content ?? entry.content;
  return Array.isArray(content) && content.some((part) => stringValue(objectValue(part)?.type) === "tool_result");
}

function extractToolUses(entry: JsonObject): Array<{ id: string | null; name: string | null; text: string | null }> {
  const content = contentArray(entry);
  return content
    .map((part) => objectValue(part))
    .filter((part): part is JsonObject => part !== null && stringValue(part.type) === "tool_use")
    .map((part) => ({
      id: stringValue(part.id),
      name: stringValue(part.name),
      text: stringifyPreview(part.input),
    }));
}

function extractToolResults(entry: JsonObject): Array<{ id: string | null; name: string | null; text: string | null; isError: boolean }> {
  const content = contentArray(entry);
  return content
    .map((part) => objectValue(part))
    .filter((part): part is JsonObject => part !== null && stringValue(part.type) === "tool_result")
    .map((part) => ({
      id: stringValue(part.tool_use_id) ?? stringValue(part.toolUseId),
      name: stringValue(part.name),
      text: extractContentText(part),
      isError: booleanValue(part.is_error) ?? booleanValue(part.isError) ?? false,
    }));
}

function extractEntryText(entry: JsonObject): string | null {
  const message = objectValue(entry.message);
  const direct = stringValue(entry.text) ?? stringValue(entry.result);
  if (direct) {
    return direct;
  }
  return extractContentText(message ?? entry);
}

function extractContentText(container: JsonObject | null): string | null {
  if (!container) {
    return null;
  }
  const direct = stringValue(container.text) ?? stringValue(container.content) ?? stringValue(container.summary);
  if (direct) {
    return direct;
  }
  const content = container.content;
  if (!Array.isArray(content)) {
    return null;
  }
  const parts = content
    .map((part) => {
      const block = objectValue(part);
      if (!block) {
        return "";
      }
      if (stringValue(block.type) === "tool_use" || stringValue(block.type) === "tool_result") {
        return "";
      }
      return stringValue(block.text) ?? stringValue(block.thinking) ?? "";
    })
    .filter(Boolean);
  return parts.join("\n").trim() || null;
}

function contentArray(entry: JsonObject): unknown[] {
  const message = objectValue(entry.message);
  const content = message?.content ?? entry.content;
  return Array.isArray(content) ? content : [];
}

function reasoningValue(entry: JsonObject): string | null {
  const effort = objectValue(entry.effort) ?? objectValue(entry.message);
  return stringValue(objectValue(effort?.effort)?.level)
    ?? stringValue(objectValue(effort?.thinking)?.level)
    ?? stringValue(effort?.reasoningEffort)
    ?? stringValue(effort?.reasoning_effort);
}

function usageFromObject(value: unknown): AgentSessionUsage | undefined {
  const usage = objectValue(value);
  if (!usage) {
    return undefined;
  }
  const input = numberValue(usage.input_tokens) ?? numberValue(usage.inputTokens) ?? 0;
  const output = numberValue(usage.output_tokens) ?? numberValue(usage.outputTokens) ?? 0;
  const cacheRead = numberValue(usage.cache_read_input_tokens) ?? numberValue(usage.cacheReadInputTokens) ?? numberValue(usage.cache_read_tokens) ?? 0;
  const cacheWrite = numberValue(usage.cache_creation_input_tokens) ?? numberValue(usage.cacheCreationInputTokens) ?? numberValue(usage.cache_write_tokens) ?? 0;
  const total = input + output + cacheRead + cacheWrite;
  if (total <= 0) {
    return undefined;
  }
  return { input, output, cacheRead, cacheWrite, total, cost: numberValue(usage.cost) ?? undefined };
}

function decodeClaudeCodeProjectKey(projectKey: string): string {
  if (!projectKey) {
    return process.cwd();
  }
  if (projectKey.startsWith("file-")) {
    try {
      return decodeURIComponent(projectKey.slice("file-".length));
    } catch {
      return projectKey;
    }
  }
  if (projectKey.startsWith("-")) {
    return path.normalize(`/${projectKey.slice(1).replace(/-/g, "/")}`);
  }
  return path.normalize(projectKey.replace(/-/g, path.sep));
}

function safeReadDir(directory: string): string[] {
  try {
    return readdirSync(directory);
  } catch {
    return [];
  }
}

function safeStat(targetPath: string): ReturnType<typeof statSync> | null {
  try {
    return statSync(targetPath);
  } catch {
    return null;
  }
}

function safeJsonParse(line: string): JsonObject | null {
  try {
    return objectValue(JSON.parse(line) as unknown);
  } catch {
    return null;
  }
}

function pushEvent(events: AgentActivityEvent[], afterLine: number, event: AgentActivityEvent): void {
  if (event.lineNumber > afterLine) {
    events.push(event);
  }
}

function objectValue(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function stringValue(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
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
    const timestamp = Date.parse(value);
    return Number.isNaN(timestamp) ? null : new Date(timestamp);
  }
  return null;
}

function firstString(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return stringValue(value);
  }
  return value.map(stringValue).find(Boolean) ?? null;
}

function stringifyPreview(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === "string") {
    return value.trim() || null;
  }
  try {
    const text = JSON.stringify(value);
    return text.length <= 500 ? text : `${text.slice(0, 497)}...`;
  } catch {
    return null;
  }
}

function summarizeTitle(text: string | null): string | null {
  if (!text) {
    return null;
  }
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= 60 ? normalized : `${normalized.slice(0, 57)}...`;
}
