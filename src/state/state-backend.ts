import { createRequire } from "node:module";
import path from "node:path";

import { assertSupportedStatePayload, chmodPrivateFile, ensurePrivateDir, readJsonFileWithBackup, StatePersistenceError, updateJsonFileAtomic, writeJsonFileAtomic } from "./persistence.js";

export type StateBackendKind = "json" | "sqlite";

export interface DocumentStore<TValue> {
  kind: StateBackendKind;
  filePath: string;
  read(): TValue | undefined;
  write(value: TValue): void;
  update(updater: (current: TValue | undefined) => TValue): TValue;
  close?(): void;
}

export interface DocumentStoreOptions {
  workspace: string;
  fileName: string;
  sqliteKey: string;
  backend: StateBackendKind;
}

export interface StateBackendAvailability {
  ok: boolean;
  detail: string;
}

type SqliteDatabase = {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): unknown;
  };
  close(): void;
};

const require = createRequire(import.meta.url);

export function createDocumentStore<TValue>(options: DocumentStoreOptions): DocumentStore<TValue> {
  if (options.backend === "sqlite") {
    return createSqliteDocumentStore<TValue>(options);
  }

  return createJsonDocumentStore<TValue>(options);
}

export function checkStateBackendAvailability(
  workspace: string,
  backend: StateBackendKind,
): StateBackendAvailability {
  if (backend === "json") {
    return { ok: true, detail: "JSON state backend is available." };
  }
  let Database: new (filePath: string) => SqliteDatabase;
  try {
    Database = require("better-sqlite3") as new (filePath: string) => SqliteDatabase;
  } catch (error) {
    return {
      ok: false,
      detail: `SQLite state backend requires better-sqlite3: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const filePath = stateBackendPath(workspace, "sqlite");
  let db: SqliteDatabase | undefined;
  try {
    ensurePrivateDir(path.dirname(filePath));
    db = new Database(filePath);
    chmodPrivateFile(filePath);
    db.exec("SELECT 1");
    return { ok: true, detail: `SQLite state backend is available at ${filePath}.` };
  } catch (error) {
    return {
      ok: false,
      detail: `SQLite state backend failed at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    db?.close();
  }
}

export function stateBackendPath(workspace: string, backend: StateBackendKind, fileName?: string): string {
  if (backend === "sqlite") {
    return path.join(workspace, ".nordrelay", "state.sqlite");
  }
  return path.join(workspace, ".nordrelay", fileName ?? "state.json");
}

function createJsonDocumentStore<TValue>(options: DocumentStoreOptions): DocumentStore<TValue> {
  const filePath = stateBackendPath(options.workspace, "json", options.fileName);
  return {
    kind: "json",
    filePath,
    read() {
      return readJsonFileWithBackup<TValue>(filePath).value;
    },
    write(value) {
      writeJsonFileAtomic(filePath, value);
    },
    update(updater) {
      return updateJsonFileAtomic(filePath, updater);
    },
  };
}

function createSqliteDocumentStore<TValue>(options: DocumentStoreOptions): DocumentStore<TValue> {
  let Database: new (filePath: string) => SqliteDatabase;
  try {
    Database = require("better-sqlite3") as new (filePath: string) => SqliteDatabase;
  } catch (error) {
    throw new Error(`SQLite state backend is configured, but better-sqlite3 is not available: ${error instanceof Error ? error.message : String(error)}`);
  }

  const filePath = stateBackendPath(options.workspace, "sqlite");
  let db: SqliteDatabase;
  try {
    ensurePrivateDir(path.dirname(filePath));
    db = new Database(filePath);
    chmodPrivateFile(filePath);
    db.exec([
      "CREATE TABLE IF NOT EXISTS documents (",
      "key TEXT PRIMARY KEY,",
      "json TEXT NOT NULL,",
      "updated_at TEXT NOT NULL",
      ")",
    ].join(" "));
  } catch (error) {
    throw new Error(
      `SQLite state backend failed at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return {
    kind: "sqlite",
    filePath,
    read() {
      return readSqliteDocument<TValue>(db, options.sqliteKey);
    },
    write(value) {
      db.prepare([
        "INSERT INTO documents (key, json, updated_at) VALUES (?, ?, ?)",
        "ON CONFLICT(key) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at",
      ].join(" ")).run(options.sqliteKey, JSON.stringify(value), new Date().toISOString());
    },
    update(updater) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const next = updater(readSqliteDocument<TValue>(db, options.sqliteKey));
        db.prepare([
          "INSERT INTO documents (key, json, updated_at) VALUES (?, ?, ?)",
          "ON CONFLICT(key) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at",
        ].join(" ")).run(options.sqliteKey, JSON.stringify(next), new Date().toISOString());
        db.exec("COMMIT");
        return next;
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // Ignore rollback failures and surface the original error.
        }
        throw error;
      }
    },
    close() {
      db.close();
    },
  };
}

function readSqliteDocument<TValue>(db: SqliteDatabase, key: string): TValue | undefined {
  const row = db.prepare("SELECT json FROM documents WHERE key = ?").get(key) as { json?: unknown } | undefined;
  if (typeof row?.json !== "string") {
    return undefined;
  }
  try {
    const value = JSON.parse(row.json) as TValue;
    assertSupportedStatePayload(value, `sqlite:${key}`);
    return value;
  } catch (error) {
    if (error instanceof StatePersistenceError) {
      throw error;
    }
    throw new StatePersistenceError(
      `Cannot read SQLite state document ${key}: ${error instanceof Error ? error.message : String(error)}`,
      `sqlite:${key}`,
      error instanceof Error ? error.message : String(error),
    );
  }
}
