import path from "node:path";

import { vi } from "vitest";

import { createDefaultLaunchProfile, createLaunchProfile } from "../src/agents/codex/codex-launch.js";
import type { ConnectorConfig } from "../src/core/config.js";

const mockFsState = vi.hoisted(() => {
  const files = new Map<string, string>();
  const directories = new Set<string>();

  return {
    files,
    directories,
    reset: () => {
      files.clear();
      directories.clear();
    },
  };
});

const mockSessionState = vi.hoisted(() => {
  const create = vi.fn();
  const sessions: Array<{
    getInfo: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    isProcessing: ReturnType<typeof vi.fn>;
    newThread: ReturnType<typeof vi.fn>;
    setInfo: (next: Partial<{
      threadId: string | null;
      workspace: string;
      model?: string;
      reasoningEffort?: string;
      launchProfileId: string;
      launchProfileLabel: string;
      launchProfileBehavior: string;
      sandboxMode: string;
      approvalPolicy: string;
      unsafeLaunch: boolean;
      nextLaunchProfileId?: string;
      nextLaunchProfileLabel?: string;
      nextLaunchProfileBehavior?: string;
      nextUnsafeLaunch?: boolean;
    }>) => void;
  }> = [];

  const reset = () => {
    create.mockReset();
    sessions.length = 0;
  };

  return {
    create,
    sessions,
    reset,
  };
});

vi.mock("node:fs", () => ({
  existsSync: vi.fn((targetPath: string) => mockFsState.files.has(targetPath) || mockFsState.directories.has(targetPath)),
  mkdirSync: vi.fn((targetPath: string) => {
    mockFsState.directories.add(targetPath);
  }),
  chmodSync: vi.fn(),
  statSync: vi.fn(() => ({ mtimeMs: Date.now() })),
  readFileSync: vi.fn((targetPath: string) => {
    const content = mockFsState.files.get(targetPath);
    if (content === undefined) {
      throw new Error(`ENOENT: ${targetPath}`);
    }
    return content;
  }),
  writeFileSync: vi.fn((targetPath: string, content: string) => {
    mockFsState.files.set(targetPath, content);
    mockFsState.directories.add(path.dirname(targetPath));
  }),
  copyFileSync: vi.fn((sourcePath: string, targetPath: string) => {
    const content = mockFsState.files.get(sourcePath);
    if (content === undefined) {
      throw new Error(`ENOENT: ${sourcePath}`);
    }
    mockFsState.files.set(targetPath, content);
  }),
  renameSync: vi.fn((sourcePath: string, targetPath: string) => {
    const content = mockFsState.files.get(sourcePath);
    if (content === undefined) {
      throw new Error(`ENOENT: ${sourcePath}`);
    }
    mockFsState.files.set(targetPath, content);
    mockFsState.files.delete(sourcePath);
  }),
  rmSync: vi.fn((targetPath: string) => {
    mockFsState.files.delete(targetPath);
    mockFsState.directories.delete(targetPath);
  }),
}));

vi.mock("../src/agents/codex/codex-session.js", () => ({
  CodexSessionService: {
    create: mockSessionState.create,
  },
}));

import { SessionRegistry } from "../src/state/session-registry.js";

describe("SessionRegistry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const createConfig = (overrides: Partial<ConnectorConfig> = {}): ConnectorConfig => ({
    telegramBotToken: "bot-token",
    telegramRateLimitMinIntervalMs: 80,
    telegramEditMinIntervalMs: 1_200,
    mirrorMode: "status",
    mirrorMinUpdateMs: 4_000,
    notifyMode: "minimal",
    quietHours: null,
    autoSendArtifacts: false,
    telegramMirrorMode: "status",
    telegramMirrorMinUpdateMs: 4_000,
    telegramNotifyMode: "minimal",
    telegramQuietHours: null,
    telegramRedactPatterns: [],
    discordEnabled: false,
    discordBotToken: undefined,
    discordClientId: undefined,
    discordGuildIds: [],
    discordAllowedGuildIds: [],
    discordAllowedChannelIds: [],
    discordMessageContentEnabled: true,
    discordCommandMode: "both",
    discordAutoRegisterCommands: true,
    discordMirrorMode: "status",
    discordMirrorMinUpdateMs: 4_000,
    discordNotifyMode: "minimal",
    discordQuietHours: null,
    discordAutoSendArtifacts: false,
    workspace: "/workspace/base",
    workspaceAllowedRoots: [],
    workspaceWarnRoots: [],
    maxFileSize: 20 * 1024 * 1024,
    artifactRetentionDays: 7,
    artifactMaxTurnDirs: 30,
    artifactMaxInboxDirs: 30,
    artifactIgnoreDirs: [],
    artifactIgnoreGlobs: [],
    telegramAutoSendArtifacts: false,
    codexApiKey: "codex-key",
    codexModel: "o3",
    codexSyncIntervalMs: 10_000,
    codexExternalBusyCheckMs: 5_000,
    codexExternalBusyStaleMs: 300_000,
    codexSandboxMode: "workspace-write",
    codexApprovalPolicy: "never",
    launchProfiles: [
      createDefaultLaunchProfile("workspace-write", "never"),
      createLaunchProfile({
        id: "readonly",
        label: "Read Only",
        sandboxMode: "read-only",
        approvalPolicy: "never",
      }),
    ],
    defaultLaunchProfileId: "default",
    enableUnsafeLaunchProfiles: false,
    toolVerbosity: "summary",
    logFormat: "text",
    showTurnTokenUsage: false,
    enableTelegramLogin: true,
    enableTelegramReactions: false,
    voicePreferredBackend: "auto",
    voiceDefaultLanguage: undefined,
    voiceTranscribeOnly: false,
    ...overrides,
  });

  const createMockSession = (info: {
    threadId: string | null;
    workspace: string;
    model?: string;
    reasoningEffort?: string;
    launchProfileId: string;
    launchProfileLabel: string;
    launchProfileBehavior: string;
    sandboxMode: string;
    approvalPolicy: string;
    unsafeLaunch: boolean;
  }) => {
    let currentInfo = { ...info };
    const session = {
      getInfo: vi.fn(() => ({ ...currentInfo })),
      dispose: vi.fn(),
      isProcessing: vi.fn(() => false),
      newThread: vi.fn(async (workspace?: string, model?: string) => {
        currentInfo = {
          ...currentInfo,
          threadId: "thread-new",
          workspace: workspace ?? currentInfo.workspace,
          model: model ?? currentInfo.model,
        };
        return { ...currentInfo };
      }),
      syncFromAgentState: vi.fn(() => ({
        threadId: currentInfo.threadId,
        changed: false,
        reattached: false,
        changedFields: [],
        info: { ...currentInfo },
      })),
      setInfo: (next: Partial<typeof currentInfo>) => {
        currentInfo = { ...currentInfo, ...next };
      },
    };
    mockSessionState.sessions.push(session);
    return session;
  };

  beforeEach(() => {
    mockFsState.reset();
    mockSessionState.reset();
    mockSessionState.create.mockImplementation(async (config: ConnectorConfig, options?: {
      workspace?: string;
      model?: string;
      reasoningEffort?: string;
      launchProfileId?: string;
      resumeThreadId?: string;
    }) =>
      createMockSession({
        threadId: options?.resumeThreadId ?? null,
        workspace: options?.workspace ?? config.workspace,
        model: options?.model ?? config.codexModel,
        reasoningEffort: options?.reasoningEffort,
        launchProfileId: options?.launchProfileId ?? config.defaultLaunchProfileId,
        launchProfileLabel: options?.launchProfileId === "readonly" ? "Read Only" : "Default",
        launchProfileBehavior: options?.launchProfileId === "readonly" ? "read-only / never" : "workspace-write / never",
        sandboxMode: options?.launchProfileId === "readonly" ? "read-only" : "workspace-write",
        approvalPolicy: "never",
        unsafeLaunch: false,
      }),
    );
  });

  it("returns the same session instance for the same context key", async () => {
    const registry = new SessionRegistry(createConfig());

    const first = await registry.getOrCreate("123");
    const second = await registry.getOrCreate("123");

    expect(first).toBe(second);
    expect(mockSessionState.create).toHaveBeenCalledTimes(1);
  });

  it("returns different session instances for different context keys", async () => {
    const registry = new SessionRegistry(createConfig());

    const first = await registry.getOrCreate("123");
    const second = await registry.getOrCreate("123:42");

    expect(first).not.toBe(second);
    expect(mockSessionState.create).toHaveBeenCalledTimes(2);
  });

  it("two topic contexts in the same chat maintain independent sessions", async () => {
    const registry = new SessionRegistry(createConfig());

    const first = await registry.getOrCreate("67890:1");
    const second = await registry.getOrCreate("67890:2");

    expect(first).not.toBe(second);
    expect(registry.has("67890:1")).toBe(true);
    expect(registry.has("67890:2")).toBe(true);
  });

  it("removing one topic context does not affect another in the same chat", async () => {
    const registry = new SessionRegistry(createConfig());

    await registry.getOrCreate("67890:1");
    await registry.getOrCreate("67890:2");
    registry.remove("67890:1");

    expect(registry.has("67890:1")).toBe(false);
    expect(registry.has("67890:2")).toBe(true);
  });

  it("restores distinct per-context workspace, model, reasoning effort, and thread ids", async () => {
    const persistPath = path.join("/workspace/base", ".nordrelay", "contexts.json");
    mockFsState.files.set(
      persistPath,
      JSON.stringify([
        {
          contextKey: "123",
          threadId: "thread-a",
          workspace: "/workspace/a",
          model: "o4-mini",
          reasoningEffort: "low",
          launchProfileId: "readonly",
          updatedAt: 10,
        },
        {
          contextKey: "123:42",
          threadId: "thread-b",
          workspace: "/workspace/b",
          model: "gpt-5.4",
          reasoningEffort: "high",
          launchProfileId: "default",
          updatedAt: 20,
        },
      ]),
    );

    const registry = new SessionRegistry(createConfig());

    const first = await registry.getOrCreate("123");
    const second = await registry.getOrCreate("123:42");

    expect(mockSessionState.create).toHaveBeenNthCalledWith(1, createConfig(), {
      workspace: "/workspace/a",
      model: "o4-mini",
      reasoningEffort: "low",
      launchProfileId: "readonly",
      resumeThreadId: "thread-a",
    });
    expect(mockSessionState.create).toHaveBeenNthCalledWith(2, createConfig(), {
      workspace: "/workspace/b",
      model: "gpt-5.4",
      reasoningEffort: "high",
      launchProfileId: "default",
      resumeThreadId: "thread-b",
    });
    expect(first.getInfo()).toEqual({
      threadId: "thread-a",
      workspace: "/workspace/a",
      model: "o4-mini",
      reasoningEffort: "low",
      launchProfileId: "readonly",
      launchProfileLabel: "Read Only",
      launchProfileBehavior: "read-only / never",
      sandboxMode: "read-only",
      approvalPolicy: "never",
      unsafeLaunch: false,
    });
    expect(second.getInfo()).toEqual({
      threadId: "thread-b",
      workspace: "/workspace/b",
      model: "gpt-5.4",
      reasoningEffort: "high",
      launchProfileId: "default",
      launchProfileLabel: "Default",
      launchProfileBehavior: "workspace-write / never",
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      unsafeLaunch: false,
    });
  });

  it("falls back to the default launch profile when persisted metadata references a missing profile", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const persistPath = path.join("/workspace/base", ".nordrelay", "contexts.json");
    mockFsState.files.set(
      persistPath,
      JSON.stringify([
        {
          contextKey: "123",
          threadId: "thread-a",
          workspace: "/workspace/a",
          launchProfileId: "missing",
          updatedAt: 10,
        },
      ]),
    );

    const registry = new SessionRegistry(createConfig());
    await registry.getOrCreate("123");

    expect(mockSessionState.create).toHaveBeenCalledWith(createConfig(), {
      workspace: "/workspace/a",
      model: undefined,
      reasoningEffort: undefined,
      launchProfileId: undefined,
      resumeThreadId: "thread-a",
    });
    expect(warnSpy).toHaveBeenCalledWith(
      'Unknown persisted launch profile "missing" for 123. Falling back to default.',
    );
  });

  it("passes persisted active launch overrides separately from the next launch profile", async () => {
    const config = createConfig();
    mockFsState.files.set(
      path.join(config.workspace, ".nordrelay", "contexts.json"),
      JSON.stringify([
        {
          contextKey: "123",
          threadId: "thread-a",
          workspace: "/workspace/a",
          activeLaunchProfileId: "full-access",
          launchProfileId: "readonly",
          updatedAt: 10,
        },
      ]),
    );

    const registry = new SessionRegistry(config);
    await registry.getOrCreate("123");

    expect(mockSessionState.create).toHaveBeenCalledWith(config, expect.objectContaining({
      workspace: "/workspace/a",
      launchProfileId: "readonly",
      activeLaunchProfileId: "full-access",
      resumeThreadId: "thread-a",
    }));
  });

  it("updates metadata and lists contexts sorted by newest first", async () => {
    const registry = new SessionRegistry(createConfig());
    const first = (await registry.getOrCreate("123")) as any;
    const second = (await registry.getOrCreate("123:42")) as any;
    const dateNowSpy = vi.spyOn(Date, "now");

    first.setInfo({
      threadId: "thread-a",
      workspace: "/workspace/a",
      model: "o4-mini",
      launchProfileId: "readonly",
      launchProfileLabel: "Read Only",
      launchProfileBehavior: "read-only / never",
      sandboxMode: "read-only",
      approvalPolicy: "never",
      unsafeLaunch: false,
    });
    dateNowSpy.mockReturnValueOnce(1000);
    registry.updateMetadata("123", first as any);

    second.setInfo({
      threadId: "thread-b",
      workspace: "/workspace/b",
      model: "gpt-5.4",
      reasoningEffort: "high",
      launchProfileId: "default",
      launchProfileLabel: "Default",
      launchProfileBehavior: "workspace-write / never",
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      unsafeLaunch: false,
    });
    dateNowSpy.mockReturnValueOnce(2000);
    registry.updateMetadata("123:42", second as any);

    expect(registry.listContexts()).toEqual([
      {
        contextKey: "123:42",
        agentId: "codex",
        threadId: "thread-b",
        workspace: "/workspace/b",
        workspaceMode: "shared",
        model: "gpt-5.4",
        reasoningEffort: "high",
        activeLaunchProfileId: "default",
        launchProfileLabel: "Default",
        launchProfileBehavior: "workspace-write / never",
        sandboxMode: "workspace-write",
        approvalPolicy: "never",
        unsafeLaunch: false,
        launchProfileId: "default",
        updatedAt: 2000,
      },
      {
        contextKey: "123",
        agentId: "codex",
        threadId: "thread-a",
        workspace: "/workspace/a",
        workspaceMode: "shared",
        model: "o4-mini",
        reasoningEffort: undefined,
        activeLaunchProfileId: "readonly",
        launchProfileLabel: "Read Only",
        launchProfileBehavior: "read-only / never",
        sandboxMode: "read-only",
        approvalPolicy: "never",
        unsafeLaunch: false,
        launchProfileId: "readonly",
        updatedAt: 1000,
      },
    ]);
  });

  it("persists the next selected launch profile when it differs from the active thread profile", async () => {
    const registry = new SessionRegistry(createConfig());
    const session = (await registry.getOrCreate("123")) as any;

    session.setInfo({
      threadId: "thread-a",
      workspace: "/workspace/a",
      launchProfileId: "default",
      launchProfileLabel: "Default",
      launchProfileBehavior: "workspace-write / never",
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      unsafeLaunch: false,
      nextLaunchProfileId: "readonly",
      nextLaunchProfileLabel: "Read Only",
      nextLaunchProfileBehavior: "read-only / never",
      nextUnsafeLaunch: false,
    });
    registry.updateMetadata("123", session as any);

    expect(registry.listContexts()).toEqual([
      {
        contextKey: "123",
        agentId: "codex",
        threadId: "thread-a",
        workspace: "/workspace/a",
        workspaceMode: "shared",
        model: "o3",
        reasoningEffort: undefined,
        activeLaunchProfileId: "default",
        launchProfileLabel: "Default",
        launchProfileBehavior: "workspace-write / never",
        sandboxMode: "workspace-write",
        approvalPolicy: "never",
        unsafeLaunch: false,
        launchProfileId: "readonly",
        nextLaunchProfileLabel: "Read Only",
        nextLaunchProfileBehavior: "read-only / never",
        nextUnsafeLaunch: false,
        updatedAt: expect.any(Number),
      },
    ]);
  });

  it("pins and unpins threads per context", () => {
    const registry = new SessionRegistry(createConfig());

    expect(registry.pinThread("123", "thread-a")).toEqual(["thread-a"]);
    expect(registry.pinThread("123", "thread-b")).toEqual(["thread-a", "thread-b"]);
    expect(registry.pinThread("123", "thread-a")).toEqual(["thread-a", "thread-b"]);
    expect(registry.listPinnedThreadIds("123")).toEqual(["thread-a", "thread-b"]);
    expect(registry.unpinThread("123", "thread-a")).toEqual(["thread-b"]);
    expect(registry.listPinnedThreadIds("123")).toEqual(["thread-b"]);
  });

  it("starts new sessions in isolated worktrees when requested", async () => {
    const config = createConfig({
      sessionWorkspaceMode: "worktree",
      sessionWorktreeRoot: "/workspace/worktrees",
      sessionWorktreeBranchPrefix: "nr/test",
    });
    const record = {
      id: "wt-1",
      mode: "worktree",
      status: "active",
      agentId: "codex",
      contextKey: "123",
      threadId: null,
      sourceWorkspace: "/workspace/base",
      repoRoot: "/workspace/base",
      repoName: "base",
      baseSha: "base-sha",
      branchName: "nr/test/base/wt-1",
      worktreePath: "/workspace/worktrees/base/wt-1",
      createdAt: "2026-05-18T00:00:00.000Z",
      updatedAt: "2026-05-18T00:00:00.000Z",
    };
    const worktreeService = {
      create: vi.fn(() => record),
      linkThread: vi.fn(() => ({ ...record, threadId: "thread-new" })),
      getByThreadId: vi.fn(() => undefined),
      getByWorkspace: vi.fn((workspace: string | undefined) => workspace === record.worktreePath ? record : undefined),
    };
    const registry = new SessionRegistry(config, { worktreeService: worktreeService as any });
    const session = await registry.getOrCreate("123", { deferThreadStart: true }) as any;

    await registry.startNewThread("123", session);

    expect(worktreeService.create).toHaveBeenCalledWith({
      contextKey: "123",
      agentId: "codex",
      sourceWorkspace: "/workspace/base",
    });
    expect(session.newThread).toHaveBeenCalledWith(record.worktreePath, undefined);
    expect(worktreeService.linkThread).toHaveBeenCalledWith("wt-1", "thread-new", "codex", "123");
    expect(registry.listContexts()[0]).toEqual(expect.objectContaining({
      threadId: "thread-new",
      workspace: record.worktreePath,
      workspaceMode: "worktree",
      worktreeId: "wt-1",
    }));
  });

  it("syncs loaded sessions from Codex state and updates changed metadata", async () => {
    const registry = new SessionRegistry(createConfig());
    const session = (await registry.getOrCreate("123")) as any;
    session.syncFromAgentState.mockReturnValueOnce({
      threadId: "thread-synced",
      changed: true,
      reattached: true,
      changedFields: ["model"],
      info: {
        threadId: "thread-synced",
        workspace: "/workspace/base",
        model: "gpt-5.5",
        launchProfileId: "default",
        launchProfileLabel: "Default",
        launchProfileBehavior: "workspace-write / never",
        sandboxMode: "workspace-write",
        approvalPolicy: "never",
        fastMode: true,
        unsafeLaunch: false,
      },
    });
    session.setInfo({ threadId: "thread-synced", model: "gpt-5.5" });

    const results = registry.syncAllFromAgentState({ reattach: true });

    expect(results).toHaveLength(1);
    expect(session.syncFromAgentState).toHaveBeenCalledWith({ reattach: true });
    expect(registry.listContexts()[0]).toEqual(expect.objectContaining({
      threadId: "thread-synced",
      model: "gpt-5.5",
    }));
  });

  it("removes a context and disposes its session", async () => {
    const registry = new SessionRegistry(createConfig());
    const session = await registry.getOrCreate("123");

    registry.updateMetadata("123", session as any);
    registry.remove("123");

    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(registry.has("123")).toBe(false);
    expect(registry.listContexts()).toEqual([]);
  });

  it("persists metadata and reloads it in a new registry", async () => {
    const config = createConfig();
    const persistPath = path.join(config.workspace, ".nordrelay", "contexts.json");
    const registry = new SessionRegistry(config);
    const session = (await registry.getOrCreate("123")) as any;

    session.setInfo({
      threadId: "thread-a",
      workspace: "/workspace/a",
      model: "o4-mini",
      reasoningEffort: "medium",
      launchProfileId: "default",
      launchProfileLabel: "Default",
      launchProfileBehavior: "workspace-write / never",
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      unsafeLaunch: false,
    });
    registry.updateMetadata("123", session as any);

    expect(mockFsState.files.get(persistPath)).toContain("thread-a");

    const reloaded = new SessionRegistry(config);
    expect(reloaded.listContexts()).toEqual([
      {
        contextKey: "123",
        agentId: "codex",
        threadId: "thread-a",
        workspace: "/workspace/a",
        workspaceMode: "shared",
        model: "o4-mini",
        reasoningEffort: "medium",
        activeLaunchProfileId: "default",
        launchProfileLabel: "Default",
        launchProfileBehavior: "workspace-write / never",
        sandboxMode: "workspace-write",
        approvalPolicy: "never",
        unsafeLaunch: false,
        launchProfileId: "default",
        updatedAt: expect.any(Number),
      },
    ]);
  });

  it("warns when persisted metadata cannot be loaded", () => {
    const config = createConfig();
    const persistPath = path.join(config.workspace, ".nordrelay", "contexts.json");
    mockFsState.files.set(persistPath, "{broken");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const registry = new SessionRegistry(config);

    expect(registry.listContexts()).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      "Failed to load persisted context metadata:",
      expect.stringContaining("Cannot read state file"),
    );
  });

  it("merges persisted metadata instead of overwriting unrelated contexts", async () => {
    const config = createConfig();
    const persistPath = path.join(config.workspace, ".nordrelay", "contexts.json");
    mockFsState.files.set(persistPath, JSON.stringify([
      {
        contextKey: "telegram:1",
        agentId: "codex",
        threadId: "thread-existing",
        workspace: "/workspace/existing",
        workspaceMode: "shared",
        updatedAt: 1,
      },
    ]));
    const registry = new SessionRegistry(config, {
      fileName: "web-contexts.json",
      sqliteKey: "web-contexts",
    });
    const dashboardPath = path.join(config.workspace, ".nordrelay", "web-contexts.json");
    mockFsState.files.set(dashboardPath, JSON.stringify([
      {
        contextKey: "web:other",
        agentId: "codex",
        threadId: "thread-other",
        workspace: "/workspace/other",
        workspaceMode: "shared",
        updatedAt: 2,
      },
    ]));
    const session = (await registry.getOrCreate("web:dashboard")) as any;

    session.setInfo({ threadId: "thread-dashboard", workspace: "/workspace/dashboard" });
    registry.updateMetadata("web:dashboard", session as any);

    const saved = JSON.parse(mockFsState.files.get(dashboardPath) ?? "[]");
    expect(saved.map((entry: { contextKey: string }) => entry.contextKey).sort()).toEqual(["web:dashboard", "web:other"]);
    expect(mockFsState.files.get(persistPath)).toContain("thread-existing");
  });

  it("supports separate metadata stores for dashboard contexts", async () => {
    const config = createConfig();
    const telegramPath = path.join(config.workspace, ".nordrelay", "contexts.json");
    const dashboardPath = path.join(config.workspace, ".nordrelay", "web-contexts.json");
    const registry = new SessionRegistry(config, {
      fileName: "web-contexts.json",
      sqliteKey: "web-contexts",
    });
    const session = (await registry.getOrCreate("web:dashboard")) as any;

    session.setInfo({
      threadId: "thread-web",
      workspace: "/workspace/web",
      model: "gpt-5.5",
      reasoningEffort: "xhigh",
      launchProfileId: "default",
      launchProfileLabel: "Default",
      launchProfileBehavior: "workspace-write / never",
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      unsafeLaunch: false,
    });
    registry.updateMetadata("web:dashboard", session as any);

    expect(mockFsState.files.get(dashboardPath)).toContain("thread-web");
    expect(mockFsState.files.has(telegramPath)).toBe(false);
  });

  it("disposeAll disposes all sessions and clears the map", async () => {
    const registry = new SessionRegistry(createConfig());

    await registry.getOrCreate("100");
    await registry.getOrCreate("200");

    expect(registry.has("100")).toBe(true);
    expect(registry.has("200")).toBe(true);

    registry.disposeAll();

    expect(registry.has("100")).toBe(false);
    expect(registry.has("200")).toBe(false);
  });

  it("remove fires onRemove callback", async () => {
    const registry = new SessionRegistry(createConfig());

    await registry.getOrCreate("100");
    const removed: string[] = [];
    registry.onRemove((key) => removed.push(key));

    registry.remove("100");

    expect(removed).toEqual(["100"]);
    expect(registry.has("100")).toBe(false);
  });
});
