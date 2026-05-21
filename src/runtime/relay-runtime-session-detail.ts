import {
  agentLabel,
  isAgentId,
  type AgentActivityEvent,
  type AgentExternalSnapshot,
  type AgentId,
  type AgentSessionInfo,
  type AgentSessionService,
  type AgentThreadRecord,
} from "../agents/shared/agent.js";
import { getExternalSnapshotForSession } from "../agents/shared/agent-activity.js";
import { renderSessionUsageRows } from "../channels/shared/session-format.js";
import type {
  WebActivityCategory,
  WebActivityEvent,
  WebActivityStatus,
  WebChatMessage,
} from "../web/web-state.js";
import type { RelayRuntimeDelegate } from "./relay-runtime-delegate.js";

export async function relayRuntimeSessionDetail(
  runtime: RelayRuntimeDelegate,
  threadId: string,
  agentId?: AgentId,
): Promise<Record<string, unknown>> {
  const target = await sessionDetailTarget(runtime, threadId, agentId);
  const snapshot = target.stub
    ? getExternalSnapshotForSession(target.stub, runtime.config, { maxEvents: 100 })
    : null;
  const messages = mergeSessionDetailMessages(
    runtime.chatStore.list(threadId, 100),
    externalSnapshotMessages(snapshot, threadId),
  );
  const activity = mergeSessionDetailActivity(
    runtime.activity({ limit: 100, threadId }),
    externalSnapshotActivity(snapshot, target.active, target.record),
  );

  return {
    record: target.record,
    active: target.active,
    usageRows: target.active.threadId === threadId ? renderSessionUsageRows(target.active) : [],
    messages,
    activity,
  };
}

async function sessionDetailTarget(
  runtime: RelayRuntimeDelegate,
  threadId: string,
  requestedAgentId?: AgentId,
): Promise<{
  record: AgentThreadRecord | null;
  active: AgentSessionInfo;
  stub: AgentSessionService | null;
}> {
  const current = await runtime.getSession(true);
  let active = runtime.publicInfo(current, { includeUsage: true });
  let agentId = requestedAgentId ?? active.agentId;
  let record = active.agentId === agentId ? current.getSessionRecord(threadId) : null;

  if (!record && !requestedAgentId) {
    const activeMatch = (await runtime.activeSessions()).sessions.find((session) =>
      session.threadId === threadId && isAgentId(session.agentId),
    );
    if (activeMatch && isAgentId(activeMatch.agentId)) {
      agentId = activeMatch.agentId;
    }
  }

  if (agentId !== active.agentId || !record) {
    const { session, dispose } = await runtime.getControlSession(agentId);
    try {
      active = runtime.publicInfo(session, { includeUsage: true });
      record = session.getSessionRecord(threadId);
    } finally {
      if (dispose) {
        session.dispose();
      }
    }
  }

  const fallbackActive = await sessionDetailActiveFallback(runtime, threadId, agentId, record, active);
  const stub = sessionDetailStub(runtime, threadId, agentId, record, fallbackActive);
  return {
    record,
    active: fallbackActive,
    stub,
  };
}

async function sessionDetailActiveFallback(
  runtime: RelayRuntimeDelegate,
  threadId: string,
  agentId: AgentId,
  record: AgentThreadRecord | null,
  active: AgentSessionInfo,
): Promise<AgentSessionInfo> {
  if (active.threadId === threadId) {
    return active;
  }
  const activeMatch = (await runtime.activeSessions()).sessions.find((session) =>
    session.threadId === threadId && (session.agentId ?? agentId) === agentId,
  );
  return {
    ...active,
    agentId,
    agentLabel: agentLabel(agentId),
    threadId,
    workspace: record?.cwd ?? activeMatch?.workspace ?? active.workspace,
    model: record?.model ?? active.model,
    reasoningEffort: record?.reasoningEffort ?? active.reasoningEffort,
    sessionPath: record?.sessionPath ?? active.sessionPath,
    workspaceMode: record?.workspaceMode ?? active.workspaceMode,
    worktree: record?.worktree ?? active.worktree,
    capabilities: runtime.capabilitiesForAgent(agentId),
  };
}

function sessionDetailStub(
  runtime: RelayRuntimeDelegate,
  threadId: string,
  agentId: AgentId,
  record: AgentThreadRecord | null,
  active: AgentSessionInfo,
): AgentSessionService | null {
  const capabilities = runtime.capabilitiesForAgent(agentId);
  if (!capabilities.externalActivity) {
    return null;
  }
  return runtime.sessionStubForMetadata({
    contextKey: `detail:${agentId}:${threadId}`,
    agentId,
    threadId,
    workspace: record?.cwd ?? active.workspace ?? runtime.config.workspace,
    workspaceMode: record?.workspaceMode ?? active.workspaceMode ?? "attached",
    worktreeId: record?.worktree?.id ?? active.worktree?.id,
    model: record?.model ?? active.model,
    reasoningEffort: record?.reasoningEffort ?? active.reasoningEffort,
    launchProfileId: active.nextLaunchProfileId ?? active.launchProfileId,
    sessionPath: record?.sessionPath ?? active.sessionPath,
    updatedAt: record ? sessionUpdatedAtMs(record) : Date.now(),
  }, agentId, capabilities);
}

function externalSnapshotMessages(snapshot: AgentExternalSnapshot | null, threadId: string): WebChatMessage[] {
  if (!snapshot) {
    return [];
  }
  const messages = snapshot.events
    .filter((event) => (event.kind === "user" || event.kind === "agent") && Boolean(event.text?.trim()))
    .map((event) => externalMessageFromEvent(snapshot, threadId, event));
  if (messages.length === 0) {
    if (snapshot.latestUserMessage?.trim()) {
      messages.push(externalMessageFromText(snapshot, threadId, "user", snapshot.latestUserMessage));
    }
    if (snapshot.latestAgentMessage?.trim()) {
      messages.push(externalMessageFromText(snapshot, threadId, "agent", snapshot.latestAgentMessage));
    }
  }
  return messages;
}

function externalMessageFromEvent(snapshot: AgentExternalSnapshot, threadId: string, event: AgentActivityEvent): WebChatMessage {
  return {
    id: `external:${snapshot.agentId}:${threadId}:message:${event.lineNumber}`,
    threadId,
    role: event.kind === "user" ? "user" : "agent",
    text: event.text ?? "",
    timestamp: sessionDetailTimestamp(event.timestamp ?? snapshot.activity.updatedAt),
    source: "cli",
    turnId: event.turnId ?? undefined,
    key: `external:${snapshot.sourcePath}:${event.lineNumber}`,
  };
}

function externalMessageFromText(snapshot: AgentExternalSnapshot, threadId: string, role: WebChatMessage["role"], text: string): WebChatMessage {
  return {
    id: `external:${snapshot.agentId}:${threadId}:latest:${role}`,
    threadId,
    role,
    text,
    timestamp: sessionDetailTimestamp(snapshot.activity.updatedAt),
    source: "cli",
    turnId: snapshot.activity.turnId ?? undefined,
    key: `external:${snapshot.sourcePath}:latest:${role}`,
  };
}

function externalSnapshotActivity(
  snapshot: AgentExternalSnapshot | null,
  active: AgentSessionInfo,
  record: AgentThreadRecord | null,
): WebActivityEvent[] {
  if (!snapshot) {
    return [];
  }
  return snapshot.events.map((event) => {
    const status = sessionDetailActivityStatus(event, snapshot);
    return {
      id: `external:${snapshot.agentId}:${snapshot.threadId}:activity:${event.lineNumber}`,
      timestamp: sessionDetailTimestamp(event.timestamp ?? snapshot.activity.updatedAt),
      source: "cli",
      status,
      type: event.type || event.kind,
      category: sessionDetailActivityCategory(event),
      threadId: snapshot.threadId,
      workspace: record?.cwd ?? active.workspace,
      agentId: snapshot.agentId,
      prompt: event.kind === "user" ? event.text ?? undefined : undefined,
      detail: sessionDetailActivityDetail(event, snapshot),
    };
  });
}

function sessionDetailActivityStatus(event: AgentActivityEvent, snapshot: AgentExternalSnapshot): WebActivityStatus {
  if (event.status === "aborted" || event.status === "failed" || event.status === "completed" || event.status === "queued" || event.status === "running") {
    return event.status;
  }
  if (event.kind === "task" && snapshot.activity.active) {
    return "running";
  }
  return "info";
}

function sessionDetailActivityCategory(event: AgentActivityEvent): WebActivityCategory {
  if (event.kind === "approval") {
    return "security";
  }
  if (event.kind === "tool") {
    return "tool";
  }
  if (event.kind === "user") {
    return "prompt";
  }
  return "session";
}

function sessionDetailActivityDetail(event: AgentActivityEvent, snapshot: AgentExternalSnapshot): string {
  return event.text?.trim()
    || event.approval?.reason?.trim()
    || event.approval?.command?.trim()
    || event.toolName?.trim()
    || event.phase?.trim()
    || snapshot.latestToolName
    || "";
}

function mergeSessionDetailMessages(webMessages: WebChatMessage[], externalMessages: WebChatMessage[]): WebChatMessage[] {
  return dedupeSessionDetailRows([...webMessages, ...externalMessages], (message) =>
    [message.role, message.timestamp, normalizeSessionDetailText(message.text)].join("\0"),
  ).sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp)).slice(-100);
}

function mergeSessionDetailActivity(webActivity: WebActivityEvent[], externalActivity: WebActivityEvent[]): WebActivityEvent[] {
  return dedupeSessionDetailRows([...webActivity, ...externalActivity], (event) =>
    [event.source, event.type, event.status, event.timestamp, normalizeSessionDetailText(event.prompt ?? event.detail ?? "")].join("\0"),
  ).sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp)).slice(-100);
}

function dedupeSessionDetailRows<T>(items: T[], keyFor: (item: T) => string): T[] {
  const seen = new Set<string>();
  const output: T[] = [];
  for (const item of items) {
    const key = keyFor(item);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(item);
  }
  return output;
}

function normalizeSessionDetailText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function sessionDetailTimestamp(value: Date | string | null | undefined): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return new Date(parsed).toISOString();
    }
  }
  return new Date().toISOString();
}

function sessionUpdatedAtMs(record: AgentThreadRecord): number {
  const value = record.updatedAt instanceof Date ? record.updatedAt.getTime() : Date.parse(String(record.updatedAt));
  return Number.isFinite(value) ? value : 0;
}
