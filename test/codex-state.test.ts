import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type ThreadFixture = {
  id: string;
  title: string;
  cwd: string;
  rollout_path?: string;
  model: string | null;
  reasoning_effort?: string | null;
  sandbox_policy?: string | null;
  approval_mode?: string | null;
  created_at: number;
  updated_at: number;
  first_user_message: string;
  archived?: number;
};

type LoadOptions = {
  home?: string;
  files?: string[];
  stats?: Record<string, number>;
  threads?: ThreadFixture[];
  modelsJson?: string;
  fileContents?: Record<string, string>;
  betterSqliteAvailable?: boolean;
  openThrows?: boolean;
};

const originalCodexHome = process.env.CODEX_HOME;
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

afterEach(() => {
  vi.doUnmock("node:fs");
  vi.doUnmock("better-sqlite3");
  vi.resetModules();

  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  if (originalUserProfile === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = originalUserProfile;
  }
  if (originalCodexHome === undefined) {
    delete process.env.CODEX_HOME;
  } else {
    process.env.CODEX_HOME = originalCodexHome;
  }
});

async function loadCodexState(options: LoadOptions = {}) {
  const home = options.home ?? "/Users/tester";
  const codexDir = path.join(home, ".codex");
  const modelsPath = path.join(codexDir, "models_cache.json");
  const files = options.files ?? [];
  const fileContents = options.fileContents ?? {};
  const stats = options.stats ?? {};
  const threads = options.threads ?? [];
  process.env.HOME = home;
  delete process.env.CODEX_HOME;

  vi.resetModules();

  vi.doMock("node:fs", () => ({
    existsSync: vi.fn((targetPath: string) => {
      if (targetPath === codexDir) {
        return true;
      }
      if (targetPath === modelsPath) {
        return options.modelsJson !== undefined;
      }
      if (Object.hasOwn(fileContents, targetPath)) {
        return true;
      }
      return files.includes(path.basename(targetPath));
    }),
    readdirSync: vi.fn((targetPath: string) => {
      if (targetPath !== codexDir) {
        throw new Error(`Unexpected readdirSync path: ${targetPath}`);
      }
      return files;
    }),
    statSync: vi.fn((targetPath: string) => ({
      mtimeMs: stats[targetPath] ?? 0,
      size: fileContents[targetPath]?.length ?? 0,
    })),
    openSync: vi.fn(() => 1),
    readSync: vi.fn(() => 0),
    closeSync: vi.fn(),
    readFileSync: vi.fn((targetPath: string) => {
      if (Object.hasOwn(fileContents, targetPath)) {
        return fileContents[targetPath];
      }
      if (targetPath !== modelsPath || options.modelsJson === undefined) {
        throw new Error(`ENOENT: ${targetPath}`);
      }
      return options.modelsJson;
    }),
  }));

  if (options.betterSqliteAvailable === false) {
    vi.doMock("better-sqlite3", () => {
      throw Object.assign(new Error("Cannot find package 'better-sqlite3'"), { code: "ERR_MODULE_NOT_FOUND" });
    });
  } else {
    vi.doMock("better-sqlite3", () => ({
      default: class MockDatabase {
        constructor(_databasePath: string) {
          if (options.openThrows) {
            throw new Error("open failed");
          }
        }

        prepare(sql: string) {
          return {
            all: (...args: unknown[]) => runAllQuery(sql, threads, args),
            get: (...args: unknown[]) => runGetQuery(sql, threads, args),
          };
        }

        close(): void {}
      },
    }));
  }

  return await import("../src/agents/codex/codex-state.js");
}

function runAllQuery(sql: string, threads: ThreadFixture[], args: unknown[]) {
  if (sql.includes("SELECT DISTINCT cwd")) {
    return [...new Set(threads.filter((thread) => thread.archived !== 1).map((thread) => thread.cwd).filter(Boolean))]
      .sort()
      .map((cwd) => ({ cwd }));
  }

  if (sql.includes("FROM threads")) {
    const limit = typeof args[0] === "number" ? args[0] : 20;
    return threads
      .filter((thread) => thread.archived !== 1)
      .sort((left, right) => right.updated_at - left.updated_at)
      .slice(0, limit);
  }

  return [];
}

function runGetQuery(sql: string, threads: ThreadFixture[], args: unknown[]) {
  if (sql.includes("SELECT rollout_path")) {
    const id = String(args[0] ?? "");
    const thread = threads.find((candidate) => candidate.archived !== 1 && candidate.id === id);
    return thread?.rollout_path ? { rollout_path: thread.rollout_path } : undefined;
  }

  if (sql.includes("WHERE archived = 0 AND id = ?")) {
    const id = String(args[0] ?? "");
    return threads.find((thread) => thread.archived !== 1 && thread.id === id);
  }

  return undefined;
}

describe("codex-state", () => {
  it("findLatestDatabase returns null when no sqlite files exist", async () => {
    const state = await loadCodexState({ files: [] });

    expect(state.findLatestDatabase()).toBeNull();
  });

  it("findLatestDatabase returns the newest matching sqlite file", async () => {
    const home = "/Users/tester";
    const codexDir = path.join(home, ".codex");
    const older = path.join(codexDir, "state_old.sqlite");
    const newer = path.join(codexDir, "state_new.sqlite");
    const state = await loadCodexState({
      home,
      files: ["notes.txt", "state_old.sqlite", "state_new.sqlite"],
      stats: {
        [older]: 100,
        [newer]: 200,
      },
    });

    expect(state.findLatestDatabase()).toBe(newer);
  });

  it("findLatestDatabase falls back to USERPROFILE when HOME is not set", async () => {
    const home = "C:\\Users\\tester";
    const codexDir = path.join(home, ".codex");
    const databasePath = path.join(codexDir, "state_win.sqlite");
    const state = await loadCodexState({
      home,
      files: ["state_win.sqlite"],
      stats: {
        [databasePath]: 100,
      },
    });

    delete process.env.HOME;
    process.env.USERPROFILE = home;

    expect(state.findLatestDatabase()).toBe(databasePath);
  });

  it("listThreads returns an empty array when better-sqlite3 is unavailable", async () => {
    const state = await loadCodexState({ betterSqliteAvailable: false, files: ["state_main.sqlite"] });

    expect(state.listThreads()).toEqual([]);
  });

  it("listThreads returns mapped active thread records", async () => {
    const state = await loadCodexState({
      files: ["state_main.sqlite"],
      threads: [
        {
          id: "thread-1",
          title: "Newest",
          cwd: "/workspace/b",
          model: "gpt-5.4",
          reasoning_effort: "xhigh",
          sandbox_policy: JSON.stringify({ type: "workspace-write" }),
          approval_mode: "on-request",
          created_at: 1_700_000_000,
          updated_at: 1_700_000_200,
          first_user_message: "hello",
        },
        {
          id: "thread-2",
          title: "Archived",
          cwd: "/workspace/c",
          model: "o3",
          created_at: 1_700_000_000,
          updated_at: 1_700_000_300,
          first_user_message: "hidden",
          archived: 1,
        },
        {
          id: "thread-3",
          title: "Older",
          cwd: "/workspace/a",
          model: null,
          created_at: 1_700_000_000,
          updated_at: 1_700_000_100,
          first_user_message: "older",
        },
      ],
    });

    expect(state.listThreads(10)).toEqual([
      {
        id: "thread-1",
        title: "Newest",
        cwd: "/workspace/b",
        model: "gpt-5.4",
        reasoningEffort: "xhigh",
        sandboxMode: "workspace-write",
        approvalPolicy: "on-request",
        createdAt: new Date(1_700_000_000 * 1000),
        updatedAt: new Date(1_700_000_200 * 1000),
        firstUserMessage: "hello",
      },
      {
        id: "thread-3",
        title: "Older",
        cwd: "/workspace/a",
        model: null,
        reasoningEffort: null,
        sandboxMode: null,
        approvalPolicy: null,
        createdAt: new Date(1_700_000_000 * 1000),
        updatedAt: new Date(1_700_000_100 * 1000),
        firstUserMessage: "older",
      },
    ]);
  });

  it("listWorkspaces returns unique sorted active workspaces", async () => {
    const state = await loadCodexState({
      files: ["state_main.sqlite"],
      threads: [
        {
          id: "thread-1",
          title: "One",
          cwd: "/workspace/z",
          model: "o3",
          created_at: 1,
          updated_at: 2,
          first_user_message: "one",
        },
        {
          id: "thread-2",
          title: "Two",
          cwd: "/workspace/a",
          model: "o3",
          created_at: 1,
          updated_at: 3,
          first_user_message: "two",
        },
        {
          id: "thread-3",
          title: "Three",
          cwd: "/workspace/z",
          model: "o3",
          created_at: 1,
          updated_at: 4,
          first_user_message: "three",
        },
        {
          id: "thread-4",
          title: "Archived",
          cwd: "/workspace/b",
          model: "o3",
          created_at: 1,
          updated_at: 5,
          first_user_message: "archived",
          archived: 1,
        },
      ],
    });

    expect(state.listWorkspaces()).toEqual(["/workspace/a", "/workspace/z"]);
  });

  it("normalizes Windows extended-length workspace paths", async () => {
    const state = await loadCodexState({
      files: ["state_main.sqlite"],
      threads: [
        {
          id: "thread-1",
          title: "One",
          cwd: "\\\\?\\C:\\repo",
          model: "o3",
          created_at: 1,
          updated_at: 2,
          first_user_message: "one",
        },
        {
          id: "thread-2",
          title: "Two",
          cwd: "C:\\repo",
          model: "o3",
          created_at: 1,
          updated_at: 3,
          first_user_message: "two",
        },
      ],
    });

    expect(state.listThreads(2).map((thread) => thread.cwd)).toEqual(["C:\\repo", "C:\\repo"]);
    expect(state.listWorkspaces()).toEqual(["C:\\repo"]);
  });

  it("listModels parses models_cache.json and filters hidden models", async () => {
    const state = await loadCodexState({
      modelsJson: JSON.stringify({
        models: [
          { slug: "gpt-5.4", display_name: "GPT-5.4" },
          { slug: "secret", display_name: "Secret", visibility: "hidden" },
          { slug: "o3", display_name: "o3", visibility: "public" },
        ],
      }),
    });

    expect(state.listModels()).toEqual([
      { slug: "gpt-5.4", displayName: "GPT-5.4" },
      { slug: "o3", displayName: "o3" },
    ]);
  });

  it("listModels falls back when models_cache.json is absent or invalid", async () => {
    const noFileState = await loadCodexState();
    expect(noFileState.listModels()).toEqual(noFileState.FALLBACK_MODELS);

    const invalidState = await loadCodexState({ modelsJson: "{not-json" });
    expect(invalidState.listModels()).toEqual(invalidState.FALLBACK_MODELS);
  });

  it("getThreadUsage parses the latest token count event from rollout jsonl", async () => {
    const rolloutPath = "/Users/tester/.codex/sessions/2026/05/11/rollout-thread-1.jsonl";
    const state = await loadCodexState({
      files: ["state_main.sqlite"],
      threads: [
        {
          id: "thread-1",
          title: "One",
          cwd: "/workspace",
          rollout_path: rolloutPath,
          model: "gpt-5.5",
          created_at: 1,
          updated_at: 2,
          first_user_message: "hello",
        },
      ],
      fileContents: {
        [rolloutPath]: [
          JSON.stringify({
            timestamp: "2026-05-11T17:23:20.349Z",
            type: "event_msg",
            payload: {
              type: "token_count",
              info: {
                total_token_usage: {
                  input_tokens: 10,
                  cached_input_tokens: 5,
                  output_tokens: 2,
                  reasoning_output_tokens: 1,
                  total_tokens: 12,
                },
                last_token_usage: {
                  input_tokens: 10,
                  cached_input_tokens: 5,
                  output_tokens: 2,
                  reasoning_output_tokens: 1,
                  total_tokens: 12,
                },
                model_context_window: 1000,
              },
            },
          }),
          JSON.stringify({
            timestamp: "2026-05-11T17:24:20.349Z",
            type: "event_msg",
            payload: {
              type: "token_count",
              info: {
                total_token_usage: {
                  input_tokens: 1000,
                  cached_input_tokens: 700,
                  output_tokens: 100,
                  reasoning_output_tokens: 40,
                  total_tokens: 1100,
                },
                last_token_usage: {
                  input_tokens: 250,
                  cached_input_tokens: 100,
                  output_tokens: 50,
                  reasoning_output_tokens: 10,
                  total_tokens: 300,
                },
                model_context_window: 1000,
              },
              rate_limits: {
                limit_id: "codex",
                limit_name: null,
                primary: {
                  used_percent: 25,
                  window_minutes: 300,
                  resets_at: 1_778_535_489,
                },
                secondary: {
                  used_percent: 60,
                  window_minutes: 10080,
                  resets_at: 1_778_829_728,
                },
                plan_type: "pro",
              },
            },
          }),
        ].join("\n"),
      },
    });

    expect(state.getThreadUsage("thread-1")).toEqual({
      contextWindow: 1000,
      contextUsedPercent: 30,
      lastTokenUsage: {
        inputTokens: 250,
        cachedInputTokens: 100,
        outputTokens: 50,
        reasoningOutputTokens: 10,
        totalTokens: 300,
      },
      totalTokenUsage: {
        inputTokens: 1000,
        cachedInputTokens: 700,
        outputTokens: 100,
        reasoningOutputTokens: 40,
        totalTokens: 1100,
      },
      rateLimits: {
        limitId: "codex",
        limitName: null,
        planType: "pro",
        primary: {
          usedPercent: 25,
          remainingPercent: 75,
          windowMinutes: 300,
          resetsAt: new Date(1_778_535_489 * 1000),
        },
        secondary: {
          usedPercent: 60,
          remainingPercent: 40,
          windowMinutes: 10080,
          resetsAt: new Date(1_778_829_728 * 1000),
        },
      },
      updatedAt: new Date("2026-05-11T17:24:20.349Z"),
    });
  });

  it("getThreadActivity reports an active unclosed Codex task from rollout jsonl", async () => {
    const rolloutPath = "/Users/tester/.codex/sessions/2026/05/12/rollout-thread-1.jsonl";
    const state = await loadCodexState({
      files: ["state_main.sqlite"],
      threads: [
        {
          id: "thread-1",
          title: "One",
          cwd: "/workspace",
          rollout_path: rolloutPath,
          model: "gpt-5.5",
          created_at: 1,
          updated_at: 2,
          first_user_message: "hello",
        },
      ],
      stats: {
        [rolloutPath]: Date.parse("2026-05-12T04:00:20Z"),
      },
      fileContents: {
        [rolloutPath]: [
          JSON.stringify({
            timestamp: "2026-05-12T04:00:00.000Z",
            type: "event_msg",
            payload: {
              type: "task_started",
              turn_id: "turn-1",
              started_at: 1_778_558_400,
            },
          }),
          JSON.stringify({
            timestamp: "2026-05-12T04:00:10.000Z",
            type: "response_item",
            payload: {
              type: "reasoning",
            },
          }),
        ].join("\n"),
      },
    });

    expect(state.getThreadActivity("thread-1", {
      nowMs: Date.parse("2026-05-12T04:00:30Z"),
      staleAfterMs: 60_000,
    })).toEqual({
      threadId: "thread-1",
      rolloutPath,
      active: true,
      stale: false,
      turnId: "turn-1",
      startedAt: new Date("2026-05-12T04:00:00Z"),
      updatedAt: new Date("2026-05-12T04:00:20Z"),
    });
  });

  it("getThreadActivity clears activity when the task reaches a terminal event", async () => {
    const rolloutPath = "/Users/tester/.codex/sessions/2026/05/12/rollout-thread-1.jsonl";
    const state = await loadCodexState({
      files: ["state_main.sqlite"],
      threads: [
        {
          id: "thread-1",
          title: "One",
          cwd: "/workspace",
          rollout_path: rolloutPath,
          model: "gpt-5.5",
          created_at: 1,
          updated_at: 2,
          first_user_message: "hello",
        },
      ],
      fileContents: {
        [rolloutPath]: [
          JSON.stringify({
            timestamp: "2026-05-12T04:00:00.000Z",
            type: "event_msg",
            payload: {
              type: "task_started",
              turn_id: "turn-1",
              started_at: 1_778_558_400,
            },
          }),
          JSON.stringify({
            timestamp: "2026-05-12T04:00:15.000Z",
            type: "event_msg",
            payload: {
              type: "task_complete",
              turn_id: "turn-1",
            },
          }),
        ].join("\n"),
      },
    });

    expect(state.getThreadActivity("thread-1", {
      nowMs: Date.parse("2026-05-12T04:00:30Z"),
      staleAfterMs: 60_000,
    })).toMatchObject({
      active: false,
      stale: false,
      turnId: null,
      startedAt: null,
      updatedAt: new Date("2026-05-12T04:00:15Z"),
    });
  });

  it("getThreadActivity treats old unclosed tasks as stale instead of active", async () => {
    const rolloutPath = "/Users/tester/.codex/sessions/2026/05/12/rollout-thread-1.jsonl";
    const state = await loadCodexState({
      files: ["state_main.sqlite"],
      threads: [
        {
          id: "thread-1",
          title: "One",
          cwd: "/workspace",
          rollout_path: rolloutPath,
          model: "gpt-5.5",
          created_at: 1,
          updated_at: 2,
          first_user_message: "hello",
        },
      ],
      stats: {
        [rolloutPath]: Date.parse("2026-05-12T04:00:00Z"),
      },
      fileContents: {
        [rolloutPath]: JSON.stringify({
          timestamp: "2026-05-12T04:00:00.000Z",
          type: "event_msg",
          payload: {
            type: "task_started",
            turn_id: "turn-1",
            started_at: 1_778_558_400,
          },
        }),
      },
    });

    expect(state.getThreadActivity("thread-1", {
      nowMs: Date.parse("2026-05-12T04:10:01Z"),
      staleAfterMs: 5 * 60 * 1000,
    })).toMatchObject({
      active: false,
      stale: true,
      turnId: "turn-1",
    });
  });

  it("getThreadRolloutSnapshot returns timeline events after a line offset", async () => {
    const rolloutPath = "/Users/tester/.codex/sessions/2026/05/12/rollout-thread-1.jsonl";
    const state = await loadCodexState({
      files: ["state_main.sqlite"],
      threads: [
        {
          id: "thread-1",
          title: "One",
          cwd: "/workspace",
          rollout_path: rolloutPath,
          model: "gpt-5.5",
          created_at: 1,
          updated_at: 2,
          first_user_message: "hello",
        },
      ],
      fileContents: {
        [rolloutPath]: [
          JSON.stringify({
            timestamp: "2026-05-12T04:00:00.000Z",
            type: "event_msg",
            payload: { type: "task_started", turn_id: "turn-1", started_at: 1_778_558_400 },
          }),
          JSON.stringify({
            timestamp: "2026-05-12T04:00:01.000Z",
            type: "event_msg",
            payload: { type: "user_message", message: "build it" },
          }),
          JSON.stringify({
            timestamp: "2026-05-12T04:00:02.000Z",
            type: "response_item",
            payload: { type: "function_call", name: "exec_command", call_id: "call-1" },
          }),
          JSON.stringify({
            timestamp: "2026-05-12T04:00:03.000Z",
            type: "event_msg",
            payload: { type: "agent_message", message: "done", phase: "final_answer" },
          }),
          JSON.stringify({
            timestamp: "2026-05-12T04:00:04.000Z",
            type: "event_msg",
            payload: { type: "task_complete", turn_id: "turn-1", last_agent_message: "done" },
          }),
        ].join("\n"),
      },
    });

    const snapshot = state.getThreadRolloutSnapshot("thread-1", { afterLine: 2 });

    expect(snapshot).toMatchObject({
      threadId: "thread-1",
      rolloutPath,
      lineCount: 5,
      latestAgentMessage: "done",
      latestUserMessage: "build it",
      latestToolName: "exec_command",
      activity: {
        active: false,
        stale: false,
        turnId: null,
      },
    });
    expect(snapshot?.events.map((event) => [event.kind, event.type, event.text ?? event.toolName ?? event.status])).toEqual([
      ["tool", "function_call", "exec_command"],
      ["agent", "agent_message", "done"],
      ["task", "task_complete", "done"],
    ]);
  });

  it("detects pending external approval requests and clears them after tool output", async () => {
    const rolloutPath = "/Users/tester/.codex/sessions/2026/05/12/rollout-thread-approval.jsonl";
    const state = await loadCodexState({
      files: ["state_main.sqlite"],
      threads: [
        {
          id: "thread-approval",
          title: "Approval",
          cwd: "/workspace",
          rollout_path: rolloutPath,
          model: "gpt-5.5",
          created_at: 1,
          updated_at: 2,
          first_user_message: "open folder",
        },
      ],
      fileContents: {
        [rolloutPath]: [
          JSON.stringify({
            timestamp: "2026-05-12T04:00:00.000Z",
            type: "event_msg",
            payload: { type: "task_started", turn_id: "turn-approval", started_at: 1_778_558_400 },
          }),
          JSON.stringify({
            timestamp: "2026-05-12T04:00:01.000Z",
            type: "event_msg",
            payload: { type: "user_message", message: "open folder" },
          }),
          JSON.stringify({
            timestamp: "2026-05-12T04:00:02.000Z",
            type: "response_item",
            payload: {
              type: "function_call",
              name: "exec_command",
              call_id: "call-approval",
              arguments: JSON.stringify({
                cmd: "xdg-open /workspace",
                workdir: "/workspace",
                sandbox_permissions: "require_escalated",
                justification: "Open the current workspace.",
                prefix_rule: ["xdg-open"],
              }),
            },
          }),
        ].join("\n"),
      },
    });

    const pending = state.getThreadRolloutSnapshot("thread-approval", { maxEvents: 10 });

    expect(pending?.pendingApprovals).toHaveLength(1);
    expect(pending?.pendingApprovals[0]).toMatchObject({
      callId: "call-approval",
      toolName: "exec_command",
      command: "xdg-open /workspace",
      workdir: "/workspace",
      reason: "Open the current workspace.",
      prefixRule: ["xdg-open"],
      sandboxPermissions: "require_escalated",
      turnId: "turn-approval",
    });
    expect(pending?.events.some((event) => event.kind === "approval" && event.status === "pending")).toBe(true);

    const clearedState = await loadCodexState({
      files: ["state_main.sqlite"],
      threads: [
        {
          id: "thread-approval",
          title: "Approval",
          cwd: "/workspace",
          rollout_path: rolloutPath,
          model: "gpt-5.5",
          created_at: 1,
          updated_at: 2,
          first_user_message: "open folder",
        },
      ],
      fileContents: {
        [rolloutPath]: [
          JSON.stringify({
            timestamp: "2026-05-12T04:00:00.000Z",
            type: "event_msg",
            payload: { type: "task_started", turn_id: "turn-approval", started_at: 1_778_558_400 },
          }),
          JSON.stringify({
            timestamp: "2026-05-12T04:00:01.000Z",
            type: "event_msg",
            payload: { type: "user_message", message: "open folder" },
          }),
          JSON.stringify({
            timestamp: "2026-05-12T04:00:02.000Z",
            type: "response_item",
            payload: {
              type: "function_call",
              name: "exec_command",
              call_id: "call-approval",
              arguments: JSON.stringify({
                cmd: "xdg-open /workspace",
                sandbox_permissions: "require_escalated",
              }),
            },
          }),
          JSON.stringify({
            timestamp: "2026-05-12T04:00:03.000Z",
            type: "response_item",
            payload: { type: "function_call_output", call_id: "call-approval", output: "" },
          }),
        ].join("\n"),
      },
    });

    const cleared = clearedState.getThreadRolloutSnapshot("thread-approval", { maxEvents: 10 });
    expect(cleared?.pendingApprovals).toEqual([]);
  });

  it("getThreadRolloutSnapshot limits retained timeline events while keeping latest rollout state", async () => {
    const rolloutPath = "/Users/tester/.codex/sessions/2026/05/12/rollout-thread-1.jsonl";
    const state = await loadCodexState({
      files: ["state_main.sqlite"],
      threads: [
        {
          id: "thread-1",
          title: "One",
          cwd: "/workspace",
          rollout_path: rolloutPath,
          model: "gpt-5.5",
          created_at: 1,
          updated_at: 2,
          first_user_message: "hello",
        },
      ],
      fileContents: {
        [rolloutPath]: [
          JSON.stringify({
            timestamp: "2026-05-12T04:00:00.000Z",
            type: "event_msg",
            payload: { type: "task_started", turn_id: "turn-1", started_at: 1_778_558_400 },
          }),
          JSON.stringify({
            timestamp: "2026-05-12T04:00:01.000Z",
            type: "event_msg",
            payload: { type: "user_message", message: "build it" },
          }),
          JSON.stringify({
            timestamp: "2026-05-12T04:00:02.000Z",
            type: "response_item",
            payload: { type: "function_call", name: "exec_command", call_id: "call-1" },
          }),
          JSON.stringify({
            timestamp: "2026-05-12T04:00:03.000Z",
            type: "event_msg",
            payload: { type: "agent_message", message: "done", phase: "final_answer" },
          }),
          JSON.stringify({
            timestamp: "2026-05-12T04:00:04.000Z",
            type: "event_msg",
            payload: { type: "task_complete", turn_id: "turn-1", last_agent_message: "done" },
          }),
        ].join("\n"),
      },
    });

    const snapshot = state.getThreadRolloutSnapshot("thread-1", { maxEvents: 2 });

    expect(snapshot).toMatchObject({
      lineCount: 5,
      latestAgentMessage: "done",
      latestUserMessage: "build it",
      latestToolName: "exec_command",
    });
    expect(snapshot?.events.map((event) => [event.kind, event.type, event.text ?? event.status])).toEqual([
      ["agent", "agent_message", "done"],
      ["task", "task_complete", "done"],
    ]);
  });

  it("getThread returns null when not found", async () => {
    const state = await loadCodexState({ files: ["state_main.sqlite"], threads: [] });

    expect(state.getThread("missing")).toBeNull();
  });

  it("returns empty results gracefully when opening the database fails", async () => {
    const state = await loadCodexState({ files: ["state_main.sqlite"], openThrows: true });

    expect(state.listThreads()).toEqual([]);
    expect(state.listWorkspaces()).toEqual([]);
    expect(state.getThread("thread-1")).toBeNull();
  });
});
