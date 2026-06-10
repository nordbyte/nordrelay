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
import { MAX_SESSION_NAME_LENGTH, sanitizeSessionName } from "../state/session-names.js";
import { isExternalSnapshotSuppressedByManagedAbort } from "./relay-runtime-helpers.js";
import type {
  WebActivityCategory,
  WebActivityActor,
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
  const rawSnapshot = target.stub
    ? getExternalSnapshotForSession(target.stub, runtime.config, { maxEvents: 100 })
    : null;
  const snapshot = isExternalSnapshotSuppressedByManagedAbort(rawSnapshot, runtime.activity({ limit: 50, threadId }))
    ? null
    : rawSnapshot;
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
    sessionName: runtime.sessionNameStore.get(target.active.agentId, threadId)?.name ?? "",
    usageRows: target.active.threadId === threadId ? renderSessionUsageRows(target.active) : [],
    messages,
    activity,
  };
}

export async function relayRuntimeSetSessionName(
  runtime: RelayRuntimeDelegate,
  threadId: string,
  rawName: string,
  agentId?: AgentId,
  actor?: WebActivityActor,
): Promise<Record<string, unknown>> {
  const name = sanitizeSessionName(rawName);
  const normalizedRawName = rawName.replace(/\s+/g, " ").trim();
  if (normalizedRawName.length > MAX_SESSION_NAME_LENGTH) {
    throw new Error(`Session name must be ${MAX_SESSION_NAME_LENGTH} characters or fewer.`);
  }
  const target = await sessionDetailTarget(runtime, threadId, agentId);
  const resolvedAgentId = target.active.agentId;
  runtime.sessionNameStore.set(resolvedAgentId, threadId, name);
  runtime.appendActivity({
    source: "web",
    status: "info",
    type: name ? "session_name_set" : "session_name_cleared",
    category: "session",
    threadId,
    workspace: target.record?.cwd ?? target.active.workspace,
    agentId: resolvedAgentId,
    actor,
    detail: name || "Session name cleared.",
  });
  runtime.appendAudit({
    action: "command",
    category: "session",
    status: "ok",
    contextKey: runtime.contextKey,
    actor,
    threadId,
    workspace: target.record?.cwd ?? target.active.workspace,
    agentId: resolvedAgentId,
    description: name ? "Session name set" : "Session name cleared",
    detail: name || "cleared",
  });
  runtime.scheduleActiveSessionsBroadcast();
  return relayRuntimeSessionDetail(runtime, threadId, resolvedAgentId);
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

export function externalSnapshotMessages(snapshot: AgentExternalSnapshot | null, threadId: string): WebChatMessage[] {
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

export function mergeSessionDetailMessages(webMessages: WebChatMessage[], externalMessages: WebChatMessage[], limit = 100): WebChatMessage[] {
  return dedupeSessionDetailMessages([...webMessages, ...externalMessages])
    .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp))
    .slice(-Math.max(1, limit));
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

function dedupeSessionDetailMessages(items: WebChatMessage[]): WebChatMessage[] {
  const output: WebChatMessage[] = [];
  for (const item of items) {
    const existingIndex = output.findIndex((existing) => isDuplicateSessionDetailMessage(existing, item));
    if (existingIndex >= 0) {
      output[existingIndex] = preferredSessionDetailMessage(output[existingIndex]!, item);
      continue;
    }
    output.push(item);
  }
  return output;
}

function preferredSessionDetailMessage(left: WebChatMessage, right: WebChatMessage): WebChatMessage {
  if (isCliWorkingPromptDuplicate(left, right)) {
    return isCliWorkingPromptMessage(left) ? right : left;
  }
  return left;
}

function isDuplicateSessionDetailMessage(left: WebChatMessage, right: WebChatMessage): boolean {
  if (left === right) {
    return true;
  }
  if (isCliWorkingPromptDuplicate(left, right)) {
    return true;
  }
  const leftText = normalizeSessionDetailText(left.text);
  const rightText = normalizeSessionDetailText(right.text);
  if (!leftText || leftText !== rightText || left.role !== right.role) {
    return false;
  }
  if (left.key && right.key && left.key === right.key) {
    return true;
  }
  if (left.turnId && right.turnId && left.turnId === right.turnId) {
    return true;
  }
  if (sessionDetailTimestamp(left.timestamp) === sessionDetailTimestamp(right.timestamp)) {
    return true;
  }
  const differentSources = left.source && right.source && left.source !== right.source;
  if (differentSources && Math.abs(Date.parse(left.timestamp) - Date.parse(right.timestamp)) <= 10 * 60 * 1000) {
    return true;
  }
  return false;
}

function isCliWorkingPromptDuplicate(left: WebChatMessage, right: WebChatMessage): boolean {
  const leftPrompt = cliWorkingPromptText(left);
  const rightPrompt = cliWorkingPromptText(right);
  if (!leftPrompt && !rightPrompt) {
    return false;
  }
  const working = leftPrompt ? left : right;
  const user = leftPrompt ? right : left;
  const prompt = leftPrompt || rightPrompt;
  if (!prompt || working.threadId !== user.threadId || user.role !== "user" || user.source !== "cli") {
    return false;
  }
  if (normalizeSessionDetailText(user.text) !== prompt) {
    return false;
  }
  if (working.turnId && user.turnId && working.turnId === user.turnId) {
    return true;
  }
  const workingAt = Date.parse(working.timestamp);
  const userAt = Date.parse(user.timestamp);
  return Number.isFinite(workingAt) && Number.isFinite(userAt) && Math.abs(workingAt - userAt) <= 10 * 60 * 1000;
}

function isCliWorkingPromptMessage(message: WebChatMessage): boolean {
  return Boolean(cliWorkingPromptText(message));
}

function cliWorkingPromptText(message: WebChatMessage): string {
  if (message.source !== "cli" || message.role !== "system") {
    return "";
  }
  const match = normalizeSessionDetailText(message.text).match(/^Working on\s+(.+)$/i);
  return match?.[1]?.trim() ?? "";
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
