import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createDefaultRolePolicies } from "../src/access-control.js";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  const originalEnv = process.env;
  const originalCwd = process.cwd();
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "nordrelay-config-"));
    process.chdir(tempDir);
    process.env = { ...originalEnv };
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_ALLOWED_USER_IDS;
    delete process.env.TELEGRAM_ALLOWED_CHAT_IDS;
    delete process.env.TELEGRAM_ADMIN_USER_IDS;
    delete process.env.TELEGRAM_READONLY_USER_IDS;
    delete process.env.TELEGRAM_ROLE_POLICIES_JSON;
    delete process.env.TELEGRAM_ALLOW_ANY_CHAT;
    delete process.env.TELEGRAM_RATE_LIMIT_MIN_INTERVAL_MS;
    delete process.env.TELEGRAM_EDIT_MIN_INTERVAL_MS;
    delete process.env.TELEGRAM_CLI_MIRROR_MODE;
    delete process.env.TELEGRAM_CLI_MIRROR_MIN_UPDATE_MS;
    delete process.env.TELEGRAM_NOTIFY_MODE;
    delete process.env.TELEGRAM_QUIET_HOURS;
    delete process.env.TELEGRAM_REDACT_PATTERNS;
    delete process.env.TELEGRAM_TRANSPORT;
    delete process.env.TELEGRAM_WEBHOOK_URL;
    delete process.env.TELEGRAM_WEBHOOK_HOST;
    delete process.env.TELEGRAM_WEBHOOK_PORT;
    delete process.env.TELEGRAM_WEBHOOK_PATH;
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
    delete process.env.CODEX_API_KEY;
    delete process.env.CODEX_MODEL;
    delete process.env.CODEX_SYNC_INTERVAL_MS;
    delete process.env.CODEX_EXTERNAL_BUSY_CHECK_MS;
    delete process.env.CODEX_EXTERNAL_BUSY_STALE_MS;
    delete process.env.CODEX_SANDBOX_MODE;
    delete process.env.CODEX_APPROVAL_POLICY;
    delete process.env.CODEX_LAUNCH_PROFILES_JSON;
    delete process.env.CODEX_DEFAULT_LAUNCH_PROFILE;
    delete process.env.ENABLE_UNSAFE_LAUNCH_PROFILES;
    delete process.env.TOOL_VERBOSITY;
    delete process.env.CONNECTOR_LOG_FORMAT;
    delete process.env.SHOW_TURN_TOKEN_USAGE;
    delete process.env.MAX_FILE_SIZE;
    delete process.env.ARTIFACT_RETENTION_DAYS;
    delete process.env.ARTIFACT_MAX_TURNS;
    delete process.env.ARTIFACT_MAX_INBOX_DIRS;
    delete process.env.ARTIFACT_IGNORE_DIRS;
    delete process.env.ARTIFACT_IGNORE_GLOBS;
    delete process.env.TELEGRAM_AUTO_SEND_ARTIFACTS;
    delete process.env.NORDRELAY_CODEX_ENABLED;
    delete process.env.NORDRELAY_PI_ENABLED;
    delete process.env.NORDRELAY_DEFAULT_AGENT;
    delete process.env.PI_CLI_PATH;
    delete process.env.PI_SESSION_DIR;
    delete process.env.PI_DEFAULT_MODEL;
    delete process.env.PI_DEFAULT_THINKING;
    delete process.env.WORKSPACE_ALLOWED_ROOTS;
    delete process.env.WORKSPACE_WARN_ROOTS;
    delete process.env.NORDRELAY_STATE_BACKEND;
    delete process.env.NORDRELAY_AUDIT_MAX_EVENTS;
    delete process.env.NORDRELAY_SESSION_LOCK_TTL_MS;
    delete process.env.ENABLE_TELEGRAM_LOGIN;
    delete process.env.ENABLE_TELEGRAM_REACTIONS;
    delete process.env.VOICE_PREFERRED_BACKEND;
    delete process.env.VOICE_DEFAULT_LANGUAGE;
    delete process.env.VOICE_TRANSCRIBE_ONLY;
    delete process.env.container;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it("throws when TELEGRAM_BOT_TOKEN is missing", () => {
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.TELEGRAM_ADMIN_USER_IDS = "123";

    expect(() => loadConfig()).toThrow("Missing required environment variable: TELEGRAM_BOT_TOKEN");
  });

  it("throws when Telegram admin ids are missing", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";

    expect(() => loadConfig()).toThrow("TELEGRAM_ADMIN_USER_IDS must contain at least one id");
  });

  it("allows only configured admin ids by default", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ADMIN_USER_IDS = "123";

    const config = loadConfig();

    expect(config.telegramAllowedUserIds).toEqual([123]);
    expect(config.telegramAllowedUserIdSet).toEqual(new Set([123]));
    expect(config.telegramAdminUserIds).toEqual([123]);
    expect(config.telegramAdminUserIdSet).toEqual(new Set([123]));
  });

  it("parses a valid config correctly", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123,456";
    process.env.TELEGRAM_ADMIN_USER_IDS = "123";
    process.env.CODEX_API_KEY = "secret-key";
    process.env.CODEX_MODEL = "o3";
    process.env.CODEX_SANDBOX_MODE = "danger-full-access";
    process.env.CODEX_APPROVAL_POLICY = "on-request";
    process.env.TOOL_VERBOSITY = "all";

    const config = loadConfig();

    expect(config).toEqual({
      telegramBotToken: "bot-token",
      telegramAllowedUserIds: [123, 456],
      telegramAllowedUserIdSet: new Set([123, 456]),
      telegramAllowedChatIds: [],
      telegramAllowedChatIdSet: new Set(),
      telegramAdminUserIds: [123],
      telegramAdminUserIdSet: new Set([123]),
      telegramReadOnlyUserIds: [],
      telegramReadOnlyUserIdSet: new Set(),
      telegramRolePolicies: createDefaultRolePolicies(),
      telegramAllowAnyChat: false,
      telegramRateLimitMinIntervalMs: 80,
      telegramEditMinIntervalMs: 1_200,
      telegramMirrorMode: "status",
      telegramMirrorMinUpdateMs: 4_000,
      telegramNotifyMode: "minimal",
      telegramQuietHours: null,
      telegramRedactPatterns: [],
      telegramTransport: "polling",
      telegramWebhookUrl: undefined,
      telegramWebhookHost: "127.0.0.1",
      telegramWebhookPort: 8080,
      telegramWebhookPath: "/telegram/webhook",
      telegramWebhookSecret: undefined,
      workspace: process.cwd(),
      workspaceAllowedRoots: [],
      workspaceWarnRoots: [],
      stateBackend: "json",
      maxFileSize: 20 * 1024 * 1024,
      artifactRetentionDays: 7,
      artifactMaxTurnDirs: 30,
      artifactMaxInboxDirs: 30,
      artifactIgnoreDirs: [],
      artifactIgnoreGlobs: [],
      telegramAutoSendArtifacts: false,
      codexEnabled: true,
      codexApiKey: "secret-key",
      codexModel: "o3",
      codexSyncIntervalMs: 10_000,
      codexExternalBusyCheckMs: 5_000,
      codexExternalBusyStaleMs: 300_000,
      codexSandboxMode: "danger-full-access",
      codexApprovalPolicy: "on-request",
      launchProfiles: [
        {
          id: "default",
          label: "Default",
          sandboxMode: "danger-full-access",
          approvalPolicy: "on-request",
          unsafe: true,
        },
        {
          id: "readonly",
          label: "Read Only",
          sandboxMode: "read-only",
          approvalPolicy: "never",
          unsafe: false,
        },
        {
          id: "review",
          label: "Review",
          sandboxMode: "workspace-write",
          approvalPolicy: "on-request",
          unsafe: false,
        },
      ],
      defaultLaunchProfileId: "default",
      enableUnsafeLaunchProfiles: false,
      piEnabled: false,
      piCliPath: undefined,
      piSessionDir: undefined,
      piDefaultModel: undefined,
      piDefaultThinking: "medium",
      piDefaultLaunchProfileId: "default",
      defaultAgent: "codex",
      toolVerbosity: "all",
      logFormat: "text",
      showTurnTokenUsage: false,
      enableTelegramLogin: true,
      enableTelegramReactions: false,
      voicePreferredBackend: "auto",
      voiceDefaultLanguage: undefined,
      voiceTranscribeOnly: false,
      auditMaxEvents: 1000,
      sessionLockTtlMs: 1_800_000,
    });
  });

  it("applies default values for optional fields", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.TELEGRAM_ADMIN_USER_IDS = "123";

    const config = loadConfig();

    expect(config.codexApiKey).toBeUndefined();
    expect(config.codexEnabled).toBe(true);
    expect(config.piEnabled).toBe(false);
    expect(config.defaultAgent).toBe("codex");
    expect(config.piCliPath).toBeUndefined();
    expect(config.piSessionDir).toBeUndefined();
    expect(config.piDefaultModel).toBeUndefined();
    expect(config.piDefaultThinking).toBe("medium");
    expect(config.piDefaultLaunchProfileId).toBe("default");
    expect(config.codexModel).toBeUndefined();
    expect(config.codexSyncIntervalMs).toBe(10_000);
    expect(config.codexExternalBusyCheckMs).toBe(5_000);
    expect(config.codexExternalBusyStaleMs).toBe(300_000);
    expect(config.telegramRateLimitMinIntervalMs).toBe(80);
    expect(config.telegramEditMinIntervalMs).toBe(1_200);
    expect(config.telegramMirrorMode).toBe("status");
    expect(config.telegramMirrorMinUpdateMs).toBe(4_000);
    expect(config.telegramNotifyMode).toBe("minimal");
    expect(config.telegramQuietHours).toBeNull();
    expect(config.telegramRedactPatterns).toEqual([]);
    expect(config.telegramTransport).toBe("polling");
    expect(config.telegramWebhookUrl).toBeUndefined();
    expect(config.telegramWebhookHost).toBe("127.0.0.1");
    expect(config.telegramWebhookPort).toBe(8080);
    expect(config.telegramWebhookPath).toBe("/telegram/webhook");
    expect(config.telegramWebhookSecret).toBeUndefined();
    expect(config.maxFileSize).toBe(20 * 1024 * 1024);
    expect(config.artifactRetentionDays).toBe(7);
    expect(config.artifactMaxTurnDirs).toBe(30);
    expect(config.artifactMaxInboxDirs).toBe(30);
    expect(config.artifactIgnoreDirs).toEqual([]);
    expect(config.artifactIgnoreGlobs).toEqual([]);
    expect(config.telegramAutoSendArtifacts).toBe(false);
    expect(config.stateBackend).toBe("json");
    expect(config.auditMaxEvents).toBe(1000);
    expect(config.sessionLockTtlMs).toBe(1_800_000);
    expect(config.codexSandboxMode).toBe("workspace-write");
    expect(config.codexApprovalPolicy).toBe("never");
    expect(config.launchProfiles).toEqual([
      {
        id: "default",
        label: "Default",
        sandboxMode: "workspace-write",
        approvalPolicy: "never",
        unsafe: false,
      },
      {
        id: "readonly",
        label: "Read Only",
        sandboxMode: "read-only",
        approvalPolicy: "never",
        unsafe: false,
      },
      {
        id: "review",
        label: "Review",
        sandboxMode: "workspace-write",
        approvalPolicy: "on-request",
        unsafe: false,
      },
    ]);
    expect(config.defaultLaunchProfileId).toBe("default");
    expect(config.telegramAdminUserIds).toEqual([123]);
    expect(config.telegramReadOnlyUserIds).toEqual([]);
    expect(config.telegramRolePolicies).toEqual(createDefaultRolePolicies());
    expect(config.enableUnsafeLaunchProfiles).toBe(false);
    expect(config.toolVerbosity).toBe("summary");
    expect(config.logFormat).toBe("text");
    expect(config.showTurnTokenUsage).toBe(false);
    expect(config.enableTelegramLogin).toBe(true);
    expect(config.enableTelegramReactions).toBe(false);
    expect(config.voicePreferredBackend).toBe("auto");
    expect(config.voiceDefaultLanguage).toBeUndefined();
    expect(config.voiceTranscribeOnly).toBe(false);
    expect(config.workspaceAllowedRoots).toEqual([]);
    expect(config.workspaceWarnRoots).toEqual([]);
    expect(config.workspace).toBe(process.cwd());
  });

  it("parses webhook transport settings", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ADMIN_USER_IDS = "123";
    process.env.TELEGRAM_TRANSPORT = "webhook";
    process.env.TELEGRAM_WEBHOOK_URL = "https://relay.example";
    process.env.TELEGRAM_WEBHOOK_HOST = "0.0.0.0";
    process.env.TELEGRAM_WEBHOOK_PORT = "9443";
    process.env.TELEGRAM_WEBHOOK_PATH = "telegram";
    process.env.TELEGRAM_WEBHOOK_SECRET = "secret";
    process.env.NORDRELAY_STATE_BACKEND = "sqlite";

    const config = loadConfig();

    expect(config.telegramTransport).toBe("webhook");
    expect(config.telegramWebhookUrl).toBe("https://relay.example");
    expect(config.telegramWebhookHost).toBe("0.0.0.0");
    expect(config.telegramWebhookPort).toBe(9443);
    expect(config.telegramWebhookPath).toBe("/telegram");
    expect(config.telegramWebhookSecret).toBe("secret");
    expect(config.stateBackend).toBe("sqlite");
  });

  it("requires a webhook URL when webhook transport is enabled", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ADMIN_USER_IDS = "123";
    process.env.TELEGRAM_TRANSPORT = "webhook";

    expect(() => loadConfig()).toThrow("TELEGRAM_TRANSPORT=webhook requires TELEGRAM_WEBHOOK_URL");
  });

  it("throws when a user id is invalid", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123,nope";

    expect(() => loadConfig()).toThrow(
      "Invalid Telegram id in TELEGRAM_ALLOWED_USER_IDS: nope",
    );
  });

  it("rejects an allowed-user list that becomes empty after parsing", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = " , , ";

    expect(() => loadConfig()).toThrow("TELEGRAM_ALLOWED_USER_IDS must contain at least one id");
  });

  it("accepts TELEGRAM_ALLOWED_CHAT_IDS without user ids", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ADMIN_USER_IDS = "789";
    process.env.TELEGRAM_ALLOWED_CHAT_IDS = "123,-456";

    const config = loadConfig();

    expect(config.telegramAllowedUserIds).toEqual([789]);
    expect(config.telegramAllowedChatIds).toEqual([123, -456]);
    expect(config.telegramAllowedChatIdSet).toEqual(new Set([123, -456]));
    expect(config.telegramAdminUserIds).toEqual([789]);
  });

  it("allows any chat only when explicitly enabled and admin ids are configured", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ADMIN_USER_IDS = "123";
    process.env.TELEGRAM_ALLOW_ANY_CHAT = "true";

    const config = loadConfig();

    expect(config.telegramAllowAnyChat).toBe(true);
    expect(config.telegramAllowedUserIds).toEqual([123]);
    expect(config.telegramAllowedChatIds).toEqual([]);
    expect(config.telegramAdminUserIds).toEqual([123]);
  });

  it("parses explicit admin and read-only user ids", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123,456";
    process.env.TELEGRAM_ADMIN_USER_IDS = "123";
    process.env.TELEGRAM_READONLY_USER_IDS = "456";

    const config = loadConfig();

    expect(config.telegramAdminUserIds).toEqual([123]);
    expect(config.telegramAdminUserIdSet).toEqual(new Set([123]));
    expect(config.telegramReadOnlyUserIds).toEqual([456]);
    expect(config.telegramReadOnlyUserIdSet).toEqual(new Set([456]));
  });

  it("parses granular role policies", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123,456";
    process.env.TELEGRAM_ADMIN_USER_IDS = "123";
    process.env.TELEGRAM_ROLE_POLICIES_JSON = JSON.stringify({
      operator: ["inspect", "prompt"],
      readonly: ["inspect"],
      admin: "*",
    });

    const config = loadConfig();

    expect(config.telegramRolePolicies.operator).toEqual(new Set(["inspect", "prompt"]));
    expect(config.telegramRolePolicies.readonly).toEqual(new Set(["inspect"]));
    expect(config.telegramRolePolicies.admin.has("admin")).toBe(true);
    expect(config.telegramRolePolicies.admin.has("files")).toBe(true);
  });

  it("rejects invalid granular role policies", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.TELEGRAM_ADMIN_USER_IDS = "123";
    process.env.TELEGRAM_ROLE_POLICIES_JSON = JSON.stringify({
      operator: ["inspect", "destroy"],
    });

    expect(() => loadConfig()).toThrow(
      "Invalid TELEGRAM_ROLE_POLICIES_JSON permission for operator: destroy",
    );
  });

  it("loads values from .env without overwriting existing environment variables", () => {
    writeFileSync(
      path.join(tempDir, ".env"),
      [
        "# comment",
        "export TELEGRAM_BOT_TOKEN=from-file",
        "TELEGRAM_ALLOWED_USER_IDS=123,456",
        "TELEGRAM_ADMIN_USER_IDS=123",
        "CODEX_API_KEY='from-dotenv'",
        'CODEX_MODEL="gpt-4.1"',
        "CODEX_SANDBOX_MODE=read-only",
        "CODEX_APPROVAL_POLICY=on-failure",
        'EXTRA_MULTILINE="hello\\nworld"',
      ].join("\n"),
    );
    process.env.TELEGRAM_BOT_TOKEN = "from-process";

    const config = loadConfig();

    expect(config.telegramBotToken).toBe("from-process");
    expect(config.telegramAllowedUserIds).toEqual([123, 456]);
    expect(config.codexApiKey).toBe("from-dotenv");
    expect(config.codexModel).toBe("gpt-4.1");
    expect(config.codexSandboxMode).toBe("read-only");
    expect(config.codexApprovalPolicy).toBe("on-failure");
    expect(config.launchProfiles).toEqual([
      {
        id: "default",
        label: "Default",
        sandboxMode: "read-only",
        approvalPolicy: "on-failure",
        unsafe: false,
      },
      {
        id: "readonly",
        label: "Read Only",
        sandboxMode: "read-only",
        approvalPolicy: "never",
        unsafe: false,
      },
      {
        id: "review",
        label: "Review",
        sandboxMode: "workspace-write",
        approvalPolicy: "on-request",
        unsafe: false,
      },
    ]);
    expect(process.env.EXTRA_MULTILINE).toBe("hello\nworld");
  });

  it("resolves workspace to /workspace when running in Docker", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.TELEGRAM_ADMIN_USER_IDS = "123";
    process.env.container = "docker";

    const config = loadConfig();

    expect(config.workspace).toBe("/workspace");
  });

  it("parses MAX_FILE_SIZE when configured", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.TELEGRAM_ADMIN_USER_IDS = "123";
    process.env.MAX_FILE_SIZE = String(5 * 1024 * 1024);

    const config = loadConfig();

    expect(config.maxFileSize).toBe(5 * 1024 * 1024);
  });

  it("parses artifact retention settings", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.TELEGRAM_ADMIN_USER_IDS = "123";
    process.env.ARTIFACT_RETENTION_DAYS = "14.5";
    process.env.ARTIFACT_MAX_TURNS = "80";
    process.env.ARTIFACT_MAX_INBOX_DIRS = "12";

    const config = loadConfig();

    expect(config.artifactRetentionDays).toBe(14.5);
    expect(config.artifactMaxTurnDirs).toBe(80);
    expect(config.artifactMaxInboxDirs).toBe(12);
  });

  it("parses TELEGRAM_AUTO_SEND_ARTIFACTS", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.TELEGRAM_ADMIN_USER_IDS = "123";
    process.env.TELEGRAM_AUTO_SEND_ARTIFACTS = "true";

    expect(loadConfig().telegramAutoSendArtifacts).toBe(true);

    process.env.TELEGRAM_AUTO_SEND_ARTIFACTS = "0";
    expect(loadConfig().telegramAutoSendArtifacts).toBe(false);
  });

  it("parses CODEX_SYNC_INTERVAL_MS", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.TELEGRAM_ADMIN_USER_IDS = "123";
    process.env.CODEX_SYNC_INTERVAL_MS = "2500";

    const config = loadConfig();

    expect(config.codexSyncIntervalMs).toBe(2500);
  });

  it("parses external Codex busy polling settings", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.TELEGRAM_ADMIN_USER_IDS = "123";
    process.env.CODEX_EXTERNAL_BUSY_CHECK_MS = "1500";
    process.env.CODEX_EXTERNAL_BUSY_STALE_MS = "600000";

    const config = loadConfig();

    expect(config.codexExternalBusyCheckMs).toBe(1500);
    expect(config.codexExternalBusyStaleMs).toBe(600_000);
  });

  it("parses Pi agent settings", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.TELEGRAM_ADMIN_USER_IDS = "123";
    process.env.NORDRELAY_PI_ENABLED = "true";
    process.env.NORDRELAY_DEFAULT_AGENT = "pi";
    process.env.PI_CLI_PATH = "/usr/local/bin/pi";
    process.env.PI_SESSION_DIR = "/tmp/pi-sessions";
    process.env.PI_DEFAULT_MODEL = "openai-codex/gpt-5.5";
    process.env.PI_DEFAULT_THINKING = "xhigh";
    process.env.PI_DEFAULT_PROFILE = "safe-offline";

    const config = loadConfig();

    expect(config.piEnabled).toBe(true);
    expect(config.defaultAgent).toBe("pi");
    expect(config.piCliPath).toBe("/usr/local/bin/pi");
    expect(config.piSessionDir).toBe("/tmp/pi-sessions");
    expect(config.piDefaultModel).toBe("openai-codex/gpt-5.5");
    expect(config.piDefaultThinking).toBe("xhigh");
    expect(config.piDefaultLaunchProfileId).toBe("safe-offline");
  });

  it("rejects a default agent that is not enabled", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.TELEGRAM_ADMIN_USER_IDS = "123";
    process.env.NORDRELAY_CODEX_ENABLED = "false";
    process.env.NORDRELAY_DEFAULT_AGENT = "codex";

    expect(() => loadConfig()).toThrow("At least one agent must be enabled");

    process.env.NORDRELAY_PI_ENABLED = "true";
    expect(() => loadConfig()).toThrow("NORDRELAY_DEFAULT_AGENT=codex requires NORDRELAY_CODEX_ENABLED=true");
  });

  it("parses CONNECTOR_LOG_FORMAT", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.TELEGRAM_ADMIN_USER_IDS = "123";
    process.env.CONNECTOR_LOG_FORMAT = "json";

    const config = loadConfig();

    expect(config.logFormat).toBe("json");
  });

  it("parses ENABLE_TELEGRAM_LOGIN boolean values", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.TELEGRAM_ADMIN_USER_IDS = "123";

    const truthyValues = ["true", "1", "yes"];
    const falsyValues = ["false", "0", "no"];

    for (const value of truthyValues) {
      process.env.ENABLE_TELEGRAM_LOGIN = value;
      const config = loadConfig();
      expect(config.enableTelegramLogin).toBe(true);
    }

    for (const value of falsyValues) {
      process.env.ENABLE_TELEGRAM_LOGIN = value;
      const config = loadConfig();
      expect(config.enableTelegramLogin).toBe(false);
    }

    delete process.env.ENABLE_TELEGRAM_LOGIN;
    const config = loadConfig();
    expect(config.enableTelegramLogin).toBe(true);
  });

  it("parses ENABLE_TELEGRAM_REACTIONS boolean values", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.TELEGRAM_ADMIN_USER_IDS = "123";

    const truthyValues = ["true", "1", "yes"];
    const falsyValues = ["false", "0", "no"];

    for (const value of truthyValues) {
      process.env.ENABLE_TELEGRAM_REACTIONS = value;
      const config = loadConfig();
      expect(config.enableTelegramReactions).toBe(true);
    }

    for (const value of falsyValues) {
      process.env.ENABLE_TELEGRAM_REACTIONS = value;
      const config = loadConfig();
      expect(config.enableTelegramReactions).toBe(false);
    }

    delete process.env.ENABLE_TELEGRAM_REACTIONS;
    const config = loadConfig();
    expect(config.enableTelegramReactions).toBe(false);
  });

  it("parses SHOW_TURN_TOKEN_USAGE boolean values", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.TELEGRAM_ADMIN_USER_IDS = "123";

    const truthyValues = ["true", "1", "yes"];
    const falsyValues = ["false", "0", "no"];

    for (const value of truthyValues) {
      process.env.SHOW_TURN_TOKEN_USAGE = value;
      const config = loadConfig();
      expect(config.showTurnTokenUsage).toBe(true);
    }

    for (const value of falsyValues) {
      process.env.SHOW_TURN_TOKEN_USAGE = value;
      const config = loadConfig();
      expect(config.showTurnTokenUsage).toBe(false);
    }

    delete process.env.SHOW_TURN_TOKEN_USAGE;
    const config = loadConfig();
    expect(config.showTurnTokenUsage).toBe(false);
  });

  it("falls back to defaults for invalid optional enum values", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.TELEGRAM_ADMIN_USER_IDS = "123";
    process.env.CODEX_SANDBOX_MODE = "unsafe";
    process.env.CODEX_APPROVAL_POLICY = "sometimes";
    process.env.TOOL_VERBOSITY = "loud";
    process.env.CONNECTOR_LOG_FORMAT = "xml";
    process.env.MAX_FILE_SIZE = "nope";
    process.env.ARTIFACT_MAX_TURNS = "-1";
    process.env.CODEX_SYNC_INTERVAL_MS = "-1";
    process.env.CODEX_EXTERNAL_BUSY_CHECK_MS = "0";
    process.env.CODEX_EXTERNAL_BUSY_STALE_MS = "-1";

    const config = loadConfig();

    expect(config.codexSandboxMode).toBe("workspace-write");
    expect(config.codexApprovalPolicy).toBe("never");
    expect(config.toolVerbosity).toBe("summary");
    expect(config.maxFileSize).toBe(20 * 1024 * 1024);
    expect(config.artifactMaxTurnDirs).toBe(30);
    expect(config.codexSyncIntervalMs).toBe(10_000);
    expect(config.codexExternalBusyCheckMs).toBe(5_000);
    expect(config.codexExternalBusyStaleMs).toBe(300_000);
    expect(config.logFormat).toBe("text");
    expect(warnSpy).toHaveBeenCalledTimes(9);
  });

  it("parses explicit launch profiles and default selection", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.TELEGRAM_ADMIN_USER_IDS = "123";
    process.env.ENABLE_UNSAFE_LAUNCH_PROFILES = "true";
    process.env.CODEX_LAUNCH_PROFILES_JSON = JSON.stringify([
      {
        id: "readonly",
        label: "Workspace Read Only",
        sandboxMode: "read-only",
        approvalPolicy: "never",
      },
      {
        id: "danger-full",
        label: "Danger Full",
        sandboxMode: "danger-full-access",
        approvalPolicy: "never",
      },
    ]);
    process.env.CODEX_DEFAULT_LAUNCH_PROFILE = "readonly";

    const config = loadConfig();

    expect(config.enableUnsafeLaunchProfiles).toBe(true);
    expect(config.defaultLaunchProfileId).toBe("readonly");
    expect(config.launchProfiles).toEqual([
      {
        id: "default",
        label: "Default",
        sandboxMode: "workspace-write",
        approvalPolicy: "never",
        unsafe: false,
      },
      {
        id: "readonly",
        label: "Workspace Read Only",
        sandboxMode: "read-only",
        approvalPolicy: "never",
        unsafe: false,
      },
      {
        id: "review",
        label: "Review",
        sandboxMode: "workspace-write",
        approvalPolicy: "on-request",
        unsafe: false,
      },
      {
        id: "full-access",
        label: "Full Access",
        sandboxMode: "danger-full-access",
        approvalPolicy: "never",
        unsafe: true,
      },
      {
        id: "danger-full",
        label: "Danger Full",
        sandboxMode: "danger-full-access",
        approvalPolicy: "never",
        unsafe: true,
      },
    ]);
  });

  it("throws when CODEX_DEFAULT_LAUNCH_PROFILE is unknown", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.TELEGRAM_ADMIN_USER_IDS = "123";
    process.env.CODEX_LAUNCH_PROFILES_JSON = JSON.stringify([
      {
        id: "readonly",
        label: "Read Only",
        sandboxMode: "read-only",
        approvalPolicy: "never",
      },
    ]);
    process.env.CODEX_DEFAULT_LAUNCH_PROFILE = "missing";

    expect(() => loadConfig()).toThrow("Unknown CODEX_DEFAULT_LAUNCH_PROFILE: missing");
  });

  it("throws when unsafe extra launch profiles are configured without enabling them", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.TELEGRAM_ADMIN_USER_IDS = "123";
    process.env.CODEX_LAUNCH_PROFILES_JSON = JSON.stringify([
      {
        id: "danger-full",
        label: "Danger Full",
        sandboxMode: "danger-full-access",
        approvalPolicy: "never",
      },
    ]);

    expect(() => loadConfig()).toThrow(
      'Unsafe launch profile "danger-full" requires ENABLE_UNSAFE_LAUNCH_PROFILES=true',
    );
  });

  it("throws on duplicate launch profile ids", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_ALLOWED_USER_IDS = "123";
    process.env.TELEGRAM_ADMIN_USER_IDS = "123";
    process.env.CODEX_LAUNCH_PROFILES_JSON = JSON.stringify([
      {
        id: "readonly",
        label: "Read Only",
        sandboxMode: "read-only",
        approvalPolicy: "never",
      },
      {
        id: "readonly",
        label: "Read Only 2",
        sandboxMode: "workspace-write",
        approvalPolicy: "on-request",
      },
    ]);

    expect(() => loadConfig()).toThrow("Duplicate launch profile id: readonly");
  });
});
