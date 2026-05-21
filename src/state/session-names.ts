import type { AgentId } from "../agents/shared/agent.js";
import { createDocumentStore, type DocumentStore, type StateBackendKind } from "./state-backend.js";

export const MAX_SESSION_NAME_LENGTH = 30;

export interface SessionNameRecord {
  agentId: AgentId;
  threadId: string;
  name: string;
  updatedAt: string;
}

interface PersistedSessionNames {
  version: 1;
  names: Record<string, SessionNameRecord>;
}

export class SessionNameStore {
  private readonly store: DocumentStore<PersistedSessionNames>;

  constructor(workspace: string, backend: StateBackendKind = "json") {
    this.store = createDocumentStore<PersistedSessionNames>({
      workspace,
      fileName: "session-names.json",
      sqliteKey: "session-names",
      backend,
    });
  }

  get(agentId: AgentId | string | null | undefined, threadId: string | null | undefined): SessionNameRecord | null {
    if (!agentId || !threadId) {
      return null;
    }
    const payload = normalizePayload(this.store.read());
    return payload.names[sessionNameKey(agentId, threadId)] ?? null;
  }

  set(agentId: AgentId, threadId: string, rawName: string): SessionNameRecord | null {
    const name = sanitizeSessionName(rawName);
    let record: SessionNameRecord | null = null;
    this.store.update((current) => {
      const payload = normalizePayload(current);
      const key = sessionNameKey(agentId, threadId);
      if (!name) {
        delete payload.names[key];
        return payload;
      }
      record = {
        agentId,
        threadId,
        name,
        updatedAt: new Date().toISOString(),
      };
      payload.names[key] = record;
      return payload;
    });
    return record;
  }
}

export function sanitizeSessionName(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, MAX_SESSION_NAME_LENGTH);
}

function normalizePayload(payload: PersistedSessionNames | undefined): PersistedSessionNames {
  if (!payload?.names || typeof payload.names !== "object") {
    return { version: 1, names: {} };
  }
  const names: Record<string, SessionNameRecord> = {};
  for (const [key, record] of Object.entries(payload.names)) {
    const normalized = normalizeSessionNameRecord(record);
    if (normalized) {
      names[key] = normalized;
    }
  }
  return { version: 1, names };
}

function normalizeSessionNameRecord(record: SessionNameRecord | undefined): SessionNameRecord | null {
  if (!record || !record.agentId || !record.threadId) {
    return null;
  }
  const name = sanitizeSessionName(String(record.name ?? ""));
  if (!name) {
    return null;
  }
  return {
    agentId: record.agentId,
    threadId: String(record.threadId),
    name,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : new Date().toISOString(),
  };
}

function sessionNameKey(agentId: AgentId | string, threadId: string): string {
  return `${agentId}:${threadId}`;
}
