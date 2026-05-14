import type { TelegramContextKey } from "./context-key.js";
import { createDocumentStore, type DocumentStore, type StateBackendKind } from "./state-backend.js";

export interface SessionLock {
  contextKey: TelegramContextKey;
  ownerUserId: string;
  ownerLabel?: string;
  ownerChannel?: "web" | "telegram" | "discord" | "system";
  ownerChannelUserId?: string;
  createdAt: number;
  expiresAt?: number;
}

export interface SessionLockOwner {
  userId: string;
  label?: string;
  channel?: "web" | "telegram" | "discord" | "system";
  channelUserId?: string;
}

interface PersistedLocks {
  version: 1;
  locks: Record<TelegramContextKey, SessionLock>;
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

  get(contextKey: TelegramContextKey, now = Date.now()): SessionLock | null {
    const payload = this.readPayload();
    const lock = payload.locks[contextKey];
    if (!lock) {
      return null;
    }
    if (lock.expiresAt && lock.expiresAt <= now) {
      delete payload.locks[contextKey];
      this.store.write(payload);
      return null;
    }
    return lock;
  }

  set(contextKey: TelegramContextKey, owner: SessionLockOwner, ttlMs: number): SessionLock {
    const payload = this.readPayload();
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
    payload.locks[contextKey] = lock;
    this.store.write(payload);
    return lock;
  }

  clear(contextKey: TelegramContextKey): boolean {
    const payload = this.readPayload();
    const existed = Boolean(payload.locks[contextKey]);
    delete payload.locks[contextKey];
    this.store.write(payload);
    return existed;
  }

  list(): SessionLock[] {
    const payload = this.readPayload();
    const now = Date.now();
    const locks = Object.values(payload.locks).filter((lock) => !lock.expiresAt || lock.expiresAt > now);
    if (locks.length !== Object.keys(payload.locks).length) {
      payload.locks = Object.fromEntries(locks.map((lock) => [lock.contextKey, lock]));
      this.store.write(payload);
    }
    return locks.sort((left, right) => right.createdAt - left.createdAt);
  }

  private readPayload(): PersistedLocks {
    const payload = this.store.read();
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
