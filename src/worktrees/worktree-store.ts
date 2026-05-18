import { createDocumentStore, type DocumentStore, type StateBackendKind } from "../state/state-backend.js";
import type { SessionWorktreeRecord, WorktreeIntegrationRun } from "./worktree-types.js";

interface WorktreeStoreDocument {
  records: SessionWorktreeRecord[];
  integrations: WorktreeIntegrationRun[];
}

export class SessionWorktreeStore {
  private readonly store: DocumentStore<WorktreeStoreDocument>;
  private records = new Map<string, SessionWorktreeRecord>();
  private integrations = new Map<string, WorktreeIntegrationRun>();

  constructor(workspace: string, backend: StateBackendKind = "json") {
    this.store = createDocumentStore<WorktreeStoreDocument>({
      workspace,
      backend,
      fileName: "session-worktrees.json",
      sqliteKey: "session-worktrees",
    });
    this.load();
  }

  list(): SessionWorktreeRecord[] {
    return [...this.records.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  listIntegrations(): WorktreeIntegrationRun[] {
    return [...this.integrations.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  get(id: string): SessionWorktreeRecord | undefined {
    return this.records.get(id);
  }

  getIntegration(id: string): WorktreeIntegrationRun | undefined {
    return this.integrations.get(id);
  }

  delete(id: string): boolean {
    const removed = this.records.delete(id);
    if (removed) this.persist();
    return removed;
  }

  deleteIntegration(id: string): boolean {
    const removed = this.integrations.delete(id);
    if (removed) this.persist();
    return removed;
  }

  findByThreadId(threadId: string | null | undefined): SessionWorktreeRecord | undefined {
    if (!threadId) {
      return undefined;
    }
    return this.list().find((record) => record.threadId === threadId);
  }

  findByWorkspace(workspace: string | undefined): SessionWorktreeRecord | undefined {
    if (!workspace) {
      return undefined;
    }
    const normalized = normalizePath(workspace);
    return this.list().find((record) => normalizePath(record.worktreePath) === normalized);
  }

  upsert(record: SessionWorktreeRecord): SessionWorktreeRecord {
    this.records.set(record.id, { ...record, updatedAt: record.updatedAt || new Date().toISOString() });
    this.persist();
    return this.records.get(record.id)!;
  }

  patch(id: string, patch: Partial<SessionWorktreeRecord>): SessionWorktreeRecord {
    const existing = this.get(id);
    if (!existing) {
      throw new Error(`Unknown session worktree: ${id}`);
    }
    const next = {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    this.records.set(id, next);
    this.persist();
    return next;
  }

  upsertIntegration(run: WorktreeIntegrationRun): WorktreeIntegrationRun {
    this.integrations.set(run.id, { ...run, updatedAt: run.updatedAt || new Date().toISOString() });
    this.persist();
    return this.integrations.get(run.id)!;
  }

  patchIntegration(id: string, patch: Partial<WorktreeIntegrationRun>): WorktreeIntegrationRun {
    const existing = this.getIntegration(id);
    if (!existing) {
      throw new Error(`Unknown worktree integration run: ${id}`);
    }
    const next = {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    this.integrations.set(id, next);
    this.persist();
    return next;
  }

  private load(): void {
    const data = this.store.read();
    if (!data || typeof data !== "object") {
      return;
    }
    if (Array.isArray(data.records)) {
      for (const record of data.records) {
        if (record?.id) {
          this.records.set(record.id, record);
        }
      }
    }
    if (Array.isArray(data.integrations)) {
      for (const run of data.integrations) {
        if (run?.id) {
          this.integrations.set(run.id, run);
        }
      }
    }
  }

  private persist(): void {
    this.store.write({
      records: this.list(),
      integrations: this.listIntegrations(),
    });
  }
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "");
}
