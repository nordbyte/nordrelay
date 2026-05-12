import { createAgentSessionService } from "./agent-factory.js";
import { CODEX_AGENT_CAPABILITIES, type AgentId, type AgentSessionService, type AgentSyncResult } from "./agent.js";
import { findLaunchProfile } from "./codex-launch.js";
import type { ConnectorConfig } from "./config.js";
import type { TelegramContextKey } from "./context-key.js";
import { createDocumentStore, type DocumentStore } from "./state-backend.js";

export interface ContextMetadata {
  contextKey: TelegramContextKey;
  agentId?: AgentId;
  threadId: string | null;
  workspace: string;
  model?: string;
  reasoningEffort?: string;
  launchProfileId?: string;
  sessionPath?: string;
  pinnedThreadIds?: string[];
  updatedAt: number;
}

export interface SessionRegistryOptions {
  fileName?: string;
  sqliteKey?: string;
}

export class SessionRegistry {
  private readonly sessions = new Map<TelegramContextKey, AgentSessionService>();
  private readonly metadata = new Map<TelegramContextKey, ContextMetadata>();
  private readonly store: DocumentStore<ContextMetadata[]>;
  private onRemoveCallback?: (contextKey: TelegramContextKey) => void;

  constructor(private readonly config: ConnectorConfig, options: SessionRegistryOptions = {}) {
    this.store = createDocumentStore<ContextMetadata[]>({
      workspace: config.workspace,
      fileName: options.fileName ?? "contexts.json",
      sqliteKey: options.sqliteKey ?? "contexts",
      backend: config.stateBackend,
    });
    this.loadPersistedMetadata();
  }

  async getOrCreate(
    contextKey: TelegramContextKey,
    options?: { deferThreadStart?: boolean; agentId?: AgentId },
  ): Promise<AgentSessionService> {
    let session = this.sessions.get(contextKey);
    if (session && (!options?.agentId || session.getInfo().agentId === options.agentId)) {
      return session;
    }
    if (session && options?.agentId && session.getInfo().agentId !== options.agentId) {
      session.dispose();
      this.sessions.delete(contextKey);
    }

    const meta = this.metadata.get(contextKey);
    const agentId = options?.agentId ?? meta?.agentId ?? this.config.defaultAgent ?? "codex";
    const launchProfileId = resolveLaunchProfileId(this.config, meta);
    session = await createAgentSessionService(this.config, agentId, {
      workspace: meta?.workspace,
      model: meta?.model,
      reasoningEffort: meta?.reasoningEffort,
      launchProfileId,
      deferThreadStart: options?.deferThreadStart && !meta?.threadId,
      resumeThreadId: meta?.threadId ?? undefined,
      sessionPath: meta?.sessionPath,
    });

    this.sessions.set(contextKey, session);
    return session;
  }

  get(contextKey: TelegramContextKey): AgentSessionService | undefined {
    return this.sessions.get(contextKey);
  }

  has(contextKey: TelegramContextKey): boolean {
    return this.sessions.has(contextKey);
  }

  hasMetadata(contextKey: TelegramContextKey): boolean {
    return this.metadata.has(contextKey);
  }

  async switchAgent(contextKey: TelegramContextKey, agentId: AgentId): Promise<AgentSessionService> {
    const current = this.sessions.get(contextKey);
    if (current?.getInfo().agentId === agentId) {
      return current;
    }
    current?.dispose();
    this.sessions.delete(contextKey);

    const previous = this.metadata.get(contextKey);
    const next: ContextMetadata = {
      contextKey,
      agentId,
      threadId: null,
      workspace: previous?.workspace ?? this.config.workspace,
      pinnedThreadIds: previous?.pinnedThreadIds,
      updatedAt: Date.now(),
    };
    this.metadata.set(contextKey, next);
    this.persistMetadata();
    return this.getOrCreate(contextKey, { deferThreadStart: true, agentId });
  }

  updateMetadata(contextKey: TelegramContextKey, session: AgentSessionService): void {
    const info = session.getInfo();
    const previous = this.metadata.get(contextKey);
    const pinnedThreadIds = previous?.pinnedThreadIds ?? [];
    const next: ContextMetadata = {
      contextKey,
      threadId: info.threadId,
      workspace: info.workspace,
      model: info.model,
      reasoningEffort: info.reasoningEffort,
      launchProfileId: info.nextLaunchProfileId ?? info.launchProfileId,
      updatedAt: Date.now(),
    };
    if (info.agentId && info.agentId !== "codex") {
      next.agentId = info.agentId;
    }
    if (info.sessionPath) {
      next.sessionPath = info.sessionPath;
    }
    if (pinnedThreadIds.length > 0) {
      next.pinnedThreadIds = pinnedThreadIds;
    }
    this.metadata.set(contextKey, next);
    this.persistMetadata();
  }

  pinThread(contextKey: TelegramContextKey, threadId: string): string[] {
    const meta = this.metadata.get(contextKey) ?? this.createEmptyMetadata(contextKey);
    const pinned = new Set(meta.pinnedThreadIds ?? []);
    pinned.add(threadId);
    meta.pinnedThreadIds = [...pinned];
    meta.updatedAt = Date.now();
    this.metadata.set(contextKey, meta);
    this.persistMetadata();
    return meta.pinnedThreadIds;
  }

  unpinThread(contextKey: TelegramContextKey, threadId: string): string[] {
    const meta = this.metadata.get(contextKey) ?? this.createEmptyMetadata(contextKey);
    meta.pinnedThreadIds = (meta.pinnedThreadIds ?? []).filter((id) => id !== threadId);
    meta.updatedAt = Date.now();
    this.metadata.set(contextKey, meta);
    this.persistMetadata();
    return meta.pinnedThreadIds;
  }

  listPinnedThreadIds(contextKey: TelegramContextKey): string[] {
    return [...(this.metadata.get(contextKey)?.pinnedThreadIds ?? [])];
  }

  listContexts(): ContextMetadata[] {
    return [...this.metadata.values()].sort((left, right) => right.updatedAt - left.updatedAt);
  }

  syncAllFromCodexState(options: { reattach?: boolean } = {}): Array<{ contextKey: TelegramContextKey; result: AgentSyncResult }> {
    const results: Array<{ contextKey: TelegramContextKey; result: AgentSyncResult }> = [];
    for (const [contextKey, session] of this.sessions.entries()) {
      if (!(session.getInfo().capabilities ?? CODEX_AGENT_CAPABILITIES).externalActivity) {
        continue;
      }
      const result = session.syncFromCodexState(options);
      if (result.changed) {
        this.updateMetadata(contextKey, session);
      }
      results.push({ contextKey, result });
    }
    return results;
  }

  onRemove(callback: (contextKey: TelegramContextKey) => void): void {
    this.onRemoveCallback = callback;
  }

  remove(contextKey: TelegramContextKey): void {
    const session = this.sessions.get(contextKey);
    session?.dispose();
    this.sessions.delete(contextKey);
    this.metadata.delete(contextKey);
    this.onRemoveCallback?.(contextKey);
    this.persistMetadata();
  }

  disposeAll(): void {
    for (const session of this.sessions.values()) {
      session.dispose();
    }
    this.sessions.clear();
  }

  private persistMetadata(): void {
    try {
      const data = [...this.metadata.values()];
      this.store.write(data);
    } catch (error) {
      console.warn(
        "Failed to persist context metadata:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private loadPersistedMetadata(): void {
    try {
      const data = this.store.read();
      if (!Array.isArray(data)) {
        return;
      }
      for (const entry of data) {
        if (entry.contextKey) {
          this.metadata.set(entry.contextKey, entry);
        }
      }
    } catch {
      // Silently ignore load errors.
    }
  }

  private createEmptyMetadata(contextKey: TelegramContextKey): ContextMetadata {
    return {
      contextKey,
      threadId: null,
      workspace: this.config.workspace,
      launchProfileId: this.config.defaultLaunchProfileId,
      pinnedThreadIds: [],
      updatedAt: Date.now(),
    };
  }
}

function resolveLaunchProfileId(
  config: ConnectorConfig,
  meta: ContextMetadata | undefined,
): string | undefined {
  if (!meta?.launchProfileId) {
    return undefined;
  }

  if (findLaunchProfile(config.launchProfiles, meta.launchProfileId)) {
    return meta.launchProfileId;
  }

  console.warn(
    `Unknown persisted launch profile "${meta.launchProfileId}" for ${meta.contextKey}. Falling back to ${config.defaultLaunchProfileId}.`,
  );
  return undefined;
}
