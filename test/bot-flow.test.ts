import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBot } from "../src/bot.js";
import { createDefaultLaunchProfile } from "../src/codex-launch.js";
import type { ConnectorConfig } from "../src/config.js";
import { UserStore } from "../src/user-management.js";

const mockCodexState = vi.hoisted(() => ({
  getThread: vi.fn(() => null),
  getThreadActivity: vi.fn(() => null),
  getThreadActivityLog: vi.fn(() => []),
  getThreadRolloutSnapshot: vi.fn(() => null),
}));

const mockOperations = vi.hoisted(() => ({
  getConnectorHealth: vi.fn(async () => ({
    version: "0.2.1",
    state: { status: "ready" },
    pidRunning: true,
    appPidRunning: true,
    codexCli: "path (/usr/local/bin/codex)",
    codexCliPath: "/usr/local/bin/codex",
    codexCliVersion: "codex-cli 0.130.0",
    piCli: "path (/usr/local/bin/pi)",
    piCliPath: "/usr/local/bin/pi",
    piCliVersion: "0.73.1",
    hermesCli: "path (/usr/local/bin/hermes)",
    hermesCliPath: "/usr/local/bin/hermes",
    hermesCliVersion: "hermes 1.2.3",
    openClawCli: "path (/usr/local/bin/openclaw)",
    openClawCliPath: "/usr/local/bin/openclaw",
    openClawCliVersion: "openclaw 0.9.0",
    claudeCodeCli: "path (/usr/local/bin/claude)",
    claudeCodeCliPath: "/usr/local/bin/claude",
    claudeCodeCliVersion: "claude 2.1.140",
    stateFile: "/tmp/state.json",
    logFile: "/tmp/nordrelay.log",
    databasePath: null,
    uptimeSeconds: 1,
  })),
  getVersionChecks: vi.fn(async () => ({
    nordrelay: {
      label: "NordRelay",
      packageName: "@nordbyte/nordrelay",
      installedLabel: "0.2.1",
      installedVersion: "0.2.1",
      latestVersion: "0.2.1",
      status: "current",
    },
    codex: {
      label: "Codex",
      packageName: "@openai/codex",
      installedLabel: "codex-cli 0.130.0",
      installedVersion: "0.130.0",
      latestVersion: "0.131.0",
      status: "outdated",
    },
    pi: {
      label: "Pi",
      packageName: "@earendil-works/pi-coding-agent",
      installedLabel: "not installed",
      installedVersion: null,
      latestVersion: null,
      status: "not-installed",
    },
    hermes: {
      label: "Hermes",
      packageName: "hermes-agent",
      installedLabel: "hermes 1.2.3",
      installedVersion: "1.2.3",
      latestVersion: null,
      status: "unknown",
    },
    openclaw: {
      label: "OpenClaw",
      packageName: "openclaw",
      installedLabel: "openclaw 0.9.0",
      installedVersion: "0.9.0",
      latestVersion: null,
      status: "unknown",
    },
    claudeCode: {
      label: "Claude Code",
      packageName: "@anthropic-ai/claude-code",
      installedLabel: "claude 2.1.140",
      installedVersion: "2.1.140",
      latestVersion: null,
      status: "unknown",
    },
  })),
  readConnectorState: vi.fn(async () => ({ status: "ready" })),
  readFormattedLogTail: vi.fn(async () => ({
    filePath: "/tmp/nordrelay.log",
    requestedLines: 80,
    lineCount: 2,
    updatedAt: new Date("2026-05-12T12:00:00Z"),
    plain: [
      "2026-05-12 14:00:00 INFO  Started <ok>",
      "2026-05-12 14:00:01 WARN  Something needs attention",
    ].join("\n"),
  })),
}));

vi.mock("../src/codex-auth.js", () => ({
  checkAuthStatus: vi.fn(async () => ({
    authenticated: true,
    method: "api-key",
    detail: "authenticated",
  })),
  clearAuthCache: vi.fn(),
  startLogin: vi.fn(),
  startLogout: vi.fn(),
}));

vi.mock("../src/codex-state.js", () => ({
  getThread: mockCodexState.getThread,
  getThreadActivity: mockCodexState.getThreadActivity,
  getThreadActivityLog: mockCodexState.getThreadActivityLog,
  getThreadRolloutSnapshot: mockCodexState.getThreadRolloutSnapshot,
}));

vi.mock("../src/operations.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/operations.js")>();
  return {
    ...actual,
    getConnectorHealth: mockOperations.getConnectorHealth,
    getVersionChecks: mockOperations.getVersionChecks,
    readConnectorState: mockOperations.readConnectorState,
    readFormattedLogTail: mockOperations.readFormattedLogTail,
  };
});

const tempDirs: string[] = [];
const originalNordrelayHome = process.env.NORDRELAY_HOME;

function createTempWorkspace(): string {
  const workspace = mkdtempSync(path.join(tmpdir(), "nordrelay-flow-"));
  tempDirs.push(workspace);
  return workspace;
}

function createConfig(overrides: Partial<ConnectorConfig> = {}): ConnectorConfig {
  const workspace = createTempWorkspace();
  process.env.NORDRELAY_HOME = workspace;
  const users = new UserStore(workspace);
  users.createAdmin({
    email: "admin@example.com",
    displayName: "Admin",
    password: "password123",
    telegramUserId: 123,
  });
  users.createUser({
    email: "readonly@example.com",
    displayName: "Read Only",
    password: "password123",
    groupIds: ["readonly"],
    telegramUserId: 999,
  });

  return {
    telegramBotToken: "123:token",
    telegramRateLimitMinIntervalMs: 0,
    telegramEditMinIntervalMs: 0,
    telegramMirrorMode: "status",
    telegramMirrorMinUpdateMs: 0,
    telegramNotifyMode: "minimal",
    telegramQuietHours: null,
    telegramRedactPatterns: [],
    telegramTransport: "polling",
    telegramWebhookUrl: undefined,
    telegramWebhookHost: "127.0.0.1",
    telegramWebhookPort: 8080,
    telegramWebhookPath: "/telegram/webhook",
    telegramWebhookSecret: undefined,
    workspace,
    workspaceAllowedRoots: [],
    workspaceWarnRoots: [],
    maxFileSize: 20 * 1024 * 1024,
    artifactRetentionDays: 7,
    artifactMaxTurnDirs: 30,
    artifactMaxInboxDirs: 30,
    artifactIgnoreDirs: [],
    artifactIgnoreGlobs: [],
    telegramAutoSendArtifacts: false,
    codexEnabled: true,
    codexApiKey: "codex-key",
    codexModel: "o3",
    codexSyncIntervalMs: 0,
    codexExternalBusyCheckMs: 60_000,
    codexExternalBusyStaleMs: 300_000,
    codexSandboxMode: "workspace-write",
    codexApprovalPolicy: "never",
    launchProfiles: [createDefaultLaunchProfile("workspace-write", "never")],
    defaultLaunchProfileId: "default",
    enableUnsafeLaunchProfiles: false,
    piEnabled: false,
    piCliPath: undefined,
    piSessionDir: undefined,
    piDefaultModel: undefined,
    piDefaultThinking: "medium",
    piDefaultLaunchProfileId: "default",
    hermesEnabled: false,
    hermesCliPath: undefined,
    hermesHome: undefined,
    hermesStateDbPath: undefined,
    hermesApiBaseUrl: "http://127.0.0.1:8642",
    hermesApiKey: undefined,
    hermesDefaultModel: undefined,
    hermesDefaultReasoning: undefined,
    hermesDefaultLaunchProfileId: "default",
    openClawEnabled: false,
    openClawCliPath: undefined,
    openClawGatewayUrl: "ws://127.0.0.1:18789",
    openClawGatewayToken: undefined,
    openClawGatewayPassword: undefined,
    openClawAgentId: "main",
    openClawHome: undefined,
    openClawStateDir: undefined,
    openClawDefaultModel: undefined,
    openClawDefaultThinking: undefined,
    openClawDefaultLaunchProfileId: "default",
    claudeCodeEnabled: false,
    claudeCodeCliPath: undefined,
    claudeCodeConfigDir: undefined,
    claudeCodeDefaultModel: undefined,
    claudeCodeDefaultEffort: undefined,
    claudeCodeDefaultLaunchProfileId: "default",
    claudeCodeMaxTurns: 100,
    defaultAgent: "codex",
    stateBackend: "json",
    toolVerbosity: "summary",
    logFormat: "text",
    showTurnTokenUsage: false,
    enableTelegramLogin: true,
    enableTelegramReactions: false,
    voicePreferredBackend: "auto",
    voiceDefaultLanguage: undefined,
    voiceTranscribeOnly: false,
    auditMaxEvents: 1000,
    sessionLockTtlMs: 1_800_000,
    ...overrides,
  };
}

function createFakeRegistry() {
  const session = {
    getInfo: vi.fn(() => ({
      threadId: "thread-1",
      workspace: "/workspace/base",
      model: "o3",
      launchProfileId: "default",
      launchProfileLabel: "Default",
      launchProfileBehavior: "workspace-write / never",
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      fastMode: true,
      unsafeLaunch: false,
    })),
    getActiveThreadId: vi.fn(() => "thread-1"),
    syncFromAgentState: vi.fn(() => ({
      threadId: "thread-1",
      changed: true,
      reattached: true,
      changedFields: ["model"],
      info: session.getInfo(),
    })),
    hasActiveThread: vi.fn(() => true),
    isProcessing: vi.fn(() => false),
    prompt: vi.fn(),
    listAllSessions: vi.fn(() => []),
    listWorkspaces: vi.fn(() => []),
    refreshModels: vi.fn(async () => {}),
    listModels: vi.fn(() => [{ slug: "o3", displayName: "o3" }]),
    listLaunchProfiles: vi.fn(() => []),
  };

  return {
    session,
    registry: {
      onRemove: vi.fn(),
      getOrCreate: vi.fn(async () => session),
      get: vi.fn(() => session),
      hasMetadata: vi.fn(() => true),
      updateMetadata: vi.fn(),
      listPinnedThreadIds: vi.fn(() => []),
      listContexts: vi.fn(() => []),
      syncAllFromAgentState: vi.fn(() => []),
    },
  };
}

function installFakeApi(bot: ReturnType<typeof createBot>) {
  const sentMessages: Array<{ chatId: number | string; text: string; options: unknown }> = [];
  const editedMessages: Array<{ chatId: number | string; messageId: number; text: string; options: unknown }> = [];
  const answeredCallbacks: string[] = [];
  const chatActions: Array<{ chatId: number | string; action: string; options: unknown }> = [];
  let nextMessageId = 100;

  bot.botInfo = {
    id: 123,
    is_bot: true,
    first_name: "Connector",
    username: "connector_bot",
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
  };

  bot.api.config.use(async (_prev, method, payload) => {
    switch (method) {
      case "sendMessage": {
        const data = payload as { chat_id: number | string; text: string };
        sentMessages.push({ chatId: data.chat_id, text: data.text, options: payload });
        return { ok: true, result: { message_id: nextMessageId++, date: 0, chat: { id: data.chat_id, type: "private" }, text: data.text } };
      }
      case "answerCallbackQuery": {
        const data = payload as { text?: string };
        answeredCallbacks.push(data.text ?? "");
        return { ok: true, result: true };
      }
      case "editMessageText": {
        const data = payload as { chat_id: number | string; message_id: number; text: string };
        editedMessages.push({ chatId: data.chat_id, messageId: data.message_id, text: data.text, options: payload });
        return { ok: true, result: true };
      }
      case "editMessageReplyMarkup":
        return { ok: true, result: true };
      case "sendChatAction":
        chatActions.push({
          chatId: (payload as { chat_id: number | string }).chat_id,
          action: (payload as { action: string }).action,
          options: payload,
        });
        return { ok: true, result: true };
      default:
        return { ok: true, result: true };
    }
  });

  return { sentMessages, editedMessages, answeredCallbacks, chatActions };
}

function getFirstInlineButton(payload: unknown): { text: string; callback_data: string } {
  const replyMarkup = (payload as { reply_markup?: { inline_keyboard?: Array<Array<{ text: string; callback_data: string }>> } }).reply_markup;
  const button = replyMarkup?.inline_keyboard?.[0]?.[0];
  if (!button) {
    throw new Error("Expected inline keyboard button");
  }
  return button;
}

function findInlineButton(payload: unknown, predicate: (button: { text: string; callback_data: string }) => boolean): { text: string; callback_data: string } {
  const replyMarkup = (payload as { reply_markup?: { inline_keyboard?: Array<Array<{ text: string; callback_data: string }>> } }).reply_markup;
  const buttons = replyMarkup?.inline_keyboard?.flat() ?? [];
  const button = buttons.find(predicate);
  if (!button) {
    throw new Error("Expected inline keyboard button");
  }
  return button;
}

function messageUpdate(text: string, fromId = 123) {
  return {
    update_id: Math.floor(Math.random() * 1_000_000),
    message: {
      message_id: 1,
      date: 0,
      chat: { id: fromId, type: "private" },
      from: { id: fromId, is_bot: false, first_name: "User" },
      text,
      entities: text.startsWith("/") ? [{ offset: 0, length: text.split(/\s+/)[0]!.length, type: "bot_command" }] : undefined,
    },
  };
}

function callbackUpdate(data: string, fromId = 123) {
  return {
    update_id: Math.floor(Math.random() * 1_000_000),
    callback_query: {
      id: `callback-${Math.random()}`,
      from: { id: fromId, is_bot: false, first_name: "User" },
      chat_instance: "chat-instance",
      data,
      message: {
        message_id: 1,
        date: 0,
        chat: { id: fromId, type: "private" },
      },
    },
  };
}

describe("bot flow integration", () => {
  beforeEach(() => {
    mockCodexState.getThread.mockReset();
    mockCodexState.getThread.mockReturnValue(null);
    mockCodexState.getThreadActivity.mockReset();
    mockCodexState.getThreadActivity.mockReturnValue(null);
    mockCodexState.getThreadActivityLog.mockReset();
    mockCodexState.getThreadActivityLog.mockReturnValue([]);
    mockCodexState.getThreadRolloutSnapshot.mockReset();
    mockCodexState.getThreadRolloutSnapshot.mockReturnValue(null);
    mockOperations.getConnectorHealth.mockReset();
    mockOperations.getConnectorHealth.mockResolvedValue({
      version: "0.2.1",
      state: { status: "ready" },
      pidRunning: true,
      appPidRunning: true,
      codexCli: "path (/usr/local/bin/codex)",
      codexCliPath: "/usr/local/bin/codex",
      codexCliVersion: "codex-cli 0.130.0",
      piCli: "path (/usr/local/bin/pi)",
      piCliPath: "/usr/local/bin/pi",
      piCliVersion: "0.73.1",
      hermesCli: "path (/usr/local/bin/hermes)",
      hermesCliPath: "/usr/local/bin/hermes",
      hermesCliVersion: "hermes 1.2.3",
      openClawCli: "path (/usr/local/bin/openclaw)",
      openClawCliPath: "/usr/local/bin/openclaw",
      openClawCliVersion: "openclaw 0.9.0",
      claudeCodeCli: "path (/usr/local/bin/claude)",
      claudeCodeCliPath: "/usr/local/bin/claude",
      claudeCodeCliVersion: "claude 2.1.140",
      stateFile: "/tmp/state.json",
      logFile: "/tmp/nordrelay.log",
      databasePath: null,
      uptimeSeconds: 1,
    });
    mockOperations.getVersionChecks.mockReset();
    mockOperations.getVersionChecks.mockResolvedValue({
      nordrelay: {
        label: "NordRelay",
        packageName: "@nordbyte/nordrelay",
        installedLabel: "0.2.1",
        installedVersion: "0.2.1",
        latestVersion: "0.2.1",
        status: "current",
      },
      codex: {
        label: "Codex",
        packageName: "@openai/codex",
        installedLabel: "codex-cli 0.130.0",
        installedVersion: "0.130.0",
        latestVersion: "0.131.0",
        status: "outdated",
      },
      pi: {
        label: "Pi",
        packageName: "@earendil-works/pi-coding-agent",
        installedLabel: "not installed",
        installedVersion: null,
        latestVersion: null,
        status: "not-installed",
      },
      hermes: {
        label: "Hermes",
        packageName: "hermes-agent",
        installedLabel: "hermes 1.2.3",
        installedVersion: "1.2.3",
        latestVersion: null,
        status: "unknown",
      },
      openclaw: {
        label: "OpenClaw",
        packageName: "openclaw",
        installedLabel: "openclaw 0.9.0",
        installedVersion: "0.9.0",
        latestVersion: null,
        status: "unknown",
      },
      claudeCode: {
        label: "Claude Code",
        packageName: "@anthropic-ai/claude-code",
        installedLabel: "claude 2.1.140",
        installedVersion: "2.1.140",
        latestVersion: null,
        status: "unknown",
      },
    });
    mockOperations.readConnectorState.mockReset();
    mockOperations.readConnectorState.mockResolvedValue({ status: "ready" });
    mockOperations.readFormattedLogTail.mockReset();
    mockOperations.readFormattedLogTail.mockResolvedValue({
      filePath: "/tmp/nordrelay.log",
      requestedLines: 80,
      lineCount: 2,
      updatedAt: new Date("2026-05-12T12:00:00Z"),
      plain: [
        "2026-05-12 14:00:00 INFO  Started <ok>",
        "2026-05-12 14:00:01 WARN  Something needs attention",
      ].join("\n"),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalNordrelayHome === undefined) {
      delete process.env.NORDRELAY_HOME;
    } else {
      process.env.NORDRELAY_HOME = originalNordrelayHome;
    }
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("blocks readonly users from prompt messages before Codex is touched", async () => {
    const { registry } = createFakeRegistry();
    const bot = createBot(createConfig(), registry as any);
    const api = installFakeApi(bot);

    await bot.handleUpdate(messageUpdate("run tests", 999) as any);

    expect(api.sentMessages.at(-1)?.text).toContain("Access denied: prompt.send permission required.");
    expect(registry.getOrCreate).not.toHaveBeenCalled();
  });

  it("does not mirror external typing before an admin user exists", async () => {
    const config = createConfig({ codexExternalBusyCheckMs: 999_999 });
    rmSync(path.join(config.workspace, "users.json"), { force: true });
    rmSync(path.join(config.workspace, "users.json.bak"), { force: true });
    mockCodexState.getThreadRolloutSnapshot.mockReturnValue({
      threadId: "thread-1",
      rolloutPath: "/tmp/rollout.jsonl",
      lineCount: 2,
      activity: {
        threadId: "thread-1",
        rolloutPath: "/tmp/rollout.jsonl",
        active: true,
        stale: false,
        turnId: "turn-1",
        startedAt: new Date("2026-05-13T10:00:00Z"),
        updatedAt: new Date("2026-05-13T10:00:01Z"),
      },
      events: [],
      latestAgentMessage: null,
      latestUserMessage: "do work",
      latestToolName: "exec_command",
    });
    const { registry } = createFakeRegistry();
    registry.listContexts.mockReturnValue([{ contextKey: "123" }]);
    const bot = createBot(config, registry as any);
    const api = installFakeApi(bot);

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(api.sentMessages).toEqual([]);
    expect(api.chatActions).toEqual([]);
    expect(registry.getOrCreate).not.toHaveBeenCalled();
  });

  it("sends typing for active external CLI turns in final mirror mode", async () => {
    const config = createConfig({
      codexExternalBusyCheckMs: 999_999,
      telegramMirrorMode: "final",
    });
    mockCodexState.getThreadRolloutSnapshot.mockReturnValue({
      threadId: "thread-1",
      rolloutPath: "/tmp/rollout.jsonl",
      lineCount: 2,
      activity: {
        threadId: "thread-1",
        rolloutPath: "/tmp/rollout.jsonl",
        active: true,
        stale: false,
        turnId: "turn-1",
        startedAt: new Date("2026-05-13T10:00:00Z"),
        updatedAt: new Date("2026-05-13T10:00:01Z"),
      },
      events: [],
      latestAgentMessage: null,
      latestUserMessage: "do work",
      latestToolName: "exec_command",
    });
    const { registry } = createFakeRegistry();
    registry.listContexts.mockReturnValue([{ contextKey: "123" }]);
    const bot = createBot(config, registry as any);
    const api = installFakeApi(bot);

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(api.chatActions).toEqual([
      expect.objectContaining({
        chatId: 123,
        action: "typing",
      }),
    ]);
    expect(api.sentMessages).toEqual([]);
  });

  it("does not send approval timeout messages after Telegram access is revoked", async () => {
    vi.useFakeTimers();
    const config = createConfig();
    const { registry, session } = createFakeRegistry();
    session.getInfo.mockReturnValue({
      ...session.getInfo(),
      approvalPolicy: "on-request",
    });
    const bot = createBot(config, registry as any);
    const api = installFakeApi(bot);

    await bot.handleUpdate(messageUpdate("needs approval") as any);
    expect(api.sentMessages).toHaveLength(1);
    expect(api.sentMessages.at(-1)?.text).toContain("Approval required");

    rmSync(path.join(config.workspace, "users.json"), { force: true });
    rmSync(path.join(config.workspace, "users.json.bak"), { force: true });
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

    expect(api.sentMessages).toHaveLength(1);
    expect(api.sentMessages.some((message) => message.text.includes("Approval timed out"))).toBe(false);
  });

  it("handles /tasks through middleware and reports idle progress", async () => {
    const { registry } = createFakeRegistry();
    const bot = createBot(createConfig(), registry as any);
    const api = installFakeApi(bot);

    await bot.handleUpdate(messageUpdate("/tasks") as any);

    expect(api.sentMessages.at(-1)?.text).toContain("Progress:");
    expect(api.sentMessages.at(-1)?.text).toContain("Status:");
    expect(registry.getOrCreate).toHaveBeenCalled();
  });

  it("syncs the active session from Codex state", async () => {
    const { registry, session } = createFakeRegistry();
    const bot = createBot(createConfig(), registry as any);
    const api = installFakeApi(bot);

    await bot.handleUpdate(messageUpdate("/sync") as any);

    expect(session.syncFromAgentState).toHaveBeenCalledWith({ reattach: true });
    expect(registry.updateMetadata).toHaveBeenCalled();
    expect(api.sentMessages.at(-1)?.text).toContain("Synced from Codex state.");
  });

  it("renders thread activity from rollout events", async () => {
    mockCodexState.getThreadActivityLog.mockReturnValue([
      {
        lineNumber: 1,
        kind: "user",
        timestamp: new Date("2026-05-12T04:00:00Z"),
        type: "user_message",
        turnId: "turn-1",
        status: null,
        text: "do work",
        toolName: null,
        phase: null,
      },
      {
        lineNumber: 2,
        kind: "agent",
        timestamp: new Date("2026-05-12T04:00:05Z"),
        type: "agent_message",
        turnId: "turn-1",
        status: null,
        text: "done",
        toolName: null,
        phase: "final_answer",
      },
    ]);
    const { registry } = createFakeRegistry();
    const bot = createBot(createConfig(), registry as any);
    const api = installFakeApi(bot);

    await bot.handleUpdate(messageUpdate("/activity") as any);

    expect(mockCodexState.getThreadActivityLog).toHaveBeenCalledWith("thread-1", 16);
    expect(api.sentMessages.at(-1)?.text).toContain("Activity:");
    expect(api.sentMessages.at(-1)?.text).toContain("user");
    expect(api.sentMessages.at(-1)?.text).toContain("agent final_answer");
  });

  it("queues prompt messages while the attached Codex CLI session is active", async () => {
    mockCodexState.getThreadActivity.mockReturnValue({
      threadId: "thread-1",
      rolloutPath: "/home/tester/.codex/sessions/rollout-thread-1.jsonl",
      active: true,
      stale: false,
      turnId: "turn-1",
      startedAt: new Date("2026-05-12T04:00:00Z"),
      updatedAt: new Date("2026-05-12T04:00:10Z"),
    });
    const { registry, session } = createFakeRegistry();
    const bot = createBot(createConfig(), registry as any);
    const api = installFakeApi(bot);

    await bot.handleUpdate(messageUpdate("next task") as any);

    expect(mockCodexState.getThreadActivity).toHaveBeenCalledWith("thread-1", {
      staleAfterMs: 300_000,
    });
    expect(api.sentMessages.at(-1)?.text).toContain("Queued prompt");
    expect(api.sentMessages.at(-1)?.text).toContain("Codex session is still active");
    expect(api.sentMessages.at(-1)?.text).toContain("processing a previous task");
    const button = getFirstInlineButton(api.sentMessages.at(-1)?.options);
    expect(button.text).toBe("Cancel queued message");
    expect(button.callback_data).toMatch(/^queue_cancel:123:[a-z0-9]+$/);
    expect(session.prompt).not.toHaveBeenCalled();
  });

  it("ignores non-Telegram contexts while monitoring external activity", async () => {
    vi.useFakeTimers();
    const { registry } = createFakeRegistry();
    registry.listContexts.mockReturnValue([
      {
        contextKey: "web:dashboard",
        threadId: "thread-web",
        workspace: "/workspace/web",
        updatedAt: 1,
      },
    ]);
    const bot = createBot(createConfig({ codexExternalBusyCheckMs: 1_000 }), registry as any);
    installFakeApi(bot);

    await vi.runOnlyPendingTimersAsync();

    expect(registry.listContexts).toHaveBeenCalled();
    expect(registry.getOrCreate).not.toHaveBeenCalled();
  });

  it("cancels a queued prompt from the queued-message button", async () => {
    const { registry, session } = createFakeRegistry();
    session.isProcessing.mockReturnValue(true);
    const bot = createBot(createConfig(), registry as any);
    const api = installFakeApi(bot);

    await bot.handleUpdate(messageUpdate("queued from button") as any);
    const button = getFirstInlineButton(api.sentMessages.at(-1)?.options);

    await bot.handleUpdate(callbackUpdate(button.callback_data) as any);
    await bot.handleUpdate(messageUpdate("/queue") as any);

    expect(api.answeredCallbacks.at(-1)).toContain("Cancelled queued prompt");
    expect(api.editedMessages.at(-1)?.text).toContain("Cancelled queued prompt");
    expect(api.sentMessages.at(-1)?.text).toBe("Queue is empty.");
  });

  it("lists queued prompts with cancel buttons and removes the selected item", async () => {
    const { registry, session } = createFakeRegistry();
    session.isProcessing.mockReturnValue(true);
    const bot = createBot(createConfig(), registry as any);
    const api = installFakeApi(bot);

    await bot.handleUpdate(messageUpdate("first queued") as any);
    await bot.handleUpdate(messageUpdate("second queued") as any);
    await bot.handleUpdate(messageUpdate("/queue") as any);

    const button = findInlineButton(api.sentMessages.at(-1)?.options, (candidate) => candidate.callback_data.startsWith("queue_remove:"));
    expect(button.text).toBe("Cancel");
    expect(button.callback_data).toMatch(/^queue_remove:123:[a-z0-9]+$/);

    await bot.handleUpdate(callbackUpdate(button.callback_data) as any);

    expect(api.answeredCallbacks.at(-1)).toContain("Cancelled queued prompt");
    expect(api.editedMessages.at(-1)?.text).toContain("Queued prompts:");
    expect(api.editedMessages.at(-1)?.text).toContain("second queued");
    expect(api.editedMessages.at(-1)?.text).not.toContain("first queued");
  });

  it("supports queue priority and pause controls", async () => {
    const { registry, session } = createFakeRegistry();
    session.isProcessing.mockReturnValue(true);
    const bot = createBot(createConfig(), registry as any);
    const api = installFakeApi(bot);

    await bot.handleUpdate(messageUpdate("first queued") as any);
    const firstId = getFirstInlineButton(api.sentMessages.at(-1)?.options).callback_data.split(":").at(-1)!;
    await bot.handleUpdate(messageUpdate("second queued") as any);
    const secondId = getFirstInlineButton(api.sentMessages.at(-1)?.options).callback_data.split(":").at(-1)!;

    await bot.handleUpdate(messageUpdate(`/queue move ${secondId} top`) as any);
    await bot.handleUpdate(messageUpdate("/queue pause") as any);
    await bot.handleUpdate(messageUpdate("/queue") as any);

    expect(api.sentMessages.some((message) => message.text.includes(`Moved queued prompt ${secondId} top.`))).toBe(true);
    expect(api.sentMessages.some((message) => message.text.includes("Queue paused."))).toBe(true);
    expect(api.sentMessages.at(-1)?.text).toContain("Queued prompts:");
    expect(api.sentMessages.at(-1)?.text).toContain("paused");
    expect(api.sentMessages.at(-1)?.text.indexOf(secondId)).toBeLessThan(api.sentMessages.at(-1)!.text.indexOf(firstId));
  });

  it("stores mirror and notification preferences per context", async () => {
    const { registry } = createFakeRegistry();
    const bot = createBot(createConfig(), registry as any);
    const api = installFakeApi(bot);

    await bot.handleUpdate(messageUpdate("/mirror full") as any);
    await bot.handleUpdate(messageUpdate("/notify all") as any);
    await bot.handleUpdate(messageUpdate("/notify quiet 22-7") as any);

    expect(api.sentMessages.some((message) => message.text.includes("CLI mirroring:") && message.text.includes("full"))).toBe(true);
    expect(api.sentMessages.some((message) => message.text.includes("Notifications:") && message.text.includes("all"))).toBe(true);
    expect(api.sentMessages.at(-1)?.text).toContain("22-07");
  });

  it("renders log messages as normal text while highlighting warning levels", async () => {
    const { registry } = createFakeRegistry();
    const bot = createBot(createConfig(), registry as any);
    const api = installFakeApi(bot);

    await bot.handleUpdate(messageUpdate("/logs") as any);

    expect(api.sentMessages.at(-1)?.text).toContain("<b>WARN</b>");
    expect(api.sentMessages.at(-1)?.text).toContain("Started &lt;ok&gt;");
    expect(api.sentMessages.at(-1)?.text).not.toContain("<code>Started &lt;ok&gt;</code>");
    expect(api.sentMessages.at(-1)?.text).not.toContain("<code>Something needs attention</code>");
  });

  it("renders the dedicated agent update log target", async () => {
    const { registry } = createFakeRegistry();
    const bot = createBot(createConfig(), registry as any);
    const api = installFakeApi(bot);

    await bot.handleUpdate(messageUpdate("/logs agent 25") as any);

    expect(api.sentMessages.at(-1)?.text).toContain("<b>Agent updates log tail</b>");
    expect(mockOperations.readFormattedLogTail).toHaveBeenCalledWith(25, expect.stringContaining("agent-updates.log"));
  });

  it("lists agent update commands from Telegram", async () => {
    const { registry } = createFakeRegistry();
    const bot = createBot(createConfig(), registry as any);
    const api = installFakeApi(bot);

    await bot.handleUpdate(messageUpdate("/update agents") as any);

    expect(api.sentMessages.at(-1)?.text).toContain("<b>Agent updates:</b>");
    expect(api.sentMessages.at(-1)?.text).toContain("/update codex");
    expect(api.sentMessages.at(-1)?.options).toMatchObject({
      reply_markup: expect.objectContaining({ inline_keyboard: expect.any(Array) }),
    });
  });

  it("renders version freshness for NordRelay, Codex, Pi, Hermes, OpenClaw, and Claude Code", async () => {
    const { registry } = createFakeRegistry();
    const bot = createBot(createConfig(), registry as any);
    const api = installFakeApi(bot);

    await bot.handleUpdate(messageUpdate("/version") as any);

    expect(mockOperations.getVersionChecks).toHaveBeenCalled();
    expect(api.sentMessages.at(-1)?.text).toContain("<b>NordRelay:</b> ✅");
    expect(api.sentMessages.at(-1)?.text).toContain("<b>Codex CLI path:</b> <code>/usr/local/bin/codex</code>");
    expect(api.sentMessages.at(-1)?.text).toContain("<b>Pi CLI path:</b> <code>/usr/local/bin/pi</code>");
    expect(api.sentMessages.at(-1)?.text).not.toContain("<code>path (/usr/local/bin/codex)</code>");
    expect(api.sentMessages.at(-1)?.text).toContain("<b>Codex version:</b> ⚠️");
    expect(api.sentMessages.at(-1)?.text).toContain("latest 0.131.0");
    expect(api.sentMessages.at(-1)?.text).toContain("<b>Pi version:</b> ⚠️");
    expect(api.sentMessages.at(-1)?.text).toContain("not installed");
    expect(api.sentMessages.at(-1)?.text).toContain("<b>Hermes CLI path:</b> <code>/usr/local/bin/hermes</code>");
    expect(api.sentMessages.at(-1)?.text).toContain("<b>Hermes version:</b> ⚠️");
    expect(api.sentMessages.at(-1)?.text).toContain("<b>OpenClaw CLI path:</b> <code>/usr/local/bin/openclaw</code>");
    expect(api.sentMessages.at(-1)?.text).toContain("<b>OpenClaw version:</b> ⚠️");
    expect(api.sentMessages.at(-1)?.text).toContain("<b>Claude Code CLI path:</b> <code>/usr/local/bin/claude</code>");
    expect(api.sentMessages.at(-1)?.text).toContain("<b>Claude Code version:</b> ⚠️");
  });

  it("renders workspace guardrails", async () => {
    const { registry, session } = createFakeRegistry();
    session.listWorkspaces.mockReturnValue(["/workspace/base", "/workspace/base/project-a", "/outside"]);
    const bot = createBot(createConfig({
      workspaceAllowedRoots: ["/workspace/base"],
      workspaceWarnRoots: ["/workspace/base"],
    }), registry as any);
    const api = installFakeApi(bot);

    await bot.handleUpdate(messageUpdate("/workspaces") as any);

    expect(api.sentMessages.at(-1)?.text).toContain("Allowed roots:");
    expect(api.sentMessages.at(-1)?.text).toContain("/workspace/base/project-a");
    expect(api.sentMessages.at(-1)?.text).not.toContain("/outside");
    expect(api.sentMessages.at(-1)?.text).toContain("Current warning:");
  });

  it("enforces file permission on artifact callbacks", async () => {
    const { registry } = createFakeRegistry();
    const bot = createBot(createConfig(), registry as any);
    const api = installFakeApi(bot);

    await bot.handleUpdate(callbackUpdate("artifact_delete:turn-a", 999) as any);

    expect(api.answeredCallbacks.at(-1)).toBe("Access denied: files.write permission required.");
    expect(registry.getOrCreate).not.toHaveBeenCalled();
  });
});
