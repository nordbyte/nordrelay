import { listClaudeCodeSessions } from "../agents/claude-code/claude-code-state.js";
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
    }),
    knownContexts,
    preferences,
  );
}

export function relayRuntimeDiscoverActiveClaudeCodeSessions(runtime: RelayRuntimeDelegate, knownContexts: ContextMetadata[], preferences: BotPreferencesStore): ActiveSessionDto[] {
  return relayRuntimeDiscoverActiveRecordedAgentSessions(
    runtime,
    "claude-code",
    listClaudeCodeSessions(ACTIVE_EXTERNAL_DISCOVERY_LIMIT, {
      configDir: runtime.config.claudeCodeConfigDir,
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
