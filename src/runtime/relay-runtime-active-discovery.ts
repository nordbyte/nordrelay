import { existsSync, readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveClaudeCodeProjectsDir } from "../agents/claude-code/claude-code-state.js";
import { listThreads as listCodexThreads } from "../agents/codex/codex-state.js";
import { listHermesSessions } from "../agents/hermes/hermes-state.js";
import { listOpenClawSessions } from "../agents/openclaw/openclaw-state.js";
import { listPiSessions } from "../agents/pi/pi-state.js";
import { enabledAgents } from "../agents/shared/agent-factory.js";
import type { AgentId, AgentThreadRecord } from "../agents/shared/agent.js";
import { BotPreferencesStore } from "../state/bot-preferences.js";
import type { ContextMetadata } from "../state/session-registry.js";
import type { RelayRuntimeDelegate } from "./relay-runtime-delegate.js";
import type { ActiveSessionDto } from "./relay-runtime-types.js";

const ACTIVE_EXTERNAL_DISCOVERY_LIMIT = 200;
const LINUX_CLOCK_TICKS_PER_SECOND = 100;

export function relayRuntimeDiscoverActiveCodexSessions(runtime: RelayRuntimeDelegate, knownContexts: ContextMetadata[], preferences: BotPreferencesStore): ActiveSessionDto[] {
  if (!runtime.config.codexEnabled || !enabledAgents(runtime.config).includes("codex")) {
    return [];
  }

  const capabilities = runtime.capabilitiesForAgent("codex");
  if (!capabilities.externalActivity) {
    return [];
  }

  const active: ActiveSessionDto[] = [];
  const nowMs = Date.now();
  const staleAfterMs = runtime.config.codexExternalBusyStaleMs;
  for (const thread of listCodexThreads(ACTIVE_EXTERNAL_DISCOVERY_LIMIT)) {
    if (staleAfterMs > 0 && nowMs - thread.updatedAt.getTime() > staleAfterMs) {
      continue;
    }
    const meta: ContextMetadata = {
      contextKey: `cli:codex:${thread.id}`,
      agentId: "codex",
      threadId: thread.id,
      workspace: thread.cwd,
      model: thread.model ?? undefined,
      reasoningEffort: thread.reasoningEffort ?? undefined,
      updatedAt: thread.updatedAt.getTime(),
    };
    const session = runtime.externalActiveSession(meta, knownContexts, preferences);
    if (session) {
      active.push(session);
    }
  }
  active.push(...discoverActiveCodexExecProcesses());
  return active;
}

export function relayRuntimeDiscoverActivePiSessions(runtime: RelayRuntimeDelegate, knownContexts: ContextMetadata[], preferences: BotPreferencesStore): ActiveSessionDto[] {
  return relayRuntimeDiscoverActiveRecordedAgentSessions(
    runtime,
    "pi",
    listPiSessions(ACTIVE_EXTERNAL_DISCOVERY_LIMIT, { sessionDir: runtime.config.piSessionDir }),
    knownContexts,
    preferences,
  );
}

export function relayRuntimeDiscoverActiveHermesSessions(runtime: RelayRuntimeDelegate, knownContexts: ContextMetadata[], preferences: BotPreferencesStore): ActiveSessionDto[] {
  return relayRuntimeDiscoverActiveRecordedAgentSessions(
    runtime,
    "hermes",
    listHermesSessions(ACTIVE_EXTERNAL_DISCOVERY_LIMIT, {
      hermesHome: runtime.config.hermesHome,
      stateDbPath: runtime.config.hermesStateDbPath,
    }),
    knownContexts,
    preferences,
  );
}

export function relayRuntimeDiscoverActiveOpenClawSessions(runtime: RelayRuntimeDelegate, knownContexts: ContextMetadata[], preferences: BotPreferencesStore): ActiveSessionDto[] {
  return relayRuntimeDiscoverActiveRecordedAgentSessions(
    runtime,
    "openclaw",
    listOpenClawSessions(ACTIVE_EXTERNAL_DISCOVERY_LIMIT, {
      cliPath: runtime.config.openClawCliPath,
      openClawHome: runtime.config.openClawHome,
      stateDir: runtime.config.openClawStateDir,
      workspace: runtime.config.workspace,
      openClawAgentId: runtime.config.openClawAgentId,
      staleAfterMs: runtime.config.codexExternalBusyStaleMs,
      timeoutMs: 1_500,
    }),
    knownContexts,
    preferences,
  );
}

export function relayRuntimeDiscoverActiveClaudeCodeSessions(runtime: RelayRuntimeDelegate, knownContexts: ContextMetadata[], preferences: BotPreferencesStore): ActiveSessionDto[] {
  return relayRuntimeDiscoverActiveRecordedAgentSessions(
    runtime,
    "claude-code",
    listClaudeCodeSessionCandidates(ACTIVE_EXTERNAL_DISCOVERY_LIMIT, {
      configDir: runtime.config.claudeCodeConfigDir,
      staleAfterMs: runtime.config.codexExternalBusyStaleMs,
    }),
    knownContexts,
    preferences,
  );
}

export function relayRuntimeDiscoverActiveRecordedAgentSessions(
  runtime: RelayRuntimeDelegate,
  agentId: AgentId,
  records: AgentThreadRecord[],
  knownContexts: ContextMetadata[],
  preferences: BotPreferencesStore,
): ActiveSessionDto[] {
  if (!enabledAgents(runtime.config).includes(agentId)) {
    return [];
  }

  const capabilities = runtime.capabilitiesForAgent(agentId);
  if (!capabilities.externalActivity) {
    return [];
  }

  const active: ActiveSessionDto[] = [];
  const nowMs = Date.now();
  const staleAfterMs = runtime.config.codexExternalBusyStaleMs;
  for (const record of records) {
    if (staleAfterMs > 0 && nowMs - record.updatedAt.getTime() > staleAfterMs) {
      continue;
    }
    const meta: ContextMetadata = {
      contextKey: `cli:${agentId}:${record.id}`,
      agentId,
      threadId: record.id,
      workspace: record.cwd,
      model: record.model ?? undefined,
      reasoningEffort: record.reasoningEffort ?? undefined,
      sessionPath: sessionPathFromRecord(record),
      updatedAt: record.updatedAt.getTime(),
    };
    const session = runtime.externalActiveSession(meta, knownContexts, preferences);
    if (session) {
      active.push(session);
    }
  }
  return active;
}

function sessionPathFromRecord(record: AgentThreadRecord): string | undefined {
  const sessionPath = (record as { sessionPath?: unknown }).sessionPath;
  return typeof sessionPath === "string" && sessionPath.trim() ? sessionPath : undefined;
}

function discoverActiveCodexExecProcesses(): ActiveSessionDto[] {
  if (process.platform !== "linux" || !existsSync("/proc")) {
    return [];
  }

  const bootTimeMs = Date.now() - os.uptime() * 1000;
  const active: ActiveSessionDto[] = [];
  for (const pid of safeReadDir("/proc")) {
    if (!/^\d+$/.test(pid)) {
      continue;
    }
    const args = readCmdline(pid);
    if (!isCodexExecProcess(args)) {
      continue;
    }
    const startMs = processStartTimeMs(pid, bootTimeMs);
    const workspace = codexArgValue(args, "--cd") ?? safeReadlink(path.join("/proc", pid, "cwd")) ?? process.cwd();
    const model = codexArgValue(args, "--model");
    const reasoning = codexReasoningEffort(args);
    const startedAt = new Date(startMs ?? Date.now()).toISOString();
    const contextKey = `process:codex:${pid}`;
    const outputPath = codexArgValue(args, "--output-last-message");
    active.push({
      id: contextKey,
      contextKey,
      sourceContextKey: contextKey,
      source: "cli",
      status: "external",
      agentId: "codex",
      agentLabel: "Codex",
      threadId: null,
      workspace,
      prompt: "Codex exec",
      currentTool: "codex exec",
      lastTool: "codex exec",
      startedAt,
      updatedAt: new Date().toISOString(),
      durationMs: Math.max(0, Date.now() - Date.parse(startedAt)),
      queueLength: 0,
      queuePaused: false,
      detail: [
        model ? `Model: ${model}` : null,
        reasoning ? `Reasoning: ${reasoning}` : null,
        outputPath ? `Output: ${outputPath}` : null,
        `PID: ${pid}`,
      ].filter(Boolean).join(" | "),
    });
  }
  return active;
}

function isCodexExecProcess(args: string[]): boolean {
  if (args.length < 2) {
    return false;
  }
  const executable = path.basename(args[0] ?? "");
  return executable === "codex" && args[1] === "exec";
}

function codexArgValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  const value = index === -1 ? undefined : args[index + 1];
  return value?.trim() || undefined;
}

function codexReasoningEffort(args: string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--config") {
      continue;
    }
    const value = args[index + 1] ?? "";
    const match = value.match(/model_reasoning_effort="?([^"]+)"?/);
    if (match?.[1]) {
      return match[1];
    }
  }
  return undefined;
}

function readCmdline(pid: string): string[] {
  try {
    return readFileSync(path.join("/proc", pid, "cmdline"), "utf8")
      .split("\0")
      .filter(Boolean);
  } catch {
    return [];
  }
}

function processStartTimeMs(pid: string, bootTimeMs: number): number | null {
  try {
    const stat = readFileSync(path.join("/proc", pid, "stat"), "utf8");
    const endCommand = stat.lastIndexOf(")");
    const fields = stat.slice(endCommand + 2).trim().split(/\s+/);
    const startTicks = Number(fields[19]);
    return Number.isFinite(startTicks)
      ? bootTimeMs + (startTicks / LINUX_CLOCK_TICKS_PER_SECOND) * 1000
      : null;
  } catch {
    return null;
  }
}

function listClaudeCodeSessionCandidates(
  limit: number,
  options: { configDir?: string; staleAfterMs?: number } = {},
): AgentThreadRecord[] {
  const projectsDir = resolveClaudeCodeProjectsDir({ configDir: options.configDir });
  if (!existsSync(projectsDir)) {
    return [];
  }
  const nowMs = Date.now();
  const staleAfterMs = options.staleAfterMs ?? 0;
  const records: AgentThreadRecord[] = [];
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
      const fileStat = safeStat(sessionPath);
      if (!fileStat?.isFile()) {
        continue;
      }
      if (staleAfterMs > 0 && nowMs - fileStat.mtime.getTime() > staleAfterMs) {
        continue;
      }
      records.push({
        id: path.basename(fileName, ".jsonl"),
        title: null,
        cwd: decodeClaudeCodeProjectKey(projectKey),
        model: null,
        reasoningEffort: null,
        createdAt: fileStat.birthtimeMs > 0 ? fileStat.birthtime : fileStat.mtime,
        updatedAt: fileStat.mtime,
        firstUserMessage: null,
        agentId: "claude-code",
        sessionPath,
      });
    }
  }
  return records
    .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime())
    .slice(0, Math.max(1, limit));
}

function decodeClaudeCodeProjectKey(projectKey: string): string {
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

function safeReadlink(targetPath: string): string | undefined {
  try {
    return readlinkSync(targetPath);
  } catch {
    return undefined;
  }
}
