import { vi } from "vitest";

import { createDefaultLaunchProfile, createLaunchProfile } from "../src/agents/codex/codex-launch.js";
import type { ConnectorConfig } from "../src/core/config.js";

const mockCodexState = vi.hoisted(() => {
  const getThread = vi.fn();
  const getThreadRolloutSnapshot = vi.fn().mockReturnValue(null);
  const getThreadUsage = vi.fn().mockReturnValue(null);
  const listThreads = vi.fn().mockReturnValue([]);
  const listWorkspaces = vi.fn().mockReturnValue([]);
  const listModels = vi.fn().mockReturnValue([]);

  return {
    getThread,
    getThreadRolloutSnapshot,
    getThreadUsage,
    listThreads,
    listWorkspaces,
    listModels,
    reset: () => {
      getThread.mockReset();
      getThread.mockReturnValue(null);
      getThreadRolloutSnapshot.mockReset();
      getThreadRolloutSnapshot.mockReturnValue(null);
      getThreadUsage.mockReset();
      getThreadUsage.mockReturnValue(null);
      listThreads.mockReset();
      listThreads.mockReturnValue([]);
      listWorkspaces.mockReset();
      listWorkspaces.mockReturnValue([]);
      listModels.mockReset();
      listModels.mockReturnValue([]);
    },
  };
});

const mockCodexConfig = vi.hoisted(() => {
  const normalizeCodexServiceTier = vi.fn().mockReturnValue(false);
  const readCodexFastMode = vi.fn().mockReturnValue(null);
  const writeCodexFastMode = vi.fn();

  return {
    normalizeCodexServiceTier,
    readCodexFastMode,
    writeCodexFastMode,
    reset: () => {
      normalizeCodexServiceTier.mockReset();
      normalizeCodexServiceTier.mockReturnValue(false);
      readCodexFastMode.mockReset();
      readCodexFastMode.mockReturnValue(null);
      writeCodexFastMode.mockReset();
    },
  };
});

const mockState = vi.hoisted(() => {
  const createdCodexOptions: any[] = [];
  const codexInstances: any[] = [];
  const createdThreads: any[] = [];

  const createEmptyEvents = () =>
    (async function* () {
      // empty
    })();

  const createThread = (id: string | null, options: any) => {
    const thread = {
      id,
      options,
      runStreamed: vi.fn().mockResolvedValue({ events: createEmptyEvents() }),
    };
    createdThreads.push(thread);
    return thread;
  };

  const Codex = vi.fn(function (this: unknown, options: any) {
    createdCodexOptions.push(options);

    const instance = {
      startThread: vi.fn().mockImplementation((threadOptions: any) => createThread(null, threadOptions)),
      resumeThread: vi
        .fn()
        .mockImplementation((threadId: string, threadOptions: any) => createThread(threadId, threadOptions)),
    };

    codexInstances.push(instance);
    return instance;
  });

  return {
    Codex,
    createdCodexOptions,
    codexInstances,
    createdThreads,
    reset: () => {
      createdCodexOptions.length = 0;
      codexInstances.length = 0;
      createdThreads.length = 0;
      Codex.mockClear();
    },
  };
});

vi.mock("@openai/codex-sdk", () => ({
  Codex: mockState.Codex,
}));

vi.mock("../src/agents/codex/codex-state.js", () => ({
  getThread: mockCodexState.getThread,
  getThreadRolloutSnapshot: mockCodexState.getThreadRolloutSnapshot,
  getThreadUsage: mockCodexState.getThreadUsage,
  listThreads: mockCodexState.listThreads,
  listWorkspaces: mockCodexState.listWorkspaces,
  listModels: mockCodexState.listModels,
}));

vi.mock("../src/agents/codex/codex-config.js", () => ({
  normalizeCodexServiceTier: mockCodexConfig.normalizeCodexServiceTier,
  readCodexFastMode: mockCodexConfig.readCodexFastMode,
  writeCodexFastMode: mockCodexConfig.writeCodexFastMode,
}));

import { CodexSessionService } from "../src/agents/codex/codex-session.js";

describe("CodexSessionService", () => {
  const usage = {
    input_tokens: 1,
    cached_input_tokens: 0,
    output_tokens: 1,
  };

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
      createLaunchProfile({
        id: "review",
        label: "Review",
        sandboxMode: "workspace-write",
        approvalPolicy: "on-request",
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

  const createCallbacks = () => ({
    onTextDelta: vi.fn(),
    onToolStart: vi.fn(),
    onToolUpdate: vi.fn(),
    onToolEnd: vi.fn(),
    onAssistantMessageComplete: vi.fn(),
    onAgentEnd: vi.fn(),
    onTodoUpdate: vi.fn(),
    onTurnComplete: vi.fn(),
  });

  const streamEvents = (events: any[]) =>
    (async function* () {
      for (const event of events) {
        yield event;
      }
    })();

  beforeEach(() => {
    mockState.reset();
    mockCodexState.reset();
    mockCodexConfig.reset();
  });

  it("creates the service and starts an initial thread", async () => {
    const service = await CodexSessionService.create(createConfig());

    expect(mockState.Codex).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "codex-key",
        config: { approval_policy: "never" },
        env: expect.objectContaining({ CODEX_API_KEY: "codex-key" }),
      }),
    );

    const codexInstance = mockState.codexInstances[0];
    expect(codexInstance.startThread).toHaveBeenCalledWith({
      model: "o3",
      sandboxMode: "workspace-write",
      workingDirectory: "/workspace/base",
      approvalPolicy: "never",
      skipGitRepoCheck: true,
    });

    expect(service.getInfo()).toEqual({
      threadId: null,
      workspace: "/workspace/base",
      model: "o3",
      launchProfileId: "default",
      launchProfileLabel: "Default",
      launchProfileBehavior: "workspace-write / never",
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      fastMode: false,
      unsafeLaunch: false,
    });
  });

  it("create accepts overrides for workspace, model, reasoning effort, launch profile, and resumeThreadId", async () => {
    const service = await CodexSessionService.create(createConfig(), {
      workspace: "/workspace/resumed",
      model: "gpt-5.4",
      reasoningEffort: "high",
      launchProfileId: "readonly",
      resumeThreadId: "thread-resume",
    });

    const codexInstance = mockState.codexInstances[0];
    expect(codexInstance.startThread).toHaveBeenCalledTimes(0);
    expect(codexInstance.resumeThread).toHaveBeenCalledWith("thread-resume", {
      model: "gpt-5.4",
      sandboxMode: "read-only",
      workingDirectory: "/workspace/resumed",
      approvalPolicy: "never",
      skipGitRepoCheck: true,
      modelReasoningEffort: "high",
    });
    expect(service.getInfo()).toEqual({
      threadId: "thread-resume",
      workspace: "/workspace/resumed",
      model: "gpt-5.4",
      reasoningEffort: "high",
      launchProfileId: "readonly",
      launchProfileLabel: "Read Only",
      launchProfileBehavior: "read-only / never",
      sandboxMode: "read-only",
      approvalPolicy: "never",
      fastMode: false,
      unsafeLaunch: false,
    });
  });

  it("restores the active launch from the resumed thread and keeps the persisted next launch separate", async () => {
    mockCodexState.getThread.mockReturnValue({
      id: "thread-restored-full-access",
      title: "Restored full access thread",
      cwd: "/workspace/from-cli",
      model: "gpt-5.5",
      reasoningEffort: "xhigh",
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      createdAt: new Date("2026-05-11T00:00:00.000Z"),
      updatedAt: new Date("2026-05-11T01:00:00.000Z"),
      firstUserMessage: "hello",
    });
    mockCodexState.getThreadRolloutSnapshot.mockReturnValue({
      sandboxMode: "danger-full-access",
      approvalPolicy: "never",
    });

    const service = await CodexSessionService.create(createConfig(), {
      launchProfileId: "readonly",
      resumeThreadId: "thread-restored-full-access",
    });
    const codexInstance = mockState.codexInstances[0];

    expect(codexInstance.resumeThread).toHaveBeenCalledWith("thread-restored-full-access", {
      model: "gpt-5.5",
      sandboxMode: "danger-full-access",
      workingDirectory: "/workspace/from-cli",
      approvalPolicy: "never",
      skipGitRepoCheck: true,
      modelReasoningEffort: "xhigh",
    });
    expect(service.getInfo()).toEqual(expect.objectContaining({
      threadId: "thread-restored-full-access",
      workspace: "/workspace/from-cli",
      model: "gpt-5.5",
      reasoningEffort: "xhigh",
      launchProfileId: "attached-thread",
      launchProfileBehavior: "danger-full-access / never",
      sandboxMode: "danger-full-access",
      approvalPolicy: "never",
      unsafeLaunch: true,
      nextLaunchProfileId: "readonly",
      nextLaunchProfileBehavior: "read-only / never",
    }));
  });

  it("honors a persisted active launch override separately from the next selected launch", async () => {
    const service = await CodexSessionService.create(createConfig(), {
      launchProfileId: "review",
      activeLaunchProfileId: "full-access",
      resumeThreadId: "thread-active-override",
    });
    const codexInstance = mockState.codexInstances[0];

    expect(codexInstance.resumeThread).toHaveBeenCalledWith("thread-active-override", {
      model: "o3",
      sandboxMode: "danger-full-access",
      workingDirectory: "/workspace/base",
      approvalPolicy: "never",
      skipGitRepoCheck: true,
    });
    expect(service.getInfo()).toEqual(expect.objectContaining({
      threadId: "thread-active-override",
      launchProfileId: "full-access",
      launchProfileLabel: "Full Access",
      launchProfileBehavior: "danger-full-access / never",
      sandboxMode: "danger-full-access",
      approvalPolicy: "never",
      unsafeLaunch: true,
      nextLaunchProfileId: "review",
      nextLaunchProfileBehavior: "workspace-write / on-request",
    }));
  });

  it("prefers rollout permissions over a stale persisted active launch profile", async () => {
    mockCodexState.getThread.mockReturnValue({
      id: "thread-stale-active-default",
      title: "Stale active default thread",
      cwd: "/workspace/from-cli",
      model: "gpt-5.5",
      reasoningEffort: "xhigh",
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      createdAt: new Date("2026-05-11T00:00:00.000Z"),
      updatedAt: new Date("2026-05-11T01:00:00.000Z"),
      firstUserMessage: "hello",
    });
    mockCodexState.getThreadRolloutSnapshot.mockReturnValue({
      sandboxMode: "danger-full-access",
      approvalPolicy: "never",
    });

    const service = await CodexSessionService.create(createConfig(), {
      launchProfileId: "default",
      activeLaunchProfileId: "default",
      resumeThreadId: "thread-stale-active-default",
    });
    const codexInstance = mockState.codexInstances[0];

    expect(codexInstance.resumeThread).toHaveBeenCalledWith("thread-stale-active-default", {
      model: "gpt-5.5",
      sandboxMode: "danger-full-access",
      workingDirectory: "/workspace/from-cli",
      approvalPolicy: "never",
      skipGitRepoCheck: true,
      modelReasoningEffort: "xhigh",
    });
    expect(service.getInfo()).toEqual(expect.objectContaining({
      launchProfileId: "attached-thread",
      launchProfileBehavior: "danger-full-access / never",
      sandboxMode: "danger-full-access",
      approvalPolicy: "never",
      unsafeLaunch: true,
      nextLaunchProfileId: "default",
    }));
  });

  it("keeps an active launch override when switching the same attached thread again", async () => {
    const service = await CodexSessionService.create(createConfig(), {
      launchProfileId: "review",
      activeLaunchProfileId: "full-access",
      resumeThreadId: "thread-active-override",
    });
    mockCodexState.getThread.mockReturnValue(null);

    await service.switchSession("thread-active-override");
    const codexInstance = mockState.codexInstances.at(-1);

    expect(codexInstance.resumeThread).toHaveBeenLastCalledWith("thread-active-override", {
      model: "o3",
      sandboxMode: "danger-full-access",
      workingDirectory: "/workspace/base",
      approvalPolicy: "never",
      skipGitRepoCheck: true,
    });
    expect(service.getInfo()).toEqual(expect.objectContaining({
      launchProfileId: "full-access",
      launchProfileBehavior: "danger-full-access / never",
      sandboxMode: "danger-full-access",
      approvalPolicy: "never",
      unsafeLaunch: true,
      nextLaunchProfileId: "review",
    }));
  });

  it("includes persisted Codex usage only when requested", async () => {
    mockCodexState.getThreadUsage.mockReturnValue({
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
      rateLimits: null,
      updatedAt: null,
    });

    const service = await CodexSessionService.create(createConfig(), {
      resumeThreadId: "thread-usage",
    });

    expect(service.getInfo().codexUsage).toBeUndefined();
    expect(mockCodexState.getThreadUsage).not.toHaveBeenCalled();

    expect(service.getInfo({ includeUsage: true }).codexUsage).toEqual(expect.objectContaining({
      contextUsedPercent: 30,
      contextWindow: 1000,
    }));
    expect(mockCodexState.getThreadUsage).toHaveBeenCalledWith("thread-usage");
  });

  it("uses Codex config fast mode when available", async () => {
    mockCodexConfig.readCodexFastMode.mockReturnValue(false);

    const service = await CodexSessionService.create(createConfig());

    expect(service.getInfo().fastMode).toBe(false);
  });

  it("can defer thread creation so launch settings apply before the first thread starts", async () => {
    const service = await CodexSessionService.create(createConfig(), {
      deferThreadStart: true,
    });

    expect(mockState.codexInstances[0].startThread).toHaveBeenCalledTimes(0);
    expect(service.hasActiveThread()).toBe(false);

    service.setLaunchProfile("readonly");
    await service.newThread();

    expect(mockState.createdThreads[0].options.sandboxMode).toBe("read-only");
  });

  it("setLaunchProfile applies to newly created threads without mutating the existing thread", async () => {
    const service = await CodexSessionService.create(createConfig());
    const firstThread = mockState.createdThreads[0];

    const profile = service.setLaunchProfile("readonly");
    expect(profile.label).toBe("Read Only");
    expect(firstThread.options.sandboxMode).toBe("workspace-write");

    await service.newThread();

    const secondThread = mockState.createdThreads[1];
    expect(secondThread.options.sandboxMode).toBe("read-only");
    expect(service.getInfo()).toEqual({
      threadId: null,
      workspace: "/workspace/base",
      model: "o3",
      launchProfileId: "readonly",
      launchProfileLabel: "Read Only",
      launchProfileBehavior: "read-only / never",
      sandboxMode: "read-only",
      approvalPolicy: "never",
      fastMode: false,
      unsafeLaunch: false,
    });
  });

  it("setLaunchProfileForCurrentSession reattaches an idle active thread with the requested profile", async () => {
    const service = await CodexSessionService.create(createConfig(), {
      resumeThreadId: "thread-launch",
    });
    mockCodexState.getThread.mockReturnValue({
      id: "thread-launch",
      title: "Saved thread",
      cwd: "/workspace/base",
      model: "o3",
      reasoningEffort: null,
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      createdAt: new Date("2026-05-11T00:00:00.000Z"),
      updatedAt: new Date("2026-05-11T01:00:00.000Z"),
      firstUserMessage: "hello",
    });

    const result = service.setLaunchProfileForCurrentSession("readonly");
    const codexInstance = mockState.codexInstances.at(-1);

    expect(result).toEqual({
      value: "readonly",
      appliedToActiveThread: true,
    });
    expect(codexInstance.resumeThread).toHaveBeenLastCalledWith("thread-launch", {
      model: "o3",
      sandboxMode: "read-only",
      workingDirectory: "/workspace/base",
      approvalPolicy: "never",
      skipGitRepoCheck: true,
    });
    expect(service.getInfo()).toEqual({
      threadId: "thread-launch",
      workspace: "/workspace/base",
      model: "o3",
      launchProfileId: "readonly",
      launchProfileLabel: "Read Only",
      launchProfileBehavior: "read-only / never",
      sandboxMode: "read-only",
      approvalPolicy: "never",
      fastMode: false,
      unsafeLaunch: false,
    });
  });

  it("keeps an applied launch profile even when stored thread metadata is stale", async () => {
    const service = await CodexSessionService.create(createConfig(), {
      resumeThreadId: "thread-stale-launch",
    });
    mockCodexState.getThread.mockReturnValue({
      id: "thread-stale-launch",
      title: "Stale thread",
      cwd: "/workspace/base",
      model: "o3",
      reasoningEffort: null,
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      createdAt: new Date("2026-05-11T00:00:00.000Z"),
      updatedAt: new Date("2026-05-11T01:00:00.000Z"),
      firstUserMessage: "hello",
    });

    service.setLaunchProfileForCurrentSession("readonly");

    expect(service.getInfo()).toEqual(expect.objectContaining({
      threadId: "thread-stale-launch",
      launchProfileId: "readonly",
      launchProfileBehavior: "read-only / never",
      sandboxMode: "read-only",
      approvalPolicy: "never",
    }));
  });

  it("setFastMode disables fast mode and reattaches an idle active thread", async () => {
    const service = await CodexSessionService.create(createConfig(), {
      resumeThreadId: "thread-fast",
    });

    const result = service.setFastMode(false);
    const codexInstance = mockState.codexInstances.at(-1);

    expect(result).toEqual({
      enabled: false,
      profile: expect.objectContaining({
        id: "default",
        approvalPolicy: "never",
      }),
      appliedToActiveThread: true,
    });
    expect(codexInstance.resumeThread).toHaveBeenCalledWith("thread-fast", {
      model: "o3",
      sandboxMode: "workspace-write",
      workingDirectory: "/workspace/base",
      approvalPolicy: "never",
      skipGitRepoCheck: true,
    });
    expect(mockCodexConfig.writeCodexFastMode).toHaveBeenCalledWith(false);
    expect(service.getInfo()).toEqual({
      threadId: "thread-fast",
      workspace: "/workspace/base",
      model: "o3",
      launchProfileId: "default",
      launchProfileLabel: "Default",
      launchProfileBehavior: "workspace-write / never",
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      fastMode: false,
      unsafeLaunch: false,
    });
  });

  it("setFastMode enables fast mode without changing the launch profile", async () => {
    const service = await CodexSessionService.create(createConfig(), {
      launchProfileId: "review",
      deferThreadStart: true,
    });

    const result = service.setFastMode(true);

    expect(result).toEqual({
      enabled: true,
      profile: expect.objectContaining({
        id: "review",
        approvalPolicy: "on-request",
      }),
      appliedToActiveThread: false,
    });
    expect(service.getInfo().fastMode).toBe(true);
    expect(service.getSelectedLaunchProfile().id).toBe("review");
    expect(mockCodexConfig.writeCodexFastMode).toHaveBeenCalledWith(true);
  });

  it("refreshes active thread metadata from Codex state for session info", async () => {
    const service = await CodexSessionService.create(createConfig(), {
      resumeThreadId: "thread-live",
    });
    mockCodexState.getThread.mockReturnValue({
      id: "thread-live",
      title: "Live thread",
      cwd: "/workspace/from-cli",
      model: "gpt-5.5",
      reasoningEffort: "xhigh",
      sandboxMode: "workspace-write",
      approvalPolicy: "on-request",
      createdAt: new Date("2026-05-11T00:00:00.000Z"),
      updatedAt: new Date("2026-05-11T01:00:00.000Z"),
      firstUserMessage: "hello",
    });

    expect(service.getInfo()).toEqual(expect.objectContaining({
      threadId: "thread-live",
      workspace: "/workspace/from-cli",
      model: "gpt-5.5",
      reasoningEffort: "xhigh",
      launchProfileId: "review",
      fastMode: false,
    }));
  });

  it("does not report attached no-approval Codex threads as fast when the Codex default is off", async () => {
    mockCodexConfig.readCodexFastMode.mockReturnValue(false);
    const service = await CodexSessionService.create(createConfig(), {
      resumeThreadId: "thread-full-access",
    });
    mockCodexState.getThread.mockReturnValue({
      id: "thread-full-access",
      title: "Full access thread",
      cwd: "/workspace/from-cli",
      model: "gpt-5.5",
      reasoningEffort: "xhigh",
      sandboxMode: "danger-full-access",
      approvalPolicy: "never",
      createdAt: new Date("2026-05-11T00:00:00.000Z"),
      updatedAt: new Date("2026-05-11T01:00:00.000Z"),
      firstUserMessage: "hello",
    });

    expect(service.getInfo()).toEqual(expect.objectContaining({
      launchProfileId: "attached-thread",
      approvalPolicy: "never",
      fastMode: false,
      unsafeLaunch: true,
    }));
  });

  it("prefers latest rollout turn permissions over stale Codex thread database metadata", async () => {
    mockCodexConfig.readCodexFastMode.mockReturnValue(false);
    const service = await CodexSessionService.create(createConfig(), {
      resumeThreadId: "thread-cli-full-access",
    });
    mockCodexState.getThread.mockReturnValue({
      id: "thread-cli-full-access",
      title: "CLI full access thread",
      cwd: "/workspace/from-cli",
      model: "gpt-5.5",
      reasoningEffort: "xhigh",
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      createdAt: new Date("2026-05-11T00:00:00.000Z"),
      updatedAt: new Date("2026-05-11T01:00:00.000Z"),
      firstUserMessage: "hello",
    });
    mockCodexState.getThreadRolloutSnapshot.mockReturnValue({
      sandboxMode: "danger-full-access",
      approvalPolicy: "never",
    });

    expect(service.getInfo()).toEqual(expect.objectContaining({
      launchProfileId: "attached-thread",
      launchProfileBehavior: "danger-full-access / never",
      sandboxMode: "danger-full-access",
      approvalPolicy: "never",
      unsafeLaunch: true,
      fastMode: false,
    }));
  });

  it("refreshes launch permissions from rollout while a turn is still running", async () => {
    const service = await CodexSessionService.create(createConfig(), {
      resumeThreadId: "thread-running-full-access",
    });
    const thread = mockState.createdThreads[0];
    const callbacks = createCallbacks();
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });

    thread.runStreamed.mockImplementationOnce(async () => ({
      events: (async function* () {
        await blocker;
        yield { type: "turn.completed", usage };
      })(),
    }));

    const promptPromise = service.prompt("work", callbacks);
    await Promise.resolve();
    expect(service.isProcessing()).toBe(true);

    mockCodexState.getThread.mockReturnValue({
      id: "thread-running-full-access",
      title: "Running full access thread",
      cwd: "/workspace/from-cli",
      model: "gpt-5.5",
      reasoningEffort: "xhigh",
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      createdAt: new Date("2026-05-11T00:00:00.000Z"),
      updatedAt: new Date("2026-05-11T01:00:00.000Z"),
      firstUserMessage: "hello",
    });
    mockCodexState.getThreadRolloutSnapshot.mockReturnValue({
      sandboxMode: "danger-full-access",
      approvalPolicy: "never",
    });

    expect(service.getInfo()).toEqual(expect.objectContaining({
      threadId: "thread-running-full-access",
      workspace: "/workspace/from-cli",
      model: "gpt-5.5",
      reasoningEffort: "xhigh",
      launchProfileId: "attached-thread",
      launchProfileBehavior: "danger-full-access / never",
      sandboxMode: "danger-full-access",
      approvalPolicy: "never",
      unsafeLaunch: true,
    }));

    release();
    await promptPromise;
  });

  it("syncFromAgentState imports changed thread metadata and reattaches idle threads", async () => {
    const service = await CodexSessionService.create(createConfig(), {
      resumeThreadId: "thread-sync",
    });
    mockCodexState.getThread.mockReturnValue({
      id: "thread-sync",
      title: "Synced thread",
      cwd: "/workspace/synced",
      model: "gpt-5.5",
      reasoningEffort: "xhigh",
      sandboxMode: "workspace-write",
      approvalPolicy: "on-request",
      createdAt: new Date("2026-05-11T00:00:00.000Z"),
      updatedAt: new Date("2026-05-11T01:00:00.000Z"),
      firstUserMessage: "hello",
    });
    const codexInstance = mockState.codexInstances.at(-1);

    const result = service.syncFromAgentState({ reattach: true });

    expect(result.changed).toBe(true);
    expect(result.reattached).toBe(true);
    expect(result.changedFields).toEqual(expect.arrayContaining(["workspace", "model", "reasoning", "launch"]));
    expect(codexInstance.resumeThread).toHaveBeenLastCalledWith("thread-sync", {
      model: "gpt-5.5",
      sandboxMode: "workspace-write",
      workingDirectory: "/workspace/synced",
      approvalPolicy: "on-request",
      skipGitRepoCheck: true,
      modelReasoningEffort: "xhigh",
    });
    expect(result.info).toEqual(expect.objectContaining({
      workspace: "/workspace/synced",
      model: "gpt-5.5",
      reasoningEffort: "xhigh",
      launchProfileId: "review",
    }));
  });

  it("syncFromAgentState mirrors Codex fast mode defaults for future threads", async () => {
    const service = await CodexSessionService.create(createConfig(), {
      launchProfileId: "review",
      deferThreadStart: true,
    });
    mockCodexConfig.readCodexFastMode.mockReturnValue(true);

    const result = service.syncFromAgentState();

    expect(result.changed).toBe(true);
    expect(result.changedFields).toEqual(["fast"]);
    expect(result.info.fastMode).toBe(true);
    expect(service.getSelectedLaunchProfile().id).toBe("review");
  });

  it("reports the active thread launch mode separately from the next selected launch profile", async () => {
    const service = await CodexSessionService.create(createConfig());

    service.setLaunchProfile("readonly");

    expect(service.getInfo()).toEqual({
      threadId: null,
      workspace: "/workspace/base",
      model: "o3",
      launchProfileId: "default",
      launchProfileLabel: "Default",
      launchProfileBehavior: "workspace-write / never",
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      fastMode: false,
      unsafeLaunch: false,
      nextLaunchProfileId: "readonly",
      nextLaunchProfileLabel: "Read Only",
      nextLaunchProfileBehavior: "read-only / never",
      nextUnsafeLaunch: false,
    });
  });

  it("translates agent_message events into text deltas", async () => {
    const service = await CodexSessionService.create(createConfig());
    const thread = mockState.createdThreads[0];
    const callbacks = createCallbacks();

    thread.runStreamed.mockResolvedValueOnce({
      events: streamEvents([
        { type: "thread.started", thread_id: "thread-123" },
        { type: "item.started", item: { id: "msg-1", type: "agent_message", text: "Hel" } },
        { type: "item.updated", item: { id: "msg-1", type: "agent_message", text: "Hello" } },
        { type: "item.completed", item: { id: "msg-1", type: "agent_message", text: "Hello world" } },
        { type: "turn.completed", usage },
      ]),
    });

    await service.prompt("hello", callbacks);

    expect(callbacks.onTextDelta.mock.calls.map(([delta]) => delta)).toEqual(["Hel", "lo", " world"]);
    expect(callbacks.onAssistantMessageComplete).toHaveBeenCalledTimes(1);
    expect(callbacks.onAgentEnd).toHaveBeenCalledTimes(1);
    expect(service.getInfo().threadId).toBe("thread-123");
  });

  it("maps command_execution events to tool callbacks", async () => {
    const service = await CodexSessionService.create(createConfig());
    const thread = mockState.createdThreads[0];
    const callbacks = createCallbacks();

    thread.runStreamed.mockResolvedValueOnce({
      events: streamEvents([
        {
          type: "item.started",
          item: {
            id: "cmd-1",
            type: "command_execution",
            command: "ls -la",
            aggregated_output: "",
            status: "in_progress",
          },
        },
        {
          type: "item.updated",
          item: {
            id: "cmd-1",
            type: "command_execution",
            command: "ls -la",
            aggregated_output: "file-a\nfile-b",
            status: "in_progress",
          },
        },
        {
          type: "item.completed",
          item: {
            id: "cmd-1",
            type: "command_execution",
            command: "ls -la",
            aggregated_output: "file-a\nfile-b",
            status: "completed",
            exit_code: 0,
          },
        },
      ]),
    });

    await service.prompt("list files", callbacks);

    expect(callbacks.onToolStart).toHaveBeenCalledWith("ls -la", "cmd-1");
    expect(callbacks.onToolUpdate).toHaveBeenCalledWith("cmd-1", "file-a\nfile-b");
    expect(callbacks.onToolEnd).toHaveBeenCalledWith("cmd-1", false);
    expect(callbacks.onToolUpdate).toHaveBeenCalledTimes(1);
  });

  it("maps web_search events to tool callbacks", async () => {
    const service = await CodexSessionService.create(createConfig());
    const thread = mockState.createdThreads[0];
    const callbacks = createCallbacks();

    thread.runStreamed.mockResolvedValueOnce({
      events: streamEvents([
        {
          type: "item.started",
          item: {
            id: "search-1",
            type: "web_search",
            query: "latest TypeScript release notes",
          },
        },
        {
          type: "item.completed",
          item: {
            id: "search-1",
            type: "web_search",
            query: "latest TypeScript release notes",
          },
        },
      ]),
    });

    await service.prompt("search", callbacks);

    expect(callbacks.onToolStart).toHaveBeenCalledWith("🔍 latest TypeScript release notes", "search-1");
    expect(callbacks.onToolUpdate).toHaveBeenCalledWith("search-1", "latest TypeScript release notes");
    expect(callbacks.onToolEnd).toHaveBeenCalledWith("search-1", false);
  });

  it("surfaces error items as failed tool events", async () => {
    const service = await CodexSessionService.create(createConfig());
    const thread = mockState.createdThreads[0];
    const callbacks = createCallbacks();

    thread.runStreamed.mockResolvedValueOnce({
      events: streamEvents([
        {
          type: "item.completed",
          item: {
            id: "error-1",
            type: "error",
            message: "tool failed but the stream continued",
          },
        },
      ]),
    });

    await service.prompt("continue", callbacks);

    expect(callbacks.onToolStart).toHaveBeenCalledWith("⚠️ error", "error-1");
    expect(callbacks.onToolUpdate).toHaveBeenCalledWith("error-1", "tool failed but the stream continued");
    expect(callbacks.onToolEnd).toHaveBeenCalledWith("error-1", true);
  });

  it("emits todo list updates for started, updated, and completed items", async () => {
    const service = await CodexSessionService.create(createConfig());
    const thread = mockState.createdThreads[0];
    const callbacks = createCallbacks();
    const startedItems = [{ text: "Inspect repo", completed: false }];
    const updatedItems = [
      { text: "Inspect repo", completed: true },
      { text: "Write tests", completed: false },
    ];
    const completedItems = [
      { text: "Inspect repo", completed: true },
      { text: "Write tests", completed: true },
    ];

    thread.runStreamed.mockResolvedValueOnce({
      events: streamEvents([
        {
          type: "item.started",
          item: { id: "todo-1", type: "todo_list", items: startedItems },
        },
        {
          type: "item.updated",
          item: { id: "todo-1", type: "todo_list", items: updatedItems },
        },
        {
          type: "item.completed",
          item: { id: "todo-1", type: "todo_list", items: completedItems },
        },
      ]),
    });

    await service.prompt("plan", callbacks);

    expect(callbacks.onTodoUpdate.mock.calls).toEqual([[startedItems], [updatedItems], [completedItems]]);
  });

  it("passes only the new output delta across multiple item.updated events (no duplication)", async () => {
    const service = await CodexSessionService.create(createConfig());
    const thread = mockState.createdThreads[0];
    const callbacks = createCallbacks();

    thread.runStreamed.mockResolvedValueOnce({
      events: streamEvents([
        {
          type: "item.started",
          item: {
            id: "cmd-2",
            type: "command_execution",
            command: "make build",
            aggregated_output: "",
            status: "in_progress",
          },
        },
        {
          type: "item.updated",
          item: {
            id: "cmd-2",
            type: "command_execution",
            command: "make build",
            aggregated_output: "compiling...\n",
            status: "in_progress",
          },
        },
        {
          type: "item.updated",
          item: {
            id: "cmd-2",
            type: "command_execution",
            command: "make build",
            aggregated_output: "compiling...\nlinking...\n",
            status: "in_progress",
          },
        },
        {
          type: "item.completed",
          item: {
            id: "cmd-2",
            type: "command_execution",
            command: "make build",
            aggregated_output: "compiling...\nlinking...\ndone\n",
            status: "completed",
            exit_code: 0,
          },
        },
      ]),
    });

    await service.prompt("build", callbacks);

    expect(callbacks.onToolStart).toHaveBeenCalledWith("make build", "cmd-2");
    expect(callbacks.onToolUpdate.mock.calls).toEqual([
      ["cmd-2", "compiling...\n"],
      ["cmd-2", "linking...\n"],
      ["cmd-2", "done\n"],
    ]);
    expect(callbacks.onToolEnd).toHaveBeenCalledWith("cmd-2", false);
  });

  it("emits output via onToolUpdate when output only arrives in item.completed (fast command)", async () => {
    const service = await CodexSessionService.create(createConfig());
    const thread = mockState.createdThreads[0];
    const callbacks = createCallbacks();

    thread.runStreamed.mockResolvedValueOnce({
      events: streamEvents([
        {
          type: "item.started",
          item: {
            id: "cmd-3",
            type: "command_execution",
            command: "echo hi",
            aggregated_output: "",
            status: "in_progress",
          },
        },
        {
          type: "item.completed",
          item: {
            id: "cmd-3",
            type: "command_execution",
            command: "echo hi",
            aggregated_output: "hi\n",
            status: "completed",
            exit_code: 0,
          },
        },
      ]),
    });

    await service.prompt("greet", callbacks);

    expect(callbacks.onToolStart).toHaveBeenCalledWith("echo hi", "cmd-3");
    expect(callbacks.onToolUpdate).toHaveBeenCalledWith("cmd-3", "hi\n");
    expect(callbacks.onToolEnd).toHaveBeenCalledWith("cmd-3", false);
  });

  it("synthesizes tool events for file changes", async () => {
    const service = await CodexSessionService.create(createConfig());
    const thread = mockState.createdThreads[0];
    const callbacks = createCallbacks();

    thread.runStreamed.mockResolvedValueOnce({
      events: streamEvents([
        {
          type: "item.completed",
          item: {
            id: "patch-1",
            type: "file_change",
            changes: [
              { kind: "add", path: "src/new.ts" },
              { kind: "update", path: "README.md" },
            ],
            status: "completed",
          },
        },
      ]),
    });

    await service.prompt("edit files", callbacks);

    expect(callbacks.onToolStart).toHaveBeenCalledWith("file_change", "patch-1");
    expect(callbacks.onToolUpdate).toHaveBeenCalledWith("patch-1", "add src/new.ts, update README.md");
    expect(callbacks.onToolEnd).toHaveBeenCalledWith("patch-1", false);
  });

  it("triggers onAgentEnd when the turn completes", async () => {
    const service = await CodexSessionService.create(createConfig());
    const thread = mockState.createdThreads[0];
    const callbacks = createCallbacks();

    thread.runStreamed.mockResolvedValueOnce({
      events: streamEvents([{ type: "turn.completed", usage }]),
    });

    await service.prompt("done?", callbacks);

    expect(callbacks.onAgentEnd).toHaveBeenCalledTimes(1);
  });

  it("reports per-turn token usage and accumulates session totals", async () => {
    const service = await CodexSessionService.create(createConfig());
    const thread = mockState.createdThreads[0];
    const firstCallbacks = createCallbacks();
    const secondCallbacks = createCallbacks();
    const firstUsage = {
      input_tokens: 11,
      cached_input_tokens: 3,
      output_tokens: 7,
    };
    const secondUsage = {
      input_tokens: 5,
      cached_input_tokens: 2,
      output_tokens: 13,
    };

    thread.runStreamed
      .mockResolvedValueOnce({ events: streamEvents([{ type: "turn.completed", usage: firstUsage }]) })
      .mockResolvedValueOnce({ events: streamEvents([{ type: "turn.completed", usage: secondUsage }]) });

    await service.prompt("first", firstCallbacks);
    await service.prompt("second", secondCallbacks);

    expect(firstCallbacks.onAgentEnd).toHaveBeenCalledTimes(1);
    expect(firstCallbacks.onTurnComplete).toHaveBeenCalledWith({
      inputTokens: 11,
      cachedInputTokens: 3,
      outputTokens: 7,
    });
    expect(secondCallbacks.onAgentEnd).toHaveBeenCalledTimes(1);
    expect(secondCallbacks.onTurnComplete).toHaveBeenCalledWith({
      inputTokens: 5,
      cachedInputTokens: 2,
      outputTokens: 13,
    });
    expect(service.getInfo().sessionTokens).toEqual({
      input: 16,
      cached: 5,
      output: 20,
    });
  });

  it("throws when the turn fails", async () => {
    const service = await CodexSessionService.create(createConfig());
    const thread = mockState.createdThreads[0];
    const callbacks = createCallbacks();

    thread.runStreamed.mockResolvedValueOnce({
      events: streamEvents([{ type: "turn.failed", error: { message: "boom" } }]),
    });

    await expect(service.prompt("fail", callbacks)).rejects.toThrow("boom");
  });

  it("aborts an in-flight turn via AbortController", async () => {
    const service = await CodexSessionService.create(createConfig());
    const thread = mockState.createdThreads[0];
    const callbacks = createCallbacks();

    let release!: () => void;
    let capturedSignal: AbortSignal | undefined;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });

    thread.runStreamed.mockImplementationOnce(async (_input: string, options?: { signal?: AbortSignal }) => {
      capturedSignal = options?.signal;
      return {
        events: (async function* () {
          await blocker;
          if (capturedSignal?.aborted) {
            throw new Error("aborted");
          }
          yield { type: "turn.completed", usage };
        })(),
      };
    });

    const promptPromise = service.prompt("stop", callbacks);
    await Promise.resolve();

    expect(service.isProcessing()).toBe(true);

    await service.abort();

    expect(capturedSignal?.aborted).toBe(true);

    release();

    await expect(promptPromise).rejects.toThrow("aborted");
    expect(service.isProcessing()).toBe(false);
  });

  it("creates a new thread in a different workspace", async () => {
    const service = await CodexSessionService.create(createConfig());
    const codexInstance = mockState.codexInstances[0];

    const info = await service.newThread("/workspace/other");

    expect(codexInstance.startThread).toHaveBeenCalledTimes(2);
    expect(codexInstance.startThread).toHaveBeenLastCalledWith({
      model: "o3",
      sandboxMode: "workspace-write",
      workingDirectory: "/workspace/other",
      approvalPolicy: "never",
      skipGitRepoCheck: true,
    });
    expect(info).toEqual({
      threadId: null,
      workspace: "/workspace/other",
      model: "o3",
      launchProfileId: "default",
      launchProfileLabel: "Default",
      launchProfileBehavior: "workspace-write / never",
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      fastMode: false,
      unsafeLaunch: false,
    });
    expect(service.getCurrentWorkspace()).toBe("/workspace/other");
  });

  it("resumes a thread by id", async () => {
    const service = await CodexSessionService.create(createConfig());
    const codexInstance = mockState.codexInstances[0];

    const info = await service.resumeThread("thread-999");

    expect(codexInstance.resumeThread).toHaveBeenCalledWith("thread-999", {
      model: "o3",
      sandboxMode: "workspace-write",
      workingDirectory: "/workspace/base",
      approvalPolicy: "never",
      skipGitRepoCheck: true,
    });
    expect(info).toEqual({
      threadId: "thread-999",
      workspace: "/workspace/base",
      model: "o3",
      launchProfileId: "default",
      launchProfileLabel: "Default",
      launchProfileBehavior: "workspace-write / never",
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      fastMode: false,
      unsafeLaunch: false,
    });
  });

  it("switchSession looks up workspace and model from codex state", async () => {
    mockCodexState.getThread.mockReturnValue({
      id: "thread-abc",
      title: "Saved thread",
      cwd: "/workspace/from-db",
      model: "gpt-5.4-mini",
      reasoningEffort: "xhigh",
      sandboxMode: "workspace-write",
      approvalPolicy: "on-request",
      createdAt: new Date("2025-01-01T00:00:00.000Z"),
      updatedAt: new Date("2025-01-02T00:00:00.000Z"),
      firstUserMessage: "hello",
    });

    const service = await CodexSessionService.create(createConfig());
    const codexInstance = mockState.codexInstances[0];

    const info = await service.switchSession("thread-abc");

    expect(mockCodexState.getThread).toHaveBeenCalledWith("thread-abc");
    expect(codexInstance.resumeThread).toHaveBeenLastCalledWith("thread-abc", {
      model: "gpt-5.4-mini",
      sandboxMode: "workspace-write",
      workingDirectory: "/workspace/from-db",
      approvalPolicy: "on-request",
      skipGitRepoCheck: true,
      modelReasoningEffort: "xhigh",
    });
    expect(info).toEqual({
      threadId: "thread-abc",
      workspace: "/workspace/from-db",
      model: "gpt-5.4-mini",
      reasoningEffort: "xhigh",
      launchProfileId: "review",
      launchProfileLabel: "Review",
      launchProfileBehavior: "workspace-write / on-request",
      sandboxMode: "workspace-write",
      approvalPolicy: "on-request",
      fastMode: false,
      unsafeLaunch: false,
      nextLaunchProfileId: "default",
      nextLaunchProfileLabel: "Default",
      nextLaunchProfileBehavior: "workspace-write / never",
      nextUnsafeLaunch: false,
    });
  });

  it("switchSession can change the selected thread while a turn is in progress", async () => {
    mockCodexState.getThread.mockReturnValue({
      id: "thread-busy",
      title: "Busy target",
      cwd: "/workspace/other",
      model: "gpt-5.4-mini",
      reasoningEffort: "high",
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      createdAt: new Date("2025-01-03T00:00:00.000Z"),
      updatedAt: new Date("2025-01-04T00:00:00.000Z"),
      firstUserMessage: "target",
    });
    const service = await CodexSessionService.create(createConfig());
    const thread = mockState.createdThreads[0];
    const codexInstance = mockState.codexInstances[0];
    const callbacks = createCallbacks();

    let release!: () => void;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });

    thread.runStreamed.mockImplementationOnce(async () => ({
      events: (async function* () {
        await blocker;
        yield { type: "thread.started", thread_id: "thread-original" };
        yield { type: "turn.completed", usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 } };
      })(),
    }));

    const promptPromise = service.prompt("busy", callbacks);
    await Promise.resolve();

    const info = await service.switchSession("thread-busy");

    expect(mockCodexState.getThread).toHaveBeenCalledWith("thread-busy");
    expect(codexInstance.resumeThread).toHaveBeenLastCalledWith("thread-busy", {
      model: "gpt-5.4-mini",
      sandboxMode: "workspace-write",
      workingDirectory: "/workspace/other",
      approvalPolicy: "never",
      skipGitRepoCheck: true,
      modelReasoningEffort: "high",
    });
    expect(info.threadId).toBe("thread-busy");
    expect(info.workspace).toBe("/workspace/other");

    release();
    await promptPromise;
    expect(service.getInfo().threadId).toBe("thread-busy");
  });

  it("newThread accepts an explicit model override and updates getInfo", async () => {
    const service = await CodexSessionService.create(createConfig());
    const codexInstance = mockState.codexInstances[0];

    const info = await service.newThread(undefined, "gpt-5.4");

    expect(codexInstance.startThread).toHaveBeenLastCalledWith({
      model: "gpt-5.4",
      sandboxMode: "workspace-write",
      workingDirectory: "/workspace/base",
      approvalPolicy: "never",
      skipGitRepoCheck: true,
    });
    expect(info.model).toBe("gpt-5.4");
    expect(service.getInfo().model).toBe("gpt-5.4");
  });

  it("setReasoningEffort stores the effort and applies it to new threads", async () => {
    const service = await CodexSessionService.create(createConfig());
    const codexInstance = mockState.codexInstances[0];

    service.setReasoningEffort("high");
    expect(service.getInfo().reasoningEffort).toBe("high");

    await service.newThread();

    expect(codexInstance.startThread).toHaveBeenLastCalledWith({
      model: "o3",
      sandboxMode: "workspace-write",
      workingDirectory: "/workspace/base",
      approvalPolicy: "never",
      skipGitRepoCheck: true,
      modelReasoningEffort: "high",
    });
  });

  it("setModel updates the tracked model returned by getInfo", async () => {
    const service = await CodexSessionService.create(createConfig());

    expect(service.setModel("o4-mini")).toBe("o4-mini");
    expect(service.getInfo().model).toBe("o4-mini");
  });

  it("setModelForCurrentSession reattaches an idle active thread", async () => {
    const service = await CodexSessionService.create(createConfig(), {
      resumeThreadId: "thread-model",
    });
    const codexInstance = mockState.codexInstances.at(-1);

    const result = service.setModelForCurrentSession("gpt-5.5");

    expect(result).toEqual({
      value: "gpt-5.5",
      appliedToActiveThread: true,
    });
    expect(codexInstance.resumeThread).toHaveBeenCalledWith("thread-model", {
      model: "gpt-5.5",
      sandboxMode: "workspace-write",
      workingDirectory: "/workspace/base",
      approvalPolicy: "never",
      skipGitRepoCheck: true,
    });
    expect(service.getInfo().model).toBe("gpt-5.5");
  });

  it("setReasoningEffortForCurrentSession reattaches an idle active thread", async () => {
    const service = await CodexSessionService.create(createConfig(), {
      resumeThreadId: "thread-reasoning",
    });
    const codexInstance = mockState.codexInstances.at(-1);

    const result = service.setReasoningEffortForCurrentSession("xhigh");

    expect(result).toEqual({
      value: "xhigh",
      appliedToActiveThread: true,
    });
    expect(codexInstance.resumeThread).toHaveBeenCalledWith("thread-reasoning", {
      model: "o3",
      sandboxMode: "workspace-write",
      workingDirectory: "/workspace/base",
      approvalPolicy: "never",
      skipGitRepoCheck: true,
      modelReasoningEffort: "xhigh",
    });
    expect(service.getInfo().reasoningEffort).toBe("xhigh");
  });

  it("setModelForCurrentSession only stores the model when no thread is active yet", async () => {
    const service = await CodexSessionService.create(createConfig(), {
      deferThreadStart: true,
    });
    const codexInstance = mockState.codexInstances.at(-1);

    const result = service.setModelForCurrentSession("gpt-5.4");

    expect(result).toEqual({
      value: "gpt-5.4",
      appliedToActiveThread: false,
    });
    expect(codexInstance.resumeThread).not.toHaveBeenCalled();
    expect(codexInstance.startThread).not.toHaveBeenCalled();
    expect(service.getInfo().model).toBe("gpt-5.4");
  });

  it("passes text plus image inputs through to the SDK", async () => {
    const service = await CodexSessionService.create(createConfig());
    const thread = mockState.createdThreads[0];
    const callbacks = createCallbacks();

    await service.prompt({ text: "describe this", imagePaths: ["/tmp/img.png"] }, callbacks);

    expect(thread.runStreamed).toHaveBeenCalledWith(
      [
        { type: "text", text: "describe this" },
        { type: "local_image", path: "/tmp/img.png" },
      ],
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("prepends staged file instructions to the SDK input text", async () => {
    const service = await CodexSessionService.create(createConfig());
    const thread = mockState.createdThreads[0];
    const callbacks = createCallbacks();

    await service.prompt(
      { text: "analyze this", stagedFileInstructions: "Files staged at /inbox:\n- log.txt" },
      callbacks,
    );

    expect(thread.runStreamed).toHaveBeenCalledWith(
      "Files staged at /inbox:\n- log.txt\n\nanalyze this",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("sends only staged file instructions when no user text", async () => {
    const service = await CodexSessionService.create(createConfig());
    const thread = mockState.createdThreads[0];
    const callbacks = createCallbacks();

    await service.prompt({ stagedFileInstructions: "Files staged at /inbox:\n- log.txt" }, callbacks);

    expect(thread.runStreamed).toHaveBeenCalledWith(
      "Files staged at /inbox:\n- log.txt",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("passes image-only inputs through to the SDK", async () => {
    const service = await CodexSessionService.create(createConfig());
    const thread = mockState.createdThreads[0];
    const callbacks = createCallbacks();

    await service.prompt({ imagePaths: ["/tmp/img.png"] }, callbacks);

    expect(thread.runStreamed).toHaveBeenCalledWith(
      [{ type: "local_image", path: "/tmp/img.png" }],
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("keeps string inputs unchanged when calling the SDK", async () => {
    const service = await CodexSessionService.create(createConfig());
    const thread = mockState.createdThreads[0];
    const callbacks = createCallbacks();

    await service.prompt("hello", callbacks);

    expect(thread.runStreamed).toHaveBeenCalledWith("hello", expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("handback clears the active thread and returns thread id plus workspace", async () => {
    const service = await CodexSessionService.create(createConfig());
    const thread = mockState.createdThreads[0];
    const callbacks = createCallbacks();

    thread.runStreamed.mockResolvedValueOnce({
      events: streamEvents([{ type: "thread.started", thread_id: "thread-live" }, { type: "turn.completed", usage }]),
    });

    await service.prompt("hello", callbacks);

    expect(service.handback()).toEqual({
      threadId: "thread-live",
      workspace: "/workspace/base",
    });
    expect(service.hasActiveThread()).toBe(false);
    expect(service.getInfo()).toEqual({
      threadId: null,
      workspace: "/workspace/base",
      model: "o3",
      launchProfileId: "default",
      launchProfileLabel: "Default",
      launchProfileBehavior: "workspace-write / never",
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      fastMode: false,
      unsafeLaunch: false,
      sessionTokens: {
        input: 1,
        cached: 0,
        output: 1,
      },
    });
  });

  it("listAllSessions delegates to codex-state", async () => {
    mockCodexState.listThreads.mockReturnValue([
      {
        id: "thread-1",
        title: "One",
        cwd: "/workspace/a",
        model: "o3",
        createdAt: new Date("2025-01-01T00:00:00.000Z"),
        updatedAt: new Date("2025-01-02T00:00:00.000Z"),
        firstUserMessage: "hello",
      },
    ]);

    const service = await CodexSessionService.create(createConfig());

    expect(service.listAllSessions(5)).toEqual([
      expect.objectContaining({ id: "thread-1", cwd: "/workspace/a" }),
    ]);
    expect(mockCodexState.listThreads).toHaveBeenCalledWith(5);
  });

  it("listWorkspaces delegates to codex-state", async () => {
    mockCodexState.listWorkspaces.mockReturnValue(["/workspace/a", "/workspace/b"]);

    const service = await CodexSessionService.create(createConfig());

    expect(service.listWorkspaces()).toEqual(["/workspace/a", "/workspace/b"]);
    expect(mockCodexState.listWorkspaces).toHaveBeenCalledTimes(1);
  });

  it("listModels delegates to codex-state", async () => {
    mockCodexState.listModels.mockReturnValue([
      { slug: "gpt-5.4", displayName: "GPT-5.4" },
      { slug: "o3", displayName: "o3" },
    ]);

    const service = await CodexSessionService.create(createConfig());

    expect(service.listModels()).toEqual([
      { slug: "gpt-5.4", displayName: "GPT-5.4" },
      { slug: "o3", displayName: "o3" },
    ]);
    expect(mockCodexState.listModels).toHaveBeenCalledTimes(1);
  });
});
