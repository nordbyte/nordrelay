import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AgentActivityEvent, AgentExternalActivity, AgentExternalSnapshot, AgentThreadRecord } from "../shared/agent.js";

export interface PiSessionRecord extends AgentThreadRecord {
  agentId: "pi";
  sessionPath: string;
  messageCount: number;
}

export interface PiSessionDiagnostics {
  sessionDir: string;
  sessionPath: string | null;
  lineCount: number;
  status: "active" | "stale" | "idle" | "unavailable";
  reason: string;
  updatedAt: Date | null;
}

export interface PiSessionStateOptions {
  sessionDir?: string;
}

type JsonObject = Record<string, unknown>;

export function getDefaultPiSessionDir(): string {
  return path.join(os.homedir(), ".pi", "agent", "sessions");
}

export function resolvePiSessionDir(options: PiSessionStateOptions = {}): string {
  return options.sessionDir ?? process.env.PI_CODING_AGENT_SESSION_DIR ?? getDefaultPiSessionDir();
}

export function listPiSessions(
  limit = 20,
  options: PiSessionStateOptions = {},
): PiSessionRecord[] {
  const sessionDir = resolvePiSessionDir(options);
  if (!existsSync(sessionDir)) {
    return [];
  }

  const records: PiSessionRecord[] = [];
  for (const workspaceDir of safeReadDir(sessionDir)) {
    const workspacePath = path.join(sessionDir, workspaceDir);
    if (!safeStat(workspacePath)?.isDirectory()) {
      continue;
    }

    for (const fileName of safeReadDir(workspacePath)) {
      if (!fileName.endsWith(".jsonl")) {
        continue;
      }
      const sessionPath = path.join(workspacePath, fileName);
      const record = readPiSessionRecord(sessionPath, workspaceDir);
      if (record) {
        records.push(record);
      }
    }
  }

  return records
    .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime())
    .slice(0, limit);
}

export function getPiSession(
  idOrPath: string,
  options: PiSessionStateOptions = {},
): PiSessionRecord | null {
  const normalized = idOrPath.trim();
  if (!normalized) {
    return null;
  }

  if (existsSync(normalized)) {
    return readPiSessionRecord(normalized, path.basename(path.dirname(normalized)));
  }

  const matches = listPiSessions(500, options).filter((record) =>
    record.id === normalized ||
    record.id.startsWith(normalized) ||
    record.sessionPath === normalized ||
    path.basename(record.sessionPath, ".jsonl") === normalized ||
    path.basename(record.sessionPath, ".jsonl").endsWith(`_${normalized}`),
  );
  return matches[0] ?? null;
}

export function getPiSessionActivity(
  idOrPath: string,
  options: PiSessionStateOptions & { staleAfterMs?: number; nowMs?: number } = {},
): AgentExternalActivity | null {
  return getPiSessionSnapshot(idOrPath, { ...options, maxEvents: 0 })?.activity ?? null;
}

export function getPiSessionActivityLog(
  idOrPath: string,
  limit = 50,
  options: PiSessionStateOptions = {},
): AgentActivityEvent[] {
  const snapshot = getPiSessionSnapshot(idOrPath, { ...options, maxEvents: Math.max(1, limit) });
  return snapshot?.events.slice(-Math.max(1, limit)) ?? [];
}

export function getPiSessionSnapshot(
  idOrPath: string,
  options: PiSessionStateOptions & {
    afterLine?: number;
    maxEvents?: number;
    staleAfterMs?: number;
    nowMs?: number;
  } = {},
): AgentExternalSnapshot | null {
  const record = getPiSession(idOrPath, options);
  if (!record) {
    return null;
  }
  return readPiSessionSnapshot(record, options);
}

export function getPiSessionDiagnostics(
  idOrPath: string | null | undefined,
  options: PiSessionStateOptions & { staleAfterMs?: number; nowMs?: number } = {},
): PiSessionDiagnostics {
  const sessionDir = resolvePiSessionDir(options);
  if (!idOrPath) {
    return {
      sessionDir,
      sessionPath: null,
      lineCount: 0,
      status: "unavailable",
      reason: "no active Pi session",
      updatedAt: null,
    };
  }
  const snapshot = getPiSessionSnapshot(idOrPath, { ...options, maxEvents: 0 });
  if (!snapshot) {
    return {
      sessionDir,
      sessionPath: null,
      lineCount: 0,
      status: "unavailable",
      reason: "session file not found or unreadable",
      updatedAt: null,
    };
  }
  const status = snapshot.activity.active ? "active" : snapshot.activity.stale ? "stale" : "idle";
  const reason = snapshot.activity.active
    ? "latest Pi turn has no terminal assistant response yet"
    : snapshot.activity.stale
      ? "open Pi turn exceeded stale timeout"
      : "latest Pi turn has a terminal response";
  return {
    sessionDir,
    sessionPath: snapshot.sourcePath,
    lineCount: snapshot.lineCount,
    status,
    reason,
    updatedAt: snapshot.activity.updatedAt,
  };
}

export function listPiWorkspaces(options: PiSessionStateOptions = {}): string[] {
  const workspaces = new Set<string>();
  for (const record of listPiSessions(500, options)) {
    if (record.cwd) {
      workspaces.add(record.cwd);
    }
  }
  return [...workspaces].sort((left, right) => left.localeCompare(right));
}

export function readPiSessionRecord(
  sessionPath: string,
  workspaceSlug?: string,
): PiSessionRecord | null {
  try {
    const fileStat = statSync(sessionPath);
    const lines = readFileSync(sessionPath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean);
    const fallbackDate = parsePiSessionDateFromFilename(path.basename(sessionPath)) ?? fileStat.mtime;
    let id = parsePiSessionIdFromFilename(path.basename(sessionPath));
    let createdAt = fallbackDate;
    let updatedAt = fileStat.mtime;
    let cwd = workspaceSlug ? decodePiWorkspaceSlug(workspaceSlug) : path.dirname(sessionPath);
    let model: string | null = null;
    let reasoningEffort: string | null = null;
    let firstUserMessage: string | null = null;
    let lastAssistantText: string | null = null;
    let title: string | null = null;
    let messageCount = 0;

    for (const line of lines) {
      const entry = safeJsonParse(line);
      if (!entry) {
        continue;
      }

      if (entry.type === "session") {
        id = stringValue(entry.id) ?? id;
        cwd = stringValue(entry.cwd) ?? cwd;
        createdAt = dateValue(entry.timestamp) ?? createdAt;
      } else if (entry.type === "model_change") {
        const provider = stringValue(entry.provider);
        const modelId = stringValue(entry.modelId) ?? stringValue(entry.model);
        model = modelId ? (provider ? `${provider}/${modelId}` : modelId) : model;
      } else if (entry.type === "thinking_level_change") {
        reasoningEffort = stringValue(entry.thinkingLevel) ?? reasoningEffort;
      }

      const entryTimestamp = dateValue(entry.timestamp);
      if (entryTimestamp && entryTimestamp > updatedAt) {
        updatedAt = entryTimestamp;
      }

      const message = objectValue(entry.message);
      if (message) {
        messageCount += 1;
        const role = stringValue(message.role);
        if (role === "user" && !firstUserMessage) {
          firstUserMessage = extractMessageText(message);
        } else if (role === "assistant") {
          const assistantText = extractMessageText(message);
          if (assistantText) {
            lastAssistantText = assistantText;
          }
          model = stringValue(message.model) ?? model;
        }
      }

      title = stringValue(entry.sessionName) ?? stringValue(entry.name) ?? title;
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
      agentId: "pi",
      sessionPath,
      messageCount,
    };
  } catch {
    return null;
  }
}

function readPiSessionSnapshot(
  record: PiSessionRecord,
  options: {
    afterLine?: number;
    maxEvents?: number;
    staleAfterMs?: number;
    nowMs?: number;
  } = {},
): AgentExternalSnapshot | null {
  try {
    const fileStat = statSync(record.sessionPath);
    const lines = readFileSync(record.sessionPath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean);
    const parsed = parsePiActivityEvents(lines, record.id, 0);
    const staleAfterMs = options.staleAfterMs ?? 5 * 60 * 1000;
    const nowMs = options.nowMs ?? Date.now();
    const latestUser = [...parsed.events].reverse().find((event) => event.kind === "user");
    const latestAgent = [...parsed.events].reverse().find((event) => event.kind === "agent");
    const latestTerminal = [...parsed.events].reverse().find((event) => event.kind === "task" && event.status && event.status !== "started");
    const latestTool = [...parsed.events].reverse().find((event) => event.kind === "tool" && event.toolName);
    const latestTimestamp = parsed.latestTimestamp ?? fileStat.mtime;
    const activeStartedAt = latestUser?.timestamp ?? null;
    const terminalAfterUser = Boolean(
      latestUser && latestTerminal && latestTerminal.lineNumber > latestUser.lineNumber,
    );
    const openTurn = Boolean(latestUser && !terminalAfterUser);
    const stale = openTurn && nowMs - latestTimestamp.getTime() > staleAfterMs;
    const active = openTurn && !stale;
    const turnId = latestUser?.turnId ?? latestTerminal?.turnId ?? null;
    const maxEvents = options.maxEvents ?? 50;
    const afterLine = options.afterLine ?? 0;
    const events = maxEvents <= 0 ? [] : parsed.events.filter((event) => event.lineNumber > afterLine).slice(-maxEvents);

    return {
      agentId: "pi",
      agentLabel: "Pi",
      threadId: record.id,
      sourcePath: record.sessionPath,
      sourceLabel: "Pi session",
      lineCount: lines.length,
      activity: {
        agentId: "pi",
        agentLabel: "Pi",
        threadId: record.id,
        sourcePath: record.sessionPath,
        sourceLabel: "Pi session",
        active,
        stale,
        turnId,
        startedAt: activeStartedAt,
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

function parsePiActivityEvents(
  lines: string[],
  sessionId: string,
  afterLine: number,
): { events: AgentActivityEvent[]; latestTimestamp: Date | null } {
  const events: AgentActivityEvent[] = [];
  let latestTimestamp: Date | null = null;
  let currentTurnId: string | null = null;

  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    const entry = safeJsonParse(line);
    if (!entry) {
      continue;
    }
    const timestamp = dateValue(entry.timestamp) ?? dateValue(objectValue(entry.message)?.timestamp);
    if (timestamp && (!latestTimestamp || timestamp > latestTimestamp)) {
      latestTimestamp = timestamp;
    }
    const type = stringValue(entry.type) ?? "entry";

    if (type === "message") {
      const message = objectValue(entry.message);
      const role = stringValue(message?.role);
      const text = message ? extractMessageText(message) : null;
      if (role === "user") {
        currentTurnId = `pi-${sessionId}-${lineNumber}`;
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
      } else if (role === "assistant") {
        const terminalStatus = message ? piAssistantTerminalStatus(message) : null;
        pushEvent(events, afterLine, {
          lineNumber,
          kind: "agent",
          timestamp,
          type,
          turnId: currentTurnId,
          status: terminalStatus,
          text,
          toolName: null,
          phase: null,
        });

        for (const toolName of extractToolCallNames(message)) {
          pushEvent(events, afterLine, {
            lineNumber,
            kind: "tool",
            timestamp,
            type,
            turnId: currentTurnId,
            status: "started",
            text: null,
            toolName,
            phase: null,
          });
        }

        if (terminalStatus) {
          pushEvent(events, afterLine, {
            lineNumber,
            kind: "task",
            timestamp,
            type: "turn",
            turnId: currentTurnId,
            status: terminalStatus,
            text: null,
            toolName: null,
            phase: null,
          });
        }
      } else if (role === "tool" || role === "toolResult") {
        pushEvent(events, afterLine, {
          lineNumber,
          kind: "tool",
          timestamp,
          type,
          turnId: currentTurnId,
          status: "finished",
          text,
          toolName: stringValue(message?.toolName) ?? stringValue(message?.name) ?? extractToolName(message) ?? "tool",
          phase: null,
        });
      }
      continue;
    }

    if (/tool/i.test(type)) {
      const status = /start/i.test(type) ? "started" : /error|fail/i.test(type) ? "failed" : /end|finish|complete/i.test(type) ? "finished" : null;
      pushEvent(events, afterLine, {
        lineNumber,
        kind: "tool",
        timestamp,
        type,
        turnId: currentTurnId,
        status,
        text: extractContentText(entry),
        toolName: stringValue(entry.toolName) ?? stringValue(entry.name) ?? "tool",
        phase: null,
      });
      continue;
    }

    if (/error|fail/i.test(type)) {
      pushEvent(events, afterLine, {
        lineNumber,
        kind: "task",
        timestamp,
        type,
        turnId: currentTurnId,
        status: "failed",
        text: stringValue(entry.error) ?? stringValue(entry.message),
        toolName: null,
        phase: null,
      });
    }
  }

  return { events, latestTimestamp };
}

function pushEvent(events: AgentActivityEvent[], afterLine: number, event: AgentActivityEvent): void {
  if (event.lineNumber > afterLine) {
    events.push(event);
  }
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
    const parsed = JSON.parse(line) as unknown;
    return objectValue(parsed);
  } catch {
    return null;
  }
}

function objectValue(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null ? value as JsonObject : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function dateValue(value: unknown): Date | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value);
  }
  if (typeof value === "string" && value.trim()) {
    const timestamp = Date.parse(value);
    return Number.isNaN(timestamp) ? null : new Date(timestamp);
  }
  return null;
}

function parsePiSessionIdFromFilename(fileName: string): string {
  const withoutExt = fileName.replace(/\.jsonl$/i, "");
  const uuidMatch = withoutExt.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  if (uuidMatch) {
    return uuidMatch[1]!;
  }
  const underscoreIndex = withoutExt.lastIndexOf("_");
  return underscoreIndex === -1 ? withoutExt : withoutExt.slice(underscoreIndex + 1);
}

function parsePiSessionDateFromFilename(fileName: string): Date | null {
  const match = fileName.match(/^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)_/);
  if (!match) {
    return null;
  }
  const normalized = match[1]!
    .replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, "T$1:$2:$3.$4Z");
  const timestamp = Date.parse(normalized);
  return Number.isNaN(timestamp) ? null : new Date(timestamp);
}

function decodePiWorkspaceSlug(slug: string): string {
  const normalized = slug.replace(/^--/, "").replace(/--$/, "");
  if (!normalized) {
    return "/";
  }
  return `/${normalized.replace(/-/g, "/")}`;
}

function extractMessageText(message: JsonObject): string | null {
  const content = message.content;
  if (typeof content === "string") {
    return content.trim() || null;
  }
  if (!Array.isArray(content)) {
    return null;
  }

  const parts = content
    .map((part) => {
      const block = objectValue(part);
      if (!block) {
        return "";
      }
      return stringValue(block.text) ?? stringValue(block.thinking) ?? "";
    })
    .filter(Boolean);
  return parts.join("\n").trim() || null;
}

function extractContentText(container: JsonObject): string | null {
  const direct = stringValue(container.text) ?? stringValue(container.error);
  if (direct) {
    return direct;
  }
  const content = container.content;
  if (typeof content === "string") {
    return content.trim() || null;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const text = content
    .map((entry) => {
      const block = objectValue(entry);
      return block ? stringValue(block.text) ?? stringValue(block.content) ?? "" : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
  return text || null;
}

function extractToolName(message: JsonObject | null): string | null {
  if (!message) {
    return null;
  }
  const toolCall = objectValue(message.toolCall) ?? objectValue(message.tool_call);
  return stringValue(toolCall?.name) ?? stringValue(toolCall?.toolName) ?? stringValue(message.toolName);
}

function piAssistantTerminalStatus(message: JsonObject): "completed" | "failed" | null {
  const stopReason = stringValue(message.stopReason)?.toLowerCase();
  if (stopReason === "tooluse" || stopReason === "tool_use") {
    return null;
  }
  if (stopReason && /error|fail/.test(stopReason)) {
    return "failed";
  }
  if (stopReason) {
    return "completed";
  }
  return extractToolCallNames(message).length > 0 ? null : "completed";
}

function extractToolCallNames(message: JsonObject | null): string[] {
  if (!message) {
    return [];
  }
  const names = new Set<string>();
  const direct = objectValue(message.toolCall) ?? objectValue(message.tool_call);
  const directName = stringValue(direct?.name) ?? stringValue(direct?.toolName);
  if (directName) {
    names.add(directName);
  }
  const content = message.content;
  if (Array.isArray(content)) {
    for (const part of content) {
      const block = objectValue(part);
      if (!block) {
        continue;
      }
      const blockType = stringValue(block.type)?.toLowerCase();
      if (blockType === "toolcall" || blockType === "tool_call") {
        const name = stringValue(block.name) ?? stringValue(block.toolName);
        if (name) {
          names.add(name);
        }
      }
    }
  }
  return [...names];
}

function summarizeTitle(text: string | null): string | null {
  if (!text) {
    return null;
  }
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= 60 ? normalized : `${normalized.slice(0, 57)}...`;
}
