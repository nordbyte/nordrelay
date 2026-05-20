import type { ChannelContextKey } from "../channels/shared/context-key.js";
import { createDocumentStore, type DocumentStore, type StateBackendKind } from "../state/state-backend.js";

export interface SessionLock {
  contextKey: ChannelContextKey;
  ownerUserId: string;
  ownerLabel?: string;
  ownerChannel?: "web" | "telegram" | "discord" | "slack" | "matrix" | "system";
  ownerChannelUserId?: string;
  createdAt: number;
  expiresAt?: number;
}

export interface SessionLockOwner {
  userId: string;
  label?: string;
  channel?: "web" | "telegram" | "discord" | "slack" | "matrix" | "system";
  channelUserId?: string;
}

interface PersistedLocks {
  version: 1;
  locks: Record<ChannelContextKey, SessionLock>;
}

export class SessionLockStore {
  private readonly store: DocumentStore<PersistedLocks>;

  constructor(workspace: string, backend: StateBackendKind = "json") {
    this.store = createDocumentStore<PersistedLocks>({
      workspace,
      fileName: "locks.json",
      sqliteKey: "locks",
      backend,
    });
  }

  get(contextKey: ChannelContextKey, now = Date.now()): SessionLock | null {
    const lock = this.readPayload().locks[contextKey];
    if (!lock) {
      return null;
    }
    if (!lock.expiresAt || lock.expiresAt > now) {
      return lock;
    }
    this.store.update((current) => {
      const payload = normalizeLockPayload(current);
      const currentLock = payload.locks[contextKey];
      if (currentLock?.expiresAt && currentLock.expiresAt <= now) {
        delete payload.locks[contextKey];
      }
      return payload;
    });
    return null;
  }

  set(contextKey: ChannelContextKey, owner: SessionLockOwner, ttlMs: number): SessionLock {
    const now = Date.now();
    const lock: SessionLock = {
      contextKey,
      ownerUserId: owner.userId,
      ownerLabel: owner.label,
      ownerChannel: owner.channel,
      ownerChannelUserId: owner.channelUserId,
      createdAt: now,
      expiresAt: ttlMs > 0 ? now + ttlMs : undefined,
    };
    this.store.update((current) => {
      const payload = normalizeLockPayload(current);
      payload.locks[contextKey] = lock;
      return payload;
    });
    return lock;
  }

  clear(contextKey: ChannelContextKey): boolean {
    let existed = false;
    this.store.update((current) => {
      const payload = normalizeLockPayload(current);
      existed = Boolean(payload.locks[contextKey]);
      delete payload.locks[contextKey];
      return payload;
    });
    return existed;
  }

  list(): SessionLock[] {
    const now = Date.now();
    const payload = this.store.update((current) => {
      const payload = normalizeLockPayload(current);
      payload.locks = Object.fromEntries(
        Object.values(payload.locks)
          .filter((lock) => !lock.expiresAt || lock.expiresAt > now)
          .map((lock) => [lock.contextKey, lock]),
      );
      return payload;
    });
    const locks = Object.values(payload.locks).filter((lock) => !lock.expiresAt || lock.expiresAt > now);
    return locks.sort((left, right) => right.createdAt - left.createdAt);
  }

  private readPayload(): PersistedLocks {
    return normalizeLockPayload(this.store.read());
  }
}

function normalizeLockPayload(payload: PersistedLocks | undefined): PersistedLocks {
  if (!payload || payload.version !== 1 || !payload.locks || typeof payload.locks !== "object") {
    return { version: 1, locks: {} };
  }
  return {
    version: 1,
    locks: Object.fromEntries(
      Object.entries(payload.locks).filter(([, lock]) => isSessionLock(lock)),
    ),
  };
}

export function canWriteWithLock(
  lock: SessionLock | null,
  userId: string | undefined,
  isAdmin: boolean,
): boolean {
  if (!lock) {
    return true;
  }
  return isAdmin || Boolean(userId && userId === lock.ownerUserId);
}

function isSessionLock(value: unknown): value is SessionLock {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as SessionLock;
  return typeof candidate.contextKey === "string" &&
    typeof candidate.ownerUserId === "string" &&
    typeof candidate.createdAt === "number" &&
    (candidate.expiresAt === undefined || typeof candidate.expiresAt === "number");
}
