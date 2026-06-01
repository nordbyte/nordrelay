import {
  isAgentId,
  type AgentId,
  type AgentSessionInfo,
  type AgentSessionService,
  type AgentThreadRecord,
} from "../agents/shared/agent.js";
import { evaluateWorkspacePolicy } from "../core/workspace-policy.js";
import type { RelayRuntimeDelegate } from "./relay-runtime-delegate.js";
import type { SessionPageDto } from "./relay-runtime-types.js";

const MAX_WEB_SESSION_PAGE_SIZE = 50;

export async function relayRuntimeListSessions(runtime: RelayRuntimeDelegate, limit = 80, query = "", agentId?: AgentId): Promise<AgentThreadRecord[]> {
  const { session, dispose } = await runtime.getControlSession(agentId);
  try {
    return runtime.filteredSessions(session, query, Math.max(1, limit * 3)).slice(0, limit).map((record) => enrichThreadRecord(runtime, record));
  } finally {
    if (dispose) {
      session.dispose();
    }
  }
}

export async function relayRuntimeListSessionsPage(runtime: RelayRuntimeDelegate, page = 1, pageSize = MAX_WEB_SESSION_PAGE_SIZE, query = "", agentId?: AgentId): Promise<SessionPageDto> {
  const { session, dispose } = await runtime.getControlSession(agentId);
  try {
    const effectivePage = Math.max(1, Math.floor(page));
    const effectivePageSize = Math.min(MAX_WEB_SESSION_PAGE_SIZE, Math.max(1, Math.floor(pageSize)));
    const offset = (effectivePage - 1) * effectivePageSize;
    const requested = Math.min(5_000, Math.max(100, (offset + effectivePageSize + 1) * 3));
    const records = runtime.filteredSessions(session, query, requested).map((record) => enrichThreadRecord(runtime, record));
    return {
      sessions: records.slice(offset, offset + effectivePageSize),
      pagination: {
        page: effectivePage,
        pageSize: effectivePageSize,
        hasPrevious: effectivePage > 1,
        hasNext: records.length > offset + effectivePageSize,
      },
    };
  } finally {
    if (dispose) {
      session.dispose();
    }
  }
}

export function relayRuntimeFilteredSessions(runtime: RelayRuntimeDelegate, session: AgentSessionService, query: string, limit: number): AgentThreadRecord[] {
  const normalized = query.trim().toLowerCase();
  const info = runtime.publicInfo(session);
  return mergeKnownSessionRecords(runtime, session.listAllSessions(limit), info)
    .filter((record) => evaluateWorkspacePolicy(record.cwd, runtime.config).allowed)
    .filter((record) => {
      if (!normalized) {
        return true;
      }
      return [
        record.id,
        record.title,
        record.cwd,
        record.model,
        record.reasoningEffort,
        record.firstUserMessage,
      ].some((value) => value?.toLowerCase().includes(normalized));
    })
    .sort((left, right) => sessionUpdatedAtMs(right) - sessionUpdatedAtMs(left));
}

function mergeKnownSessionRecords(runtime: RelayRuntimeDelegate, records: AgentThreadRecord[], info: AgentSessionInfo): AgentThreadRecord[] {
  const merged = new Map<string, AgentThreadRecord>();
  const add = (record: AgentThreadRecord | null) => {
    if (!record?.id) {
      return;
    }
    const key = `${record.agentId}:${record.id}`;
    if (!merged.has(key)) {
      merged.set(key, record);
    }
  };

  records.forEach(add);
  knownContextThreadRecords(runtime, info).forEach(add);
  add(currentInfoThreadRecord(info));
  return [...merged.values()];
}

function knownContextThreadRecords(runtime: RelayRuntimeDelegate, info: AgentSessionInfo): AgentThreadRecord[] {
  return runtime.listKnownContextMetadata()
    .map((meta): AgentThreadRecord | null => {
      if (!meta.threadId) {
        return null;
      }
      const agentId = meta.agentId ?? info.agentId;
      if (!isAgentId(agentId)) {
        return null;
      }
      return {
        id: meta.threadId,
        title: null,
        cwd: meta.workspace || info.workspace,
        model: meta.model ?? null,
        reasoningEffort: meta.reasoningEffort ?? null,
        createdAt: metadataTimestamp(meta.updatedAt),
        updatedAt: metadataTimestamp(meta.updatedAt),
        firstUserMessage: null,
        agentId,
        sessionPath: meta.sessionPath,
        workspaceMode: meta.workspaceMode,
      };
    })
    .filter((record): record is AgentThreadRecord => Boolean(record));
}

function currentInfoThreadRecord(info: AgentSessionInfo): AgentThreadRecord | null {
  if (!info.threadId) {
    return null;
  }
  const updatedAt = sessionInfoUpdatedAt(info);
  return {
    id: info.threadId,
    title: info.sessionName || null,
    sessionName: info.sessionName,
    cwd: info.workspace,
    model: info.model ?? null,
    reasoningEffort: info.reasoningEffort ?? null,
    createdAt: updatedAt,
    updatedAt,
    firstUserMessage: null,
    agentId: info.agentId,
    sessionPath: info.sessionPath,
    workspaceMode: info.workspaceMode,
    worktree: info.worktree,
  };
}

function metadataTimestamp(value: number | undefined): Date {
  const timestamp = Number(value);
  return new Date(Number.isFinite(timestamp) && timestamp > 0 ? timestamp : Date.now());
}

function sessionInfoUpdatedAt(info: AgentSessionInfo): Date {
  const usageUpdatedAt = info.codexUsage?.updatedAt ?? null;
  if (usageUpdatedAt instanceof Date && Number.isFinite(usageUpdatedAt.getTime())) {
    return usageUpdatedAt;
  }
  return new Date();
}

function sessionUpdatedAtMs(record: AgentThreadRecord): number {
  const value = record.updatedAt instanceof Date ? record.updatedAt.getTime() : Date.parse(String(record.updatedAt));
  return Number.isFinite(value) ? value : 0;
}

function enrichThreadRecord(runtime: RelayRuntimeDelegate, record: AgentThreadRecord): AgentThreadRecord {
  const worktree = runtime.worktreeService.getByThreadId(record.id) ?? runtime.worktreeService.getByWorkspace(record.cwd);
  const metadata = runtime.listKnownContextMetadata().find((meta) => meta.threadId === record.id);
  const sessionName = runtime.sessionNameStore.get(record.agentId, record.id)?.name;
  if (!worktree) {
    return {
      ...record,
      sessionName,
      workspaceMode: metadata?.workspaceMode ?? "attached",
    };
  }
  const snapshot = runtime.worktreeService.snapshot(worktree);
  return {
    ...record,
    sessionName,
    workspaceMode: "worktree",
    worktree: {
      id: snapshot.id,
      sourceWorkspace: snapshot.sourceWorkspace,
      repoRoot: snapshot.repoRoot,
      baseSha: snapshot.baseSha,
      branchName: snapshot.branchName,
      status: snapshot.statusText,
      dirty: snapshot.dirty,
      commitSha: snapshot.commitSha,
    },
  };
}
