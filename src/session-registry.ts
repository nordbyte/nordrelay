import path from "node:path";

import { findLaunchProfile } from "./codex-launch.js";
import { CodexSessionService, type CodexSyncResult } from "./codex-session.js";
import type { ConnectorConfig } from "./config.js";
import type { TelegramContextKey } from "./context-key.js";
import { readJsonFileWithBackup, writeJsonFileAtomic } from "./persistence.js";

export interface ContextMetadata {
  contextKey: TelegramContextKey;
  threadId: string | null;
  workspace: string;
  model?: string;
  reasoningEffort?: string;
  launchProfileId?: string;
  pinnedThreadIds?: string[];
  updatedAt: number;
}

export class SessionRegistry {
  private readonly sessions = new Map<TelegramContextKey, CodexSessionService>();
  private readonly metadata = new Map<TelegramContextKey, ContextMetadata>();
  private readonly persistPath: string;
  private onRemoveCallback?: (contextKey: TelegramContextKey) => void;

  constructor(private readonly config: ConnectorConfig) {
    this.persistPath = path.join(config.workspace, ".nordrelay", "contexts.json");
    this.loadPersistedMetadata();
  }

  async getOrCreate(
    contextKey: TelegramContextKey,
    options?: { deferThreadStart?: boolean },
  ): Promise<CodexSessionService> {
    let session = this.sessions.get(contextKey);
    if (session) {
      return session;
    }

    const meta = this.metadata.get(contextKey);
    const launchProfileId = resolveLaunchProfileId(this.config, meta);
    session = await CodexSessionService.create(this.config, {
      workspace: meta?.workspace,
      model: meta?.model,
      reasoningEffort: meta?.reasoningEffort,
      launchProfileId,
      deferThreadStart: options?.deferThreadStart && !meta?.threadId,
      resumeThreadId: meta?.threadId ?? undefined,
    });

    this.sessions.set(contextKey, session);
    return session;
  }

  get(contextKey: TelegramContextKey): CodexSessionService | undefined {
    return this.sessions.get(contextKey);
  }

  has(contextKey: TelegramContextKey): boolean {
    return this.sessions.has(contextKey);
  }

  hasMetadata(contextKey: TelegramContextKey): boolean {
    return this.metadata.has(contextKey);
  }

  updateMetadata(contextKey: TelegramContextKey, session: CodexSessionService): void {
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

  syncAllFromCodexState(options: { reattach?: boolean } = {}): Array<{ contextKey: TelegramContextKey; result: CodexSyncResult }> {
    const results: Array<{ contextKey: TelegramContextKey; result: CodexSyncResult }> = [];
    for (const [contextKey, session] of this.sessions.entries()) {
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
      writeJsonFileAtomic(this.persistPath, data);
    } catch (error) {
      console.warn(
        "Failed to persist context metadata:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private loadPersistedMetadata(): void {
    try {
      const data = readJsonFileWithBackup<ContextMetadata[]>(this.persistPath).value;
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
