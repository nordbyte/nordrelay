import { createRequire } from "node:module";
import path from "node:path";

import { readJsonFileWithBackup, writeJsonFileAtomic } from "./persistence.js";

export type StateBackendKind = "json" | "sqlite";

export interface DocumentStore<TValue> {
  kind: StateBackendKind;
  filePath: string;
  read(): TValue | undefined;
  write(value: TValue): void;
}

export interface DocumentStoreOptions {
  workspace: string;
  fileName: string;
  sqliteKey: string;
  backend: StateBackendKind;
}

type SqliteDatabase = {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): unknown;
  };
};

const require = createRequire(import.meta.url);

export function createDocumentStore<TValue>(options: DocumentStoreOptions): DocumentStore<TValue> {
  if (options.backend === "sqlite") {
    const sqlite = tryCreateSqliteDocumentStore<TValue>(options);
    if (sqlite) {
      return sqlite;
    }
    console.warn("SQLite state backend is not available. Falling back to JSON files.");
  }

  return createJsonDocumentStore<TValue>(options);
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
  };
}

function tryCreateSqliteDocumentStore<TValue>(options: DocumentStoreOptions): DocumentStore<TValue> | null {
  let Database: new (filePath: string) => SqliteDatabase;
  try {
    Database = require("better-sqlite3") as new (filePath: string) => SqliteDatabase;
  } catch {
    return null;
  }

  const filePath = stateBackendPath(options.workspace, "sqlite");
  const db = new Database(filePath);
  db.exec([
    "CREATE TABLE IF NOT EXISTS documents (",
    "key TEXT PRIMARY KEY,",
    "json TEXT NOT NULL,",
    "updated_at TEXT NOT NULL",
    ")",
  ].join(" "));

  return {
    kind: "sqlite",
    filePath,
    read() {
      const row = db.prepare("SELECT json FROM documents WHERE key = ?").get(options.sqliteKey) as { json?: unknown } | undefined;
      if (typeof row?.json !== "string") {
        return undefined;
      }
      try {
        return JSON.parse(row.json) as TValue;
      } catch (error) {
        console.warn(
          `Failed to parse SQLite state document ${options.sqliteKey}:`,
          error instanceof Error ? error.message : String(error),
        );
        return undefined;
      }
    },
    write(value) {
      db.prepare([
        "INSERT INTO documents (key, json, updated_at) VALUES (?, ?, ?)",
        "ON CONFLICT(key) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at",
      ].join(" ")).run(options.sqliteKey, JSON.stringify(value), new Date().toISOString());
    },
  };
}
