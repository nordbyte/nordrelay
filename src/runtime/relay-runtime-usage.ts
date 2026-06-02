import { getThreadUsage } from "../agents/codex/codex-state.js";
import {
  type AgentId,
  type AgentSessionInfo,
  type AgentSessionUsage,
  type AgentThreadRecord,
} from "../agents/shared/agent.js";
import { enabledAgents } from "../agents/shared/agent-factory.js";
import type { PluginUsageSession, PluginUsageSnapshot, PluginUsageTokenUsage } from "../plugins/plugin-types.js";
import type { RelayRuntime } from "./relay-runtime.js";

const MAX_USAGE_SESSIONS_PER_AGENT = 1_000;

export async function buildRuntimeUsageSnapshot(runtime: RelayRuntime): Promise<PluginUsageSnapshot> {
  const sessions: PluginUsageSession[] = [];
  const now = new Date().toISOString();
  for (const agentId of enabledAgents(runtime.config)) {
    const { session, dispose } = await runtime.getControlSession(agentId);
    try {
      const info = runtime.publicInfo(session, { includeUsage: true });
      for (const record of session.listAllSessions(MAX_USAGE_SESSIONS_PER_AGENT)) {
        const usage = usageSessionFromRecord(runtime, info, record, agentId);
        if (usage) {
          sessions.push(usage);
        }
      }
      const active = usageSessionFromInfo(runtime, info);
      if (active) {
        upsertUsageSession(sessions, active);
      }
    } catch {
      // Usage snapshots are best-effort. A disabled/misconfigured agent should
      // not prevent other agents or peers from reporting usage.
    } finally {
      if (dispose) {
        session.dispose();
      }
    }
  }
  return {
    generatedAt: now,
    node: {
      id: "local",
      name: runtime.config.peerName ?? "Local node",
      platform: process.platform,
      workspace: runtime.config.workspace,
    },
    sessions: sessions.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)),
  };
}

function usageSessionFromRecord(
  runtime: RelayRuntime,
  info: AgentSessionInfo,
  record: AgentThreadRecord,
  fallbackAgentId: AgentId,
): PluginUsageSession | null {
  const agentId = record.agentId ?? fallbackAgentId;
  const rawUsage = agentId === "codex"
    ? codexUsage(record.id)
    : agentUsage((record as AgentThreadRecord & { usage?: AgentSessionUsage }).usage);
  if (!rawUsage || rawUsage.totalTokens <= 0) {
    return null;
  }
  const model = record.model ?? info.model ?? null;
  return {
    nodeId: "local",
    nodeName: runtime.config.peerName ?? "Local node",
    platform: process.platform,
    agentId,
    agentLabel: info.agentId === agentId ? info.agentLabel : agentLabelFromId(agentId),
    provider: providerFor(agentId, model),
    model,
    threadId: record.id,
    sessionName: runtime.sessionNameStore.get(agentId, record.id)?.name ?? record.sessionName,
    workspace: record.cwd,
    sessionPath: record.sessionPath,
    source: "cli",
    createdAt: dateToIso(record.createdAt),
    updatedAt: dateToIso(record.updatedAt),
    usage: rawUsage,
    costUsd: (record as AgentThreadRecord & { usage?: AgentSessionUsage }).usage?.cost,
    confidence: "reported",
  };
}

function usageSessionFromInfo(runtime: RelayRuntime, info: AgentSessionInfo): PluginUsageSession | null {
  if (!info.threadId) {
    return null;
  }
  const usage = info.codexUsage
    ? codexUsageFromInfo(info)
    : agentUsage(info.sessionUsage) ?? sessionTokensUsage(info.sessionTokens);
  if (!usage || usage.totalTokens <= 0) {
    return null;
  }
  return {
    nodeId: "local",
    nodeName: runtime.config.peerName ?? "Local node",
    platform: process.platform,
    agentId: info.agentId,
    agentLabel: info.agentLabel,
    provider: providerFor(info.agentId, info.model ?? null),
    model: info.model ?? null,
    threadId: info.threadId,
    sessionName: runtime.sessionNameStore.get(info.agentId, info.threadId)?.name ?? info.sessionName,
    workspace: info.workspace,
    sessionPath: info.sessionPath,
    source: "web",
    createdAt: new Date().toISOString(),
    updatedAt: usageUpdatedAt(info),
    usage,
    costUsd: info.sessionUsage?.cost,
    confidence: info.codexUsage ? "exact" : "reported",
  };
}

function codexUsage(threadId: string): PluginUsageTokenUsage | null {
  const usage = getThreadUsage(threadId);
  const total = usage?.totalTokenUsage;
  if (!total) {
    return null;
  }
  return {
    inputTokens: Math.max(0, total.inputTokens - total.cachedInputTokens),
    cachedInputTokens: total.cachedInputTokens,
    cacheWriteTokens: 0,
    outputTokens: total.outputTokens,
    reasoningOutputTokens: total.reasoningOutputTokens,
    totalTokens: total.totalTokens,
  };
}

function codexUsageFromInfo(info: AgentSessionInfo): PluginUsageTokenUsage | null {
  const total = info.codexUsage?.totalTokenUsage;
  if (!total) {
    return null;
  }
  return {
    inputTokens: Math.max(0, total.inputTokens - total.cachedInputTokens),
    cachedInputTokens: total.cachedInputTokens,
    cacheWriteTokens: 0,
    outputTokens: total.outputTokens,
    reasoningOutputTokens: total.reasoningOutputTokens,
    totalTokens: total.totalTokens,
  };
}

function agentUsage(usage: (AgentSessionUsage & { reasoningOutput?: number }) | undefined): PluginUsageTokenUsage | null {
  if (!usage) {
    return null;
  }
  const reasoningOutputTokens = normalizedNumber(usage.reasoningOutput);
  const inputTokens = normalizedNumber(usage.input);
  const cachedInputTokens = normalizedNumber(usage.cacheRead);
  const cacheWriteTokens = normalizedNumber(usage.cacheWrite);
  const outputTokens = normalizedNumber(usage.output);
  const totalTokens = normalizedNumber(usage.total) || inputTokens + cachedInputTokens + cacheWriteTokens + outputTokens + reasoningOutputTokens;
  return totalTokens > 0
    ? { inputTokens, cachedInputTokens, cacheWriteTokens, outputTokens, reasoningOutputTokens, totalTokens }
    : null;
}

function sessionTokensUsage(tokens: AgentSessionInfo["sessionTokens"]): PluginUsageTokenUsage | null {
  if (!tokens) {
    return null;
  }
  const inputTokens = normalizedNumber(tokens.input) - normalizedNumber(tokens.cached);
  const cachedInputTokens = normalizedNumber(tokens.cached);
  const outputTokens = normalizedNumber(tokens.output);
  const totalTokens = Math.max(0, inputTokens) + cachedInputTokens + outputTokens;
  return totalTokens > 0
    ? { inputTokens: Math.max(0, inputTokens), cachedInputTokens, cacheWriteTokens: 0, outputTokens, reasoningOutputTokens: 0, totalTokens }
    : null;
}

function upsertUsageSession(sessions: PluginUsageSession[], next: PluginUsageSession): void {
  const index = sessions.findIndex((session) => session.agentId === next.agentId && session.threadId === next.threadId);
  if (index === -1) {
    sessions.push(next);
    return;
  }
  sessions[index] = Date.parse(next.updatedAt) >= Date.parse(sessions[index].updatedAt) ? next : sessions[index];
}

function providerFor(agentId: AgentId, model: string | null | undefined): string {
  const normalized = String(model ?? "").trim();
  if (normalized.includes("/")) {
    return normalized.split("/")[0] || agentId;
  }
  if (agentId === "claude-code") return "anthropic";
  if (agentId === "codex") return "openai";
  return agentId;
}

function agentLabelFromId(agentId: AgentId): string {
  if (agentId === "pi") return "Pi";
  if (agentId === "hermes") return "Hermes";
  if (agentId === "openclaw") return "OpenClaw";
  if (agentId === "claude-code") return "Claude Code";
  return "Codex";
}

function usageUpdatedAt(info: AgentSessionInfo): string {
  const updatedAt = info.codexUsage?.updatedAt;
  if (updatedAt instanceof Date && Number.isFinite(updatedAt.getTime())) {
    return updatedAt.toISOString();
  }
  return new Date().toISOString();
}

function dateToIso(value: Date | string | number): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

function normalizedNumber(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}
