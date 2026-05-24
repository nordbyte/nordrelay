import { createAgentSessionService } from "../agents/shared/agent-factory.js";
import { CODEX_AGENT_CAPABILITIES, type AgentId, type AgentSessionInfo, type AgentSessionService, type AgentSyncResult } from "../agents/shared/agent.js";
import { findLaunchProfile } from "../agents/codex/codex-launch.js";
import type { ConnectorConfig } from "../core/config.js";
import type { ChannelContextKey } from "../channels/shared/context-key.js";
import { createDocumentStore, type DocumentStore } from "./state-backend.js";
import type { SessionWorkspaceMode } from "../worktrees/worktree-types.js";
import type { SessionWorktreeService } from "../worktrees/worktree-service.js";

export interface ContextMetadata {
  contextKey: ChannelContextKey;
  agentId?: AgentId;
  threadId: string | null;
  workspace: string;
  workspaceMode?: SessionWorkspaceMode;
  worktreeId?: string;
  model?: string;
  reasoningEffort?: string;
  activeLaunchProfileId?: string;
  launchProfileLabel?: string;
  launchProfileBehavior?: string;
  sandboxMode?: string;
  approvalPolicy?: string;
  unsafeLaunch?: boolean;
  launchProfileId?: string;
  nextLaunchProfileLabel?: string;
  nextLaunchProfileBehavior?: string;
  nextUnsafeLaunch?: boolean;
  sessionPath?: string;
  pinnedThreadIds?: string[];
  pinnedThreadIdsByAgent?: Partial<Record<AgentId, string[]>>;
  updatedAt: number;
}

export interface SessionRegistryOptions {
  fileName?: string;
  sqliteKey?: string;
  worktreeService?: SessionWorktreeService;
}

export class SessionRegistry {
  private readonly sessions = new Map<ChannelContextKey, AgentSessionService>();
  private readonly metadata = new Map<ChannelContextKey, ContextMetadata>();
  private readonly deletedContextKeys = new Set<ChannelContextKey>();
  private readonly store: DocumentStore<ContextMetadata[]>;
  private onRemoveCallback?: (contextKey: ChannelContextKey) => void;

  private readonly worktreeService?: SessionWorktreeService;

  constructor(private readonly config: ConnectorConfig, options: SessionRegistryOptions = {}) {
    this.worktreeService = options.worktreeService;
    this.store = createDocumentStore<ContextMetadata[]>({
      workspace: config.workspace,
      fileName: options.fileName ?? "contexts.json",
      sqliteKey: options.sqliteKey ?? "contexts",
      backend: config.stateBackend,
    });
    this.loadPersistedMetadata();
  }

  async getOrCreate(
    contextKey: ChannelContextKey,
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
    const mode = meta?.workspaceMode ?? this.config.sessionWorkspaceMode;
    let workspace = meta?.workspace;
    let worktreeId = meta?.worktreeId;
    const shouldStartThread = !options?.deferThreadStart && !meta?.threadId;
    if (shouldStartThread && mode === "worktree") {
      const worktree = this.createWorktree(contextKey, agentId, workspace ?? this.config.workspace);
      workspace = worktree.worktreePath;
      worktreeId = worktree.id;
    }
    const createOptions = {
      workspace,
      workspaceMode: mode,
      model: meta?.model,
      reasoningEffort: meta?.reasoningEffort,
      launchProfileId,
      deferThreadStart: options?.deferThreadStart && !meta?.threadId,
      resumeThreadId: meta?.threadId ?? undefined,
      sessionPath: meta?.sessionPath,
    };
    if (meta?.activeLaunchProfileId) {
      Object.assign(createOptions, { activeLaunchProfileId: meta.activeLaunchProfileId });
    }
    session = await createAgentSessionService(this.config, agentId, createOptions);

    this.sessions.set(contextKey, session);
    if (worktreeId && shouldStartThread) {
      this.worktreeService?.linkThread(worktreeId, session.getInfo().threadId, agentId, contextKey);
      this.updateMetadata(contextKey, session, { workspaceMode: "worktree", worktreeId });
    }
    return session;
  }

  get(contextKey: ChannelContextKey): AgentSessionService | undefined {
    return this.sessions.get(contextKey);
  }

  has(contextKey: ChannelContextKey): boolean {
    return this.sessions.has(contextKey);
  }

  hasMetadata(contextKey: ChannelContextKey): boolean {
    return this.metadata.has(contextKey);
  }

  async switchAgent(contextKey: ChannelContextKey, agentId: AgentId): Promise<AgentSessionService> {
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
      workspaceMode: "shared",
      pinnedThreadIdsByAgent: previous?.pinnedThreadIdsByAgent,
      updatedAt: Date.now(),
    };
    this.metadata.set(contextKey, next);
    this.persistMetadata();
    return this.getOrCreate(contextKey, { deferThreadStart: true, agentId });
  }

  async startNewThread(
    contextKey: ChannelContextKey,
    session: AgentSessionService,
    options: { workspace?: string; model?: string; workspaceMode?: SessionWorkspaceMode } = {},
  ): Promise<AgentSessionInfo> {
    const current = session.getInfo();
    const mode = options.workspaceMode ?? this.config.sessionWorkspaceMode;
    let workspace = options.workspace;
    let worktreeId: string | undefined;
    if (mode === "worktree") {
      const worktree = this.createWorktree(contextKey, current.agentId ?? "codex", workspace ?? current.workspace ?? this.config.workspace);
      workspace = worktree.worktreePath;
      worktreeId = worktree.id;
    }
    const info = await session.newThread(workspace, options.model);
    if (worktreeId) {
      this.worktreeService?.linkThread(worktreeId, info.threadId, info.agentId ?? current.agentId ?? "codex", contextKey);
    }
    this.updateMetadata(contextKey, session, {
      workspaceMode: mode === "worktree" ? "worktree" : mode,
      worktreeId,
    });
    return info;
  }

  updateMetadata(
    contextKey: ChannelContextKey,
    session: AgentSessionService,
    overrides: Partial<Pick<ContextMetadata, "workspaceMode" | "worktreeId">> = {},
  ): void {
    const info = session.getInfo();
    const previous = this.metadata.get(contextKey);
    const agentId = info.agentId ?? "codex";
    const previousPinnedByAgent = previous?.pinnedThreadIdsByAgent ?? {};
    const pinnedThreadIds = previousPinnedByAgent[agentId] ?? previous?.pinnedThreadIds ?? [];
    const sameThread = Boolean(info.threadId && previous?.threadId === info.threadId);
    const worktree = this.worktreeService?.getByThreadId(info.threadId) ?? this.worktreeService?.getByWorkspace(info.workspace);
    const workspaceMode = worktree
      ? "worktree"
      : overrides.workspaceMode ?? info.workspaceMode ?? (sameThread ? previous?.workspaceMode : undefined) ?? (this.config.sessionWorkspaceMode === "attached" ? "attached" : "shared");
    const worktreeId = worktree?.id ?? overrides.worktreeId ?? (sameThread && workspaceMode === "worktree" ? previous?.worktreeId : undefined);
    const next: ContextMetadata = {
      contextKey,
      agentId,
      threadId: info.threadId,
      workspace: info.workspace,
      workspaceMode,
      model: info.model,
      reasoningEffort: info.reasoningEffort,
      activeLaunchProfileId: info.launchProfileId,
      launchProfileLabel: info.launchProfileLabel,
      launchProfileBehavior: info.launchProfileBehavior,
      sandboxMode: info.sandboxMode,
      approvalPolicy: info.approvalPolicy,
      unsafeLaunch: info.unsafeLaunch,
      launchProfileId: info.nextLaunchProfileId ?? info.launchProfileId,
      updatedAt: Date.now(),
    };
    if (info.nextLaunchProfileId) {
      next.nextLaunchProfileLabel = info.nextLaunchProfileLabel;
      next.nextLaunchProfileBehavior = info.nextLaunchProfileBehavior;
      next.nextUnsafeLaunch = info.nextUnsafeLaunch;
    }
    if (worktreeId) {
      next.worktreeId = worktreeId;
    }
    if (info.sessionPath) {
      next.sessionPath = info.sessionPath;
    }
    const nextPinnedByAgent = { ...previousPinnedByAgent };
    if (pinnedThreadIds.length > 0) {
      nextPinnedByAgent[agentId] = pinnedThreadIds;
    } else {
      delete nextPinnedByAgent[agentId];
    }
    if (Object.keys(nextPinnedByAgent).length > 0) {
      next.pinnedThreadIdsByAgent = nextPinnedByAgent;
    }
    this.metadata.set(contextKey, next);
    this.persistMetadata();
  }

  private createWorktree(contextKey: ChannelContextKey, agentId: AgentId, sourceWorkspace: string) {
    if (!this.worktreeService) {
      throw new Error("Session worktrees are enabled, but no worktree service is configured.");
    }
    return this.worktreeService.create({ contextKey, agentId, sourceWorkspace });
  }

  pinThread(contextKey: ChannelContextKey, threadId: string): string[] {
    const meta = this.metadata.get(contextKey) ?? this.createEmptyMetadata(contextKey);
    const agentId = meta.agentId ?? this.config.defaultAgent ?? "codex";
    const pinnedByAgent = meta.pinnedThreadIdsByAgent ?? {};
    const pinned = new Set(pinnedByAgent[agentId] ?? meta.pinnedThreadIds ?? []);
    pinned.add(threadId);
    meta.pinnedThreadIdsByAgent = { ...pinnedByAgent, [agentId]: [...pinned] };
    delete meta.pinnedThreadIds;
    meta.updatedAt = Date.now();
    this.metadata.set(contextKey, meta);
    this.persistMetadata();
    return meta.pinnedThreadIdsByAgent[agentId] ?? [];
  }

  unpinThread(contextKey: ChannelContextKey, threadId: string): string[] {
    const meta = this.metadata.get(contextKey) ?? this.createEmptyMetadata(contextKey);
    const agentId = meta.agentId ?? this.config.defaultAgent ?? "codex";
    const pinnedByAgent = meta.pinnedThreadIdsByAgent ?? {};
    meta.pinnedThreadIdsByAgent = {
      ...pinnedByAgent,
      [agentId]: (pinnedByAgent[agentId] ?? meta.pinnedThreadIds ?? []).filter((id) => id !== threadId),
    };
    delete meta.pinnedThreadIds;
    meta.updatedAt = Date.now();
    this.metadata.set(contextKey, meta);
    this.persistMetadata();
    return meta.pinnedThreadIdsByAgent[agentId] ?? [];
  }

  listPinnedThreadIds(contextKey: ChannelContextKey): string[] {
    const meta = this.metadata.get(contextKey);
    const agentId = meta?.agentId ?? this.config.defaultAgent ?? "codex";
    return [...(meta?.pinnedThreadIdsByAgent?.[agentId] ?? meta?.pinnedThreadIds ?? [])];
  }

  listContexts(): ContextMetadata[] {
    return [...this.metadata.values()].sort((left, right) => right.updatedAt - left.updatedAt);
  }

  syncAllFromAgentState(options: { reattach?: boolean } = {}): Array<{ contextKey: ChannelContextKey; result: AgentSyncResult }> {
    const results: Array<{ contextKey: ChannelContextKey; result: AgentSyncResult }> = [];
    for (const [contextKey, session] of this.sessions.entries()) {
      if (!(session.getInfo().capabilities ?? CODEX_AGENT_CAPABILITIES).externalActivity) {
        continue;
      }
      const result = session.syncFromAgentState(options);
      if (result.changed) {
        this.updateMetadata(contextKey, session);
      }
      results.push({ contextKey, result });
    }
    return results;
  }

  onRemove(callback: (contextKey: ChannelContextKey) => void): void {
    this.onRemoveCallback = callback;
  }

  remove(contextKey: ChannelContextKey): void {
    const session = this.sessions.get(contextKey);
    session?.dispose();
    this.sessions.delete(contextKey);
    this.metadata.delete(contextKey);
    this.deletedContextKeys.add(contextKey);
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
      const updates = [...this.metadata.values()];
      const deleted = new Set(this.deletedContextKeys);
      this.store.update((current) => {
        const merged = new Map<ChannelContextKey, ContextMetadata>();
        for (const entry of Array.isArray(current) ? current : []) {
          if (entry.contextKey && !deleted.has(entry.contextKey)) {
            merged.set(entry.contextKey, entry);
          }
        }
        for (const entry of updates) {
          if (entry.contextKey && !deleted.has(entry.contextKey)) {
            merged.set(entry.contextKey, entry);
          }
        }
        return [...merged.values()].sort((left, right) => right.updatedAt - left.updatedAt);
      });
      this.deletedContextKeys.clear();
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
      let pruned = false;
      for (const entry of data) {
        if (isPrunableMetadata(entry)) {
          if (entry.contextKey) {
            this.deletedContextKeys.add(entry.contextKey);
          }
          pruned = true;
          continue;
        }
        if (entry.contextKey) {
          this.metadata.set(entry.contextKey, {
            ...entry,
            agentId: entry.agentId ?? "codex",
          });
        }
      }
      if (pruned) {
        this.persistMetadata();
      }
    } catch (error) {
      console.warn(
        "Failed to load persisted context metadata:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private createEmptyMetadata(contextKey: ChannelContextKey): ContextMetadata {
    return {
      contextKey,
      agentId: this.config.defaultAgent ?? "codex",
      threadId: null,
      workspace: this.config.workspace,
      workspaceMode: this.config.sessionWorkspaceMode,
      launchProfileId: this.config.defaultLaunchProfileId,
      pinnedThreadIds: [],
      updatedAt: Date.now(),
    };
  }
}

function isPrunableMetadata(entry: ContextMetadata): boolean {
  const pinned = [
    ...(entry.pinnedThreadIds ?? []),
    ...Object.values(entry.pinnedThreadIdsByAgent ?? {}).flat(),
  ];
  return !entry.threadId && !entry.sessionPath && pinned.length === 0;
}

function resolveLaunchProfileId(
  config: ConnectorConfig,
  meta: ContextMetadata | undefined,
): string | undefined {
  if (!meta?.launchProfileId) {
    return undefined;
  }

  if (meta.agentId === "pi" || meta.agentId === "hermes" || meta.agentId === "openclaw" || meta.agentId === "claude-code") {
    return meta.launchProfileId;
  }

  if (findLaunchProfile(config.launchProfiles, meta.launchProfileId)) {
    return meta.launchProfileId;
  }

  console.warn(
    `Unknown persisted launch profile "${meta.launchProfileId}" for ${meta.contextKey}. Falling back to ${config.defaultLaunchProfileId}.`,
  );
  return undefined;
}
