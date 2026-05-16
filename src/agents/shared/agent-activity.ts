import {
  CODEX_AGENT_CAPABILITIES,
  type AgentActivityEvent,
  type AgentDiagnostics,
  type AgentExternalActivity,
  type AgentExternalSnapshot,
  type AgentSessionService,
} from "./agent.js";
import {
  getThreadActivity,
  getThreadActivityLog,
  getThreadRolloutSnapshot,
  type CodexActivityEvent,
  type CodexRolloutSnapshot,
} from "../codex/codex-state.js";
import {
  getClaudeCodeSessionActivity,
  getClaudeCodeSessionActivityLog,
  getClaudeCodeSessionDiagnostics,
  getClaudeCodeSessionSnapshot,
} from "../claude-code/claude-code-state.js";
import type { ConnectorConfig } from "../../core/config.js";
import {
  getHermesSessionActivity,
  getHermesSessionActivityLog,
  getHermesSessionDiagnostics,
  getHermesSessionSnapshot,
} from "../hermes/hermes-state.js";
import {
  getOpenClawSessionActivity,
  getOpenClawSessionActivityLog,
  getOpenClawSessionDiagnostics,
  getOpenClawSessionSnapshot,
} from "../openclaw/openclaw-state.js";
import {
  getPiSessionActivity,
  getPiSessionActivityLog,
  getPiSessionDiagnostics,
  getPiSessionSnapshot,
} from "../pi/pi-state.js";

export function getExternalActivityForSession(
  session: AgentSessionService | undefined,
  config: ConnectorConfig,
): AgentExternalActivity | null {
  const info = session?.getInfo();
  if (!info || !(info.capabilities ?? CODEX_AGENT_CAPABILITIES).externalActivity) {
    return null;
  }
  const threadId = session?.getActiveThreadId();
  if (!threadId) {
    return null;
  }

  if (info.agentId === "pi") {
    return getPiSessionActivity(info.sessionPath ?? threadId, {
      sessionDir: config.piSessionDir,
      staleAfterMs: config.codexExternalBusyStaleMs,
    });
  }
  if (info.agentId === "hermes") {
    return getHermesSessionActivity(threadId, {
      hermesHome: config.hermesHome,
      stateDbPath: config.hermesStateDbPath,
      workspace: info.workspace,
      staleAfterMs: config.codexExternalBusyStaleMs,
    });
  }
  if (info.agentId === "openclaw") {
    return getOpenClawSessionActivity(threadId, {
      cliPath: config.openClawCliPath,
      openClawHome: config.openClawHome,
      stateDir: config.openClawStateDir,
      workspace: info.workspace,
      openClawAgentId: config.openClawAgentId,
      staleAfterMs: config.codexExternalBusyStaleMs,
    });
  }
  if (info.agentId === "claude-code") {
    return getClaudeCodeSessionActivity(threadId, {
      configDir: config.claudeCodeConfigDir,
      workspace: info.workspace,
      staleAfterMs: config.codexExternalBusyStaleMs,
    });
  }

  const activity = getThreadActivity(threadId, {
    staleAfterMs: config.codexExternalBusyStaleMs,
  });
  if (!activity) {
    return null;
  }
  return {
    agentId: "codex",
    agentLabel: "Codex",
    threadId: activity.threadId,
    sourcePath: activity.rolloutPath,
    sourceLabel: "Codex rollout",
    active: activity.active,
    stale: activity.stale,
    turnId: activity.turnId,
    startedAt: activity.startedAt,
    updatedAt: activity.updatedAt,
  };
}

export function getExternalSnapshotForSession(
  session: AgentSessionService,
  config: ConnectorConfig,
  options: { afterLine?: number; maxEvents?: number } = {},
): AgentExternalSnapshot | null {
  const info = session.getInfo();
  const threadId = session.getActiveThreadId();
  if (!(info.capabilities ?? CODEX_AGENT_CAPABILITIES).externalActivity || !threadId) {
    return null;
  }

  if (info.agentId === "pi") {
    return getPiSessionSnapshot(info.sessionPath ?? threadId, {
      sessionDir: config.piSessionDir,
      afterLine: options.afterLine,
      maxEvents: options.maxEvents,
      staleAfterMs: config.codexExternalBusyStaleMs,
    });
  }
  if (info.agentId === "hermes") {
    return getHermesSessionSnapshot(threadId, {
      hermesHome: config.hermesHome,
      stateDbPath: config.hermesStateDbPath,
      workspace: info.workspace,
      afterLine: options.afterLine,
      maxEvents: options.maxEvents,
      staleAfterMs: config.codexExternalBusyStaleMs,
    });
  }
  if (info.agentId === "openclaw") {
    return getOpenClawSessionSnapshot(threadId, {
      cliPath: config.openClawCliPath,
      openClawHome: config.openClawHome,
      stateDir: config.openClawStateDir,
      workspace: info.workspace,
      openClawAgentId: config.openClawAgentId,
      afterLine: options.afterLine,
      maxEvents: options.maxEvents,
      staleAfterMs: config.codexExternalBusyStaleMs,
    });
  }
  if (info.agentId === "claude-code") {
    return getClaudeCodeSessionSnapshot(threadId, {
      configDir: config.claudeCodeConfigDir,
      workspace: info.workspace,
      afterLine: options.afterLine,
      maxEvents: options.maxEvents,
      staleAfterMs: config.codexExternalBusyStaleMs,
    });
  }

  const snapshot = getThreadRolloutSnapshot(threadId, {
    afterLine: options.afterLine,
    maxEvents: options.maxEvents,
    staleAfterMs: config.codexExternalBusyStaleMs,
  });
  return snapshot ? codexSnapshotToAgentSnapshot(snapshot) : null;
}

export function getAgentActivityLog(
  session: AgentSessionService,
  config: ConnectorConfig,
  limit: number,
): AgentActivityEvent[] {
  const info = session.getInfo();
  const threadId = session.getActiveThreadId();
  if (!threadId) {
    return [];
  }
  if (info.agentId === "pi") {
    return getPiSessionActivityLog(info.sessionPath ?? threadId, limit, { sessionDir: config.piSessionDir });
  }
  if (info.agentId === "hermes") {
    return getHermesSessionActivityLog(threadId, limit, {
      hermesHome: config.hermesHome,
      stateDbPath: config.hermesStateDbPath,
      workspace: info.workspace,
    });
  }
  if (info.agentId === "openclaw") {
    return getOpenClawSessionActivityLog(threadId, limit, {
      cliPath: config.openClawCliPath,
      openClawHome: config.openClawHome,
      stateDir: config.openClawStateDir,
      workspace: info.workspace,
      openClawAgentId: config.openClawAgentId,
    });
  }
  if (info.agentId === "claude-code") {
    return getClaudeCodeSessionActivityLog(threadId, limit, {
      configDir: config.claudeCodeConfigDir,
      workspace: info.workspace,
    });
  }
  return getThreadActivityLog(threadId, limit).map(codexEventToAgentEvent);
}

export function getAgentDiagnostics(
  session: AgentSessionService,
  config: ConnectorConfig,
): AgentDiagnostics {
  const info = session.getInfo();
  if (info.agentId === "pi") {
    const diagnostics = getPiSessionDiagnostics(info.sessionPath ?? info.threadId, {
      sessionDir: config.piSessionDir,
      staleAfterMs: config.codexExternalBusyStaleMs,
    });
    return {
      agentId: "pi",
      agentLabel: "Pi",
      lines: [
        { label: "Pi session dir", value: diagnostics.sessionDir },
        { label: "Pi session file", value: diagnostics.sessionPath ?? "-" },
        { label: "Pi session status", value: diagnostics.status },
        { label: "Pi status reason", value: diagnostics.reason },
        { label: "Pi JSONL lines", value: String(diagnostics.lineCount) },
        { label: "Pi updated", value: diagnostics.updatedAt?.toISOString() ?? "-" },
        { label: "Pi RPC active", value: session.isProcessing() ? "yes" : "idle" },
      ],
    };
  }
  if (info.agentId === "hermes") {
    const diagnostics = getHermesSessionDiagnostics(info.threadId, {
      hermesHome: config.hermesHome,
      stateDbPath: config.hermesStateDbPath,
      workspace: info.workspace,
      staleAfterMs: config.codexExternalBusyStaleMs,
    });
    return {
      agentId: "hermes",
      agentLabel: "Hermes",
      lines: [
        { label: "Hermes API", value: config.hermesApiBaseUrl },
        { label: "Hermes state DB", value: diagnostics.stateDbPath },
        { label: "Hermes session status", value: diagnostics.status },
        { label: "Hermes status reason", value: diagnostics.reason },
        { label: "Hermes messages", value: String(diagnostics.lineCount) },
        { label: "Hermes updated", value: diagnostics.updatedAt?.toISOString() ?? "-" },
        { label: "Hermes API run active", value: session.isProcessing() ? "yes" : "idle" },
      ],
    };
  }
  if (info.agentId === "openclaw") {
    const diagnostics = getOpenClawSessionDiagnostics(info.threadId, {
      cliPath: config.openClawCliPath,
      openClawHome: config.openClawHome,
      stateDir: config.openClawStateDir,
      workspace: info.workspace,
      openClawAgentId: config.openClawAgentId,
      staleAfterMs: config.codexExternalBusyStaleMs,
    });
    return {
      agentId: "openclaw",
      agentLabel: "OpenClaw",
      lines: [
        { label: "OpenClaw Gateway", value: config.openClawGatewayUrl },
        { label: "OpenClaw sessions", value: diagnostics.sourcePath },
        { label: "OpenClaw session status", value: diagnostics.status },
        { label: "OpenClaw status reason", value: diagnostics.reason },
        { label: "OpenClaw events", value: String(diagnostics.lineCount) },
        { label: "OpenClaw updated", value: diagnostics.updatedAt?.toISOString() ?? "-" },
        { label: "OpenClaw Gateway run active", value: session.isProcessing() ? "yes" : "idle" },
      ],
    };
  }
  if (info.agentId === "claude-code") {
    const diagnostics = getClaudeCodeSessionDiagnostics(info.threadId, {
      configDir: config.claudeCodeConfigDir,
      workspace: info.workspace,
      staleAfterMs: config.codexExternalBusyStaleMs,
    });
    return {
      agentId: "claude-code",
      agentLabel: "Claude Code",
      lines: [
        { label: "Claude projects dir", value: diagnostics.projectsDir },
        { label: "Claude session file", value: diagnostics.sessionPath ?? "-" },
        { label: "Claude session status", value: diagnostics.status },
        { label: "Claude status reason", value: diagnostics.reason },
        { label: "Claude JSONL lines", value: String(diagnostics.lineCount) },
        { label: "Claude updated", value: diagnostics.updatedAt?.toISOString() ?? "-" },
        { label: "Claude SDK run active", value: session.isProcessing() ? "yes" : "idle" },
      ],
    };
  }

  const snapshot = info.threadId
    ? getThreadRolloutSnapshot(info.threadId, { staleAfterMs: config.codexExternalBusyStaleMs, maxEvents: 0 })
    : null;
  const status = !info.threadId ? "unavailable" : snapshot?.activity.active ? "active" : snapshot?.activity.stale ? "stale" : snapshot ? "idle" : "unavailable";
  const reason = !info.threadId
    ? "no active thread"
    : snapshot?.activity.active
      ? "open task without terminal event"
      : snapshot?.activity.stale
        ? "open task exceeded stale timeout"
        : snapshot
          ? "no open task"
          : "rollout unavailable";
  return {
    agentId: "codex",
    agentLabel: "Codex",
    lines: [
      { label: "Rollout path", value: snapshot?.rolloutPath ?? "-" },
      { label: "Rollout status", value: status },
      { label: "Rollout reason", value: reason },
      { label: "Rollout turn", value: snapshot?.activity.turnId ?? "-" },
      { label: "Rollout lines", value: String(snapshot?.lineCount ?? 0) },
      { label: "Rollout updated", value: snapshot?.activity.updatedAt?.toISOString() ?? "-" },
    ],
  };
}

function codexSnapshotToAgentSnapshot(snapshot: CodexRolloutSnapshot): AgentExternalSnapshot {
  return {
    agentId: "codex",
    agentLabel: "Codex",
    threadId: snapshot.threadId,
    sourcePath: snapshot.rolloutPath,
    sourceLabel: "Codex rollout",
    lineCount: snapshot.lineCount,
    activity: {
      agentId: "codex",
      agentLabel: "Codex",
      threadId: snapshot.threadId,
      sourcePath: snapshot.rolloutPath,
      sourceLabel: "Codex rollout",
      active: snapshot.activity.active,
      stale: snapshot.activity.stale,
      turnId: snapshot.activity.turnId,
      startedAt: snapshot.activity.startedAt,
      updatedAt: snapshot.activity.updatedAt,
    },
    events: snapshot.events.map(codexEventToAgentEvent),
    latestAgentMessage: snapshot.latestAgentMessage,
    latestUserMessage: snapshot.latestUserMessage,
    latestToolName: snapshot.latestToolName,
  };
}

function codexEventToAgentEvent(event: CodexActivityEvent): AgentActivityEvent {
  return {
    lineNumber: event.lineNumber,
    kind: event.kind,
    timestamp: event.timestamp,
    type: event.type,
    turnId: event.turnId,
    status: event.status,
    text: event.text,
    toolName: event.toolName,
    phase: event.phase,
  };
}
