import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AgentThreadRecord } from "./agent.js";

export interface PiSessionRecord extends AgentThreadRecord {
  agentId: "pi";
  sessionPath: string;
  messageCount: number;
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

function summarizeTitle(text: string | null): string | null {
  if (!text) {
    return null;
  }
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= 60 ? normalized : `${normalized.slice(0, 57)}...`;
}
