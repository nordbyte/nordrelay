import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getHermesSession,
  getHermesSessionActivity,
  getHermesSessionActivityLog,
  getHermesSessionDiagnostics,
  listHermesSessions,
} from "../src/hermes-state.js";

const require = createRequire(import.meta.url);
const sqliteAvailable = (() => {
  try {
    require("better-sqlite3");
    return true;
  } catch {
    return false;
  }
})();

describe("hermes-state", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "nordrelay-hermes-state-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  (sqliteAvailable ? it : it.skip)("reads Hermes sessions and detects active external turns", () => {
    const stateDbPath = path.join(tempDir, "state.db");
    const Database = require("better-sqlite3");
    const db = new Database(stateDbPath);
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        title TEXT,
        model TEXT,
        model_config TEXT,
        started_at REAL NOT NULL,
        ended_at REAL,
        message_count INTEGER DEFAULT 0,
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        cache_read_tokens INTEGER DEFAULT 0,
        cache_write_tokens INTEGER DEFAULT 0,
        reasoning_tokens INTEGER DEFAULT 0,
        estimated_cost_usd REAL,
        actual_cost_usd REAL
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT,
        tool_name TEXT,
        timestamp REAL NOT NULL,
        token_count INTEGER,
        reasoning TEXT,
        reasoning_content TEXT
      );
    `);
    db.prepare(`
      INSERT INTO sessions (
        id, source, title, model, model_config, started_at, message_count,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "hermes-active",
      "cli",
      "Hermes task",
      "openai/gpt-5.5",
      JSON.stringify({ agent: { reasoning_effort: "xhigh" } }),
      Date.parse("2026-05-12T08:00:00.000Z") / 1000,
      1,
      1200,
      300,
      20,
      5,
      50,
    );
    db.prepare("INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)")
      .run("hermes-active", "user", "Still running", Date.parse("2026-05-12T08:00:03.000Z") / 1000);
    db.close();

    const options = {
      stateDbPath,
      workspace: "/workspace/project",
      nowMs: Date.parse("2026-05-12T08:00:05.000Z"),
      staleAfterMs: 60_000,
    };
    const sessions = listHermesSessions(10, options);
    const record = getHermesSession("hermes-active", options);
    const activity = getHermesSessionActivity("hermes-active", options);
    const events = getHermesSessionActivityLog("hermes-active", 10, options);
    const diagnostics = getHermesSessionDiagnostics("hermes-active", options);

    expect(sessions).toHaveLength(1);
    expect(record).toMatchObject({
      agentId: "hermes",
      id: "hermes-active",
      cwd: "/workspace/project",
      model: "openai/gpt-5.5",
      reasoningEffort: "xhigh",
      firstUserMessage: "Still running",
      sessionPath: stateDbPath,
    });
    expect(record?.usage).toMatchObject({
      input: 1200,
      output: 300,
      cacheRead: 20,
      cacheWrite: 5,
      total: 1575,
    });
    expect(activity).toMatchObject({
      agentId: "hermes",
      active: true,
      stale: false,
      threadId: "hermes-active",
      sourcePath: stateDbPath,
    });
    expect(events.map((event) => event.kind)).toEqual(["task", "user"]);
    expect(diagnostics.status).toBe("active");
    expect(diagnostics.lineCount).toBe(1);
  });
});
