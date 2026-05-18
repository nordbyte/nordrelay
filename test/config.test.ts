import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import { loadConfig } from "../src/core/config.js";

describe("loadConfig", () => {
  const originalEnv = process.env;
  const originalCwd = process.cwd();
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "nordrelay-config-"));
    process.chdir(tempDir);
    process.env = { ...originalEnv };
    delete process.env.NORDRELAY_WEBUI_ENABLED;
    delete process.env.TELEGRAM_ENABLED;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_RATE_LIMIT_MIN_INTERVAL_MS;
    delete process.env.TELEGRAM_EDIT_MIN_INTERVAL_MS;
    delete process.env.NORDRELAY_CLI_MIRROR_MODE;
    delete process.env.NORDRELAY_CLI_MIRROR_MIN_UPDATE_MS;
    delete process.env.NORDRELAY_WEB_CLI_MIRROR_MODE;
    delete process.env.NORDRELAY_WEB_CLI_MIRROR_MIN_UPDATE_MS;
    delete process.env.NORDRELAY_NOTIFY_MODE;
    delete process.env.NORDRELAY_QUIET_HOURS;
    delete process.env.NORDRELAY_AUTO_SEND_ARTIFACTS;
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
    delete process.env.DISCORD_ENABLED;
    delete process.env.DISCORD_BOT_TOKEN;
    delete process.env.DISCORD_CLIENT_ID;
    delete process.env.DISCORD_GUILD_IDS;
    delete process.env.DISCORD_ALLOWED_GUILD_IDS;
    delete process.env.DISCORD_ALLOWED_CHANNEL_IDS;
    delete process.env.DISCORD_MESSAGE_CONTENT_ENABLED;
    delete process.env.DISCORD_COMMAND_MODE;
    delete process.env.DISCORD_AUTO_REGISTER_COMMANDS;
    delete process.env.DISCORD_CLI_MIRROR_MODE;
    delete process.env.DISCORD_CLI_MIRROR_MIN_UPDATE_MS;
    delete process.env.DISCORD_NOTIFY_MODE;
    delete process.env.DISCORD_QUIET_HOURS;
    delete process.env.DISCORD_AUTO_SEND_ARTIFACTS;
    delete process.env.SLACK_ENABLED;
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_APP_TOKEN;
    delete process.env.SLACK_SIGNING_SECRET;
    delete process.env.SLACK_SOCKET_MODE;
    delete process.env.SLACK_PORT;
    delete process.env.SLACK_ALLOWED_TEAM_IDS;
    delete process.env.SLACK_ALLOWED_CHANNEL_IDS;
    delete process.env.SLACK_MESSAGE_CONTENT_ENABLED;
    delete process.env.SLACK_COMMAND;
    delete process.env.SLACK_CLI_MIRROR_MODE;
    delete process.env.SLACK_CLI_MIRROR_MIN_UPDATE_MS;
    delete process.env.SLACK_NOTIFY_MODE;
    delete process.env.SLACK_QUIET_HOURS;
    delete process.env.SLACK_AUTO_SEND_ARTIFACTS;
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
    delete process.env.ARTIFACT_MAX_TOTAL_BYTES;
    delete process.env.ARTIFACT_WARN_PERCENT;
    delete process.env.ARTIFACT_SAFE_FILE_POLICY;
    delete process.env.ARTIFACT_IGNORE_DIRS;
    delete process.env.ARTIFACT_IGNORE_GLOBS;
    delete process.env.TELEGRAM_AUTO_SEND_ARTIFACTS;
    delete process.env.NORDRELAY_CODEX_ENABLED;
    delete process.env.NORDRELAY_PI_ENABLED;
    delete process.env.NORDRELAY_HERMES_ENABLED;
    delete process.env.NORDRELAY_OPENCLAW_ENABLED;
    delete process.env.NORDRELAY_DEFAULT_AGENT;
    delete process.env.PI_CLI_PATH;
    delete process.env.PI_SESSION_DIR;
    delete process.env.PI_DEFAULT_MODEL;
    delete process.env.PI_DEFAULT_THINKING;
    delete process.env.PI_DEFAULT_PROFILE;
    delete process.env.HERMES_CLI_PATH;
    delete process.env.HERMES_HOME;
    delete process.env.HERMES_STATE_DB_PATH;
    delete process.env.HERMES_API_BASE_URL;
    delete process.env.HERMES_API_KEY;
    delete process.env.HERMES_DEFAULT_MODEL;
    delete process.env.HERMES_DEFAULT_REASONING;
    delete process.env.HERMES_DEFAULT_PROFILE;
    delete process.env.OPENCLAW_CLI_PATH;
    delete process.env.OPENCLAW_GATEWAY_URL;
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    delete process.env.OPENCLAW_GATEWAY_PASSWORD;
    delete process.env.OPENCLAW_AGENT_ID;
    delete process.env.OPENCLAW_HOME;
    delete process.env.OPENCLAW_STATE_DIR;
    delete process.env.OPENCLAW_DEFAULT_MODEL;
    delete process.env.OPENCLAW_DEFAULT_THINKING;
    delete process.env.OPENCLAW_DEFAULT_PROFILE;
    delete process.env.WORKSPACE_ALLOWED_ROOTS;
    delete process.env.WORKSPACE_WARN_ROOTS;
    delete process.env.NORDRELAY_WORKSPACE;
    delete process.env.NORDRELAY_SOURCE_ROOT;
    delete process.env.NORDRELAY_STATE_BACKEND;
    delete process.env.NORDRELAY_SESSION_WORKSPACE_MODE;
    delete process.env.NORDRELAY_SESSION_WORKTREE_ROOT;
    delete process.env.NORDRELAY_SESSION_WORKTREE_BRANCH_PREFIX;
    delete process.env.NORDRELAY_AUDIT_MAX_EVENTS;
    delete process.env.NORDRELAY_SESSION_LOCK_TTL_MS;
    delete process.env.NORDRELAY_PEER_ENABLED;
    delete process.env.NORDRELAY_PEER_NAME;
    delete process.env.NORDRELAY_PEER_HOST;
    delete process.env.NORDRELAY_PEER_PORT;
    delete process.env.NORDRELAY_PEER_PUBLIC_URL;
    delete process.env.NORDRELAY_PEER_TLS_ENABLED;
    delete process.env.NORDRELAY_PEER_REQUIRE_TLS;
    delete process.env.NORDRELAY_PEER_DISCOVERY_TIMEOUT_MS;
    delete process.env.NORDRELAY_PEER_HEALTH_CHECK_MS;
    delete process.env.NORDRELAY_PEER_OUTBOUND_RELAY_ENABLED;
    delete process.env.NORDRELAY_PEER_OUTBOUND_RELAY_PEERS;
    delete process.env.NORDRELAY_PEER_OUTBOUND_RELAY_POLL_MS;
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

  it("throws when no usable access surface is configured", () => {
    process.env.NORDRELAY_WEBUI_ENABLED = "false";

    expect(() => loadConfig()).toThrow("At least WebUI or one usable chat adapter must be enabled");
  });

  it("allows a WebUI-only setup without chat adapters", () => {
    const config = loadConfig();

    expect(config.webuiEnabled).toBe(true);
    expect(config.telegramEnabled).toBe(false);
    expect(config.discordEnabled).toBe(false);
    expect(config.slackEnabled).toBe(false);
    expect(config.adapterWarnings).toContain("Telegram disabled: TELEGRAM_BOT_TOKEN is missing.");
  });

  it("parses a valid config correctly", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.CODEX_API_KEY = "secret-key";
    process.env.CODEX_MODEL = "o3";
    process.env.CODEX_SANDBOX_MODE = "danger-full-access";
    process.env.CODEX_APPROVAL_POLICY = "on-request";
    process.env.TOOL_VERBOSITY = "all";

    const config = loadConfig();

    expect(config).toEqual({
      adapterWarnings: [],
      webuiEnabled: true,
      telegramEnabled: true,
      telegramBotToken: "bot-token",
      telegramRateLimitMinIntervalMs: 80,
      telegramEditMinIntervalMs: 1_200,
      mirrorMode: "status",
      mirrorMinUpdateMs: 4_000,
      webMirrorMode: "status",
      webMirrorMinUpdateMs: 4_000,
      notifyMode: "minimal",
      quietHours: null,
      autoSendArtifacts: false,
      artifactDeliveryMode: "manual-only",
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
      discordArtifactDeliveryMode: "manual-only",
      slackEnabled: false,
      slackBotToken: undefined,
      slackAppToken: undefined,
      slackSigningSecret: undefined,
      slackSocketMode: true,
      slackPort: 3000,
      slackAllowedTeamIds: [],
      slackAllowedChannelIds: [],
      slackMessageContentEnabled: true,
      slackCommand: "/nordrelay",
      slackMirrorMode: "status",
      slackMirrorMinUpdateMs: 4_000,
      slackNotifyMode: "minimal",
      slackQuietHours: null,
      slackAutoSendArtifacts: false,
      slackArtifactDeliveryMode: "manual-only",
      workspace: process.cwd(),
      workspaceAllowedRoots: [],
      workspaceWarnRoots: [],
      sessionWorkspaceMode: "shared",
      sessionWorktreeRoot: path.join(homedir(), ".nordrelay", "worktrees"),
      sessionWorktreeBranchPrefix: "nr/session",
      stateBackend: "json",
      maxFileSize: 20 * 1024 * 1024,
      artifactRetentionDays: 7,
      artifactMaxTurnDirs: 30,
      artifactMaxInboxDirs: 30,
      artifactMaxTotalBytes: 0,
      artifactWarnPercent: 80,
      artifactSafeFilePolicy: "warn",
      artifactIgnoreDirs: [],
      artifactIgnoreGlobs: [],
      telegramAutoSendArtifacts: false,
      telegramArtifactDeliveryMode: "manual-only",
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
      peerEnabled: false,
      peerHealthCheckMs: 60_000,
      peerDiscoveryTimeoutMs: 650,
      peerName: undefined,
      peerHost: "127.0.0.1",
      peerPort: 31979,
      peerPublicUrl: undefined,
      peerTlsEnabled: true,
      peerRequireTls: true,
      peerOutboundRelayEnabled: false,
      peerOutboundRelayPeerIds: [],
      peerOutboundRelayPollMs: 1000,
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
      dashboardCacheTtlMs: 10_000,
      unifiedJobMaxItems: 1000,
    });
  });

  it("applies default values for optional fields", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";

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
    expect(config.hermesEnabled).toBe(false);
    expect(config.hermesCliPath).toBeUndefined();
    expect(config.hermesHome).toBeUndefined();
    expect(config.hermesStateDbPath).toBeUndefined();
    expect(config.hermesApiBaseUrl).toBe("http://127.0.0.1:8642");
    expect(config.hermesApiKey).toBeUndefined();
    expect(config.hermesDefaultModel).toBeUndefined();
    expect(config.hermesDefaultReasoning).toBeUndefined();
    expect(config.hermesDefaultLaunchProfileId).toBe("default");
    expect(config.openClawEnabled).toBe(false);
    expect(config.openClawCliPath).toBeUndefined();
    expect(config.openClawGatewayUrl).toBe("ws://127.0.0.1:18789");
    expect(config.openClawGatewayToken).toBeUndefined();
    expect(config.openClawGatewayPassword).toBeUndefined();
    expect(config.openClawAgentId).toBe("main");
    expect(config.openClawHome).toBeUndefined();
    expect(config.openClawStateDir).toBeUndefined();
    expect(config.openClawDefaultModel).toBeUndefined();
    expect(config.openClawDefaultThinking).toBeUndefined();
    expect(config.openClawDefaultLaunchProfileId).toBe("default");
    expect(config.claudeCodeEnabled).toBe(false);
    expect(config.claudeCodeCliPath).toBeUndefined();
    expect(config.claudeCodeConfigDir).toBeUndefined();
    expect(config.claudeCodeDefaultModel).toBeUndefined();
    expect(config.claudeCodeDefaultEffort).toBeUndefined();
    expect(config.claudeCodeDefaultLaunchProfileId).toBe("default");
    expect(config.claudeCodeMaxTurns).toBe(100);
    expect(config.peerEnabled).toBe(false);
    expect(config.peerName).toBeUndefined();
    expect(config.peerHost).toBe("127.0.0.1");
    expect(config.peerPort).toBe(31979);
    expect(config.peerPublicUrl).toBeUndefined();
    expect(config.peerTlsEnabled).toBe(true);
    expect(config.peerRequireTls).toBe(true);
    expect(config.peerOutboundRelayEnabled).toBe(false);
    expect(config.peerOutboundRelayPeerIds).toEqual([]);
    expect(config.peerOutboundRelayPollMs).toBe(1000);
    expect(config.codexModel).toBeUndefined();
    expect(config.codexSyncIntervalMs).toBe(10_000);
    expect(config.codexExternalBusyCheckMs).toBe(5_000);
    expect(config.codexExternalBusyStaleMs).toBe(300_000);
    expect(config.telegramRateLimitMinIntervalMs).toBe(80);
    expect(config.telegramEditMinIntervalMs).toBe(1_200);
    expect(config.mirrorMode).toBe("status");
    expect(config.mirrorMinUpdateMs).toBe(4_000);
    expect(config.webMirrorMode).toBe("status");
    expect(config.webMirrorMinUpdateMs).toBe(4_000);
    expect(config.notifyMode).toBe("minimal");
    expect(config.quietHours).toBeNull();
    expect(config.autoSendArtifacts).toBe(false);
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
    expect(config.discordEnabled).toBe(false);
    expect(config.discordBotToken).toBeUndefined();
    expect(config.discordClientId).toBeUndefined();
    expect(config.discordGuildIds).toEqual([]);
    expect(config.discordAllowedGuildIds).toEqual([]);
    expect(config.discordAllowedChannelIds).toEqual([]);
    expect(config.discordMessageContentEnabled).toBe(true);
    expect(config.discordCommandMode).toBe("both");
    expect(config.discordAutoRegisterCommands).toBe(true);
    expect(config.discordMirrorMode).toBe("status");
    expect(config.discordMirrorMinUpdateMs).toBe(4_000);
    expect(config.discordNotifyMode).toBe("minimal");
    expect(config.discordQuietHours).toBeNull();
    expect(config.discordAutoSendArtifacts).toBe(false);
    expect(config.slackEnabled).toBe(false);
    expect(config.slackBotToken).toBeUndefined();
    expect(config.slackAppToken).toBeUndefined();
    expect(config.slackSigningSecret).toBeUndefined();
    expect(config.slackSocketMode).toBe(true);
    expect(config.slackPort).toBe(3000);
    expect(config.slackAllowedTeamIds).toEqual([]);
    expect(config.slackAllowedChannelIds).toEqual([]);
    expect(config.slackMessageContentEnabled).toBe(true);
    expect(config.slackCommand).toBe("/nordrelay");
    expect(config.slackMirrorMode).toBe("status");
    expect(config.slackMirrorMinUpdateMs).toBe(4_000);
    expect(config.slackNotifyMode).toBe("minimal");
    expect(config.slackQuietHours).toBeNull();
    expect(config.slackAutoSendArtifacts).toBe(false);
    expect(config.maxFileSize).toBe(20 * 1024 * 1024);
    expect(config.artifactRetentionDays).toBe(7);
    expect(config.artifactMaxTurnDirs).toBe(30);
    expect(config.artifactMaxInboxDirs).toBe(30);
    expect(config.artifactMaxTotalBytes).toBe(0);
    expect(config.artifactWarnPercent).toBe(80);
    expect(config.artifactSafeFilePolicy).toBe("warn");
    expect(config.artifactIgnoreDirs).toEqual([]);
    expect(config.artifactIgnoreGlobs).toEqual([]);
    expect(config.telegramAutoSendArtifacts).toBe(false);
    expect(config.stateBackend).toBe("json");
    expect(config.auditMaxEvents).toBe(1000);
    expect(config.sessionLockTtlMs).toBe(1_800_000);
    expect(config.dashboardCacheTtlMs).toBe(10_000);
    expect(config.unifiedJobMaxItems).toBe(1000);
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
    expect(config.sessionWorkspaceMode).toBe("shared");
    expect(config.sessionWorktreeRoot).toBe(path.join(homedir(), ".nordrelay", "worktrees"));
    expect(config.sessionWorktreeBranchPrefix).toBe("nr/session");
  });

  it("parses webhook transport settings", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
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

  it("parses peer federation settings", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.NORDRELAY_PEER_ENABLED = "true";
    process.env.NORDRELAY_PEER_NAME = "Workstation";
    process.env.NORDRELAY_PEER_HOST = "0.0.0.0";
    process.env.NORDRELAY_PEER_PORT = "31980";
    process.env.NORDRELAY_PEER_PUBLIC_URL = "https://workstation.example:31980";
    process.env.NORDRELAY_PEER_TLS_ENABLED = "false";
    process.env.NORDRELAY_PEER_REQUIRE_TLS = "false";
    process.env.NORDRELAY_PEER_OUTBOUND_RELAY_ENABLED = "true";
    process.env.NORDRELAY_PEER_OUTBOUND_RELAY_PEERS = "peer-a,node-b";
    process.env.NORDRELAY_PEER_OUTBOUND_RELAY_POLL_MS = "1500";

    const config = loadConfig();

    expect(config.peerEnabled).toBe(true);
    expect(config.peerName).toBe("Workstation");
    expect(config.peerHost).toBe("0.0.0.0");
    expect(config.peerPort).toBe(31980);
    expect(config.peerPublicUrl).toBe("https://workstation.example:31980");
    expect(config.peerTlsEnabled).toBe(false);
    expect(config.peerRequireTls).toBe(false);
    expect(config.peerOutboundRelayEnabled).toBe(true);
    expect(config.peerOutboundRelayPeerIds).toEqual(["peer-a", "node-b"]);
    expect(config.peerOutboundRelayPollMs).toBe(1500);
  });

  it("throws when webhook Telegram has no URL and no other access surface is usable", () => {
    process.env.NORDRELAY_WEBUI_ENABLED = "false";
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.TELEGRAM_TRANSPORT = "webhook";

    expect(() => loadConfig()).toThrow("TELEGRAM_TRANSPORT=webhook requires TELEGRAM_WEBHOOK_URL");
  });

  it("parses Discord adapter settings", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.DISCORD_ENABLED = "true";
    process.env.DISCORD_BOT_TOKEN = "discord-token";
    process.env.DISCORD_CLIENT_ID = "client-id";
    process.env.DISCORD_GUILD_IDS = "guild-a,guild-b";
    process.env.DISCORD_ALLOWED_GUILD_IDS = "guild-a";
    process.env.DISCORD_ALLOWED_CHANNEL_IDS = "channel-a,channel-b";
    process.env.DISCORD_MESSAGE_CONTENT_ENABLED = "false";
    process.env.DISCORD_COMMAND_MODE = "slash";
    process.env.DISCORD_AUTO_REGISTER_COMMANDS = "false";

    const config = loadConfig();

    expect(config.discordEnabled).toBe(true);
    expect(config.discordBotToken).toBe("discord-token");
    expect(config.discordClientId).toBe("client-id");
    expect(config.discordGuildIds).toEqual(["guild-a", "guild-b"]);
    expect(config.discordAllowedGuildIds).toEqual(["guild-a"]);
    expect(config.discordAllowedChannelIds).toEqual(["channel-a", "channel-b"]);
    expect(config.discordMessageContentEnabled).toBe(false);
    expect(config.discordCommandMode).toBe("slash");
    expect(config.discordAutoRegisterCommands).toBe(false);
  });

  it("parses Slack adapter settings", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.SLACK_ENABLED = "true";
    process.env.SLACK_BOT_TOKEN = "xoxb-token";
    process.env.SLACK_APP_TOKEN = "xapp-token";
    process.env.SLACK_SIGNING_SECRET = "signing-secret";
    process.env.SLACK_PORT = "3010";
    process.env.SLACK_ALLOWED_TEAM_IDS = "T1,T2";
    process.env.SLACK_ALLOWED_CHANNEL_IDS = "C1,C2";
    process.env.SLACK_MESSAGE_CONTENT_ENABLED = "false";
    process.env.SLACK_COMMAND = "nord";
    process.env.SLACK_CLI_MIRROR_MODE = "full";
    process.env.SLACK_CLI_MIRROR_MIN_UPDATE_MS = "2500";
    process.env.SLACK_NOTIFY_MODE = "all";
    process.env.SLACK_QUIET_HOURS = "22-7";
    process.env.SLACK_AUTO_SEND_ARTIFACTS = "true";

    const config = loadConfig();

    expect(config.slackEnabled).toBe(true);
    expect(config.slackBotToken).toBe("xoxb-token");
    expect(config.slackAppToken).toBe("xapp-token");
    expect(config.slackSigningSecret).toBe("signing-secret");
    expect(config.slackSocketMode).toBe(true);
    expect(config.slackPort).toBe(3010);
    expect(config.slackAllowedTeamIds).toEqual(["T1", "T2"]);
    expect(config.slackAllowedChannelIds).toEqual(["C1", "C2"]);
    expect(config.slackMessageContentEnabled).toBe(false);
    expect(config.slackCommand).toBe("/nord");
    expect(config.slackMirrorMode).toBe("full");
    expect(config.slackMirrorMinUpdateMs).toBe(2_500);
    expect(config.slackNotifyMode).toBe("all");
    expect(config.slackQuietHours).toEqual({ startHour: 22, endHour: 7 });
    expect(config.slackAutoSendArtifacts).toBe(true);
  });

  it("allows Slack-only chat configuration when Telegram is disabled", () => {
    process.env.TELEGRAM_ENABLED = "false";
    process.env.SLACK_ENABLED = "true";
    process.env.SLACK_BOT_TOKEN = "xoxb-token";
    process.env.SLACK_APP_TOKEN = "xapp-token";

    const config = loadConfig();

    expect(config.telegramEnabled).toBe(false);
    expect(config.slackEnabled).toBe(true);
  });

  it("disables requested Slack without required tokens when Telegram is usable", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.SLACK_ENABLED = "true";
    process.env.SLACK_BOT_TOKEN = "xoxb-token";

    const config = loadConfig();

    expect(config.telegramEnabled).toBe(true);
    expect(config.slackEnabled).toBe(false);
    expect(config.adapterWarnings).toContain("Slack disabled: SLACK_SOCKET_MODE=true requires SLACK_APP_TOKEN.");
  });

  it("allows Discord-only chat configuration when Telegram is disabled", () => {
    process.env.TELEGRAM_ENABLED = "false";
    process.env.DISCORD_ENABLED = "true";
    process.env.DISCORD_BOT_TOKEN = "discord-token";

    const config = loadConfig();

    expect(config.telegramEnabled).toBe(false);
    expect(config.telegramBotToken).toBe("");
    expect(config.discordEnabled).toBe(true);
  });

  it("disables requested Telegram without a token when Discord is usable", () => {
    process.env.DISCORD_ENABLED = "true";
    process.env.DISCORD_BOT_TOKEN = "discord-token";

    const config = loadConfig();

    expect(config.telegramEnabled).toBe(false);
    expect(config.telegramBotToken).toBe("");
    expect(config.discordEnabled).toBe(true);
    expect(config.adapterWarnings).toContain("Telegram disabled: TELEGRAM_BOT_TOKEN is missing.");
  });

  it("disables requested Discord without a token when Telegram is usable", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.DISCORD_ENABLED = "true";

    const config = loadConfig();

    expect(config.telegramEnabled).toBe(true);
    expect(config.discordEnabled).toBe(false);
    expect(config.adapterWarnings).toContain("Discord disabled: DISCORD_ENABLED=true requires DISCORD_BOT_TOKEN.");
  });

  it("loads values from .env without overwriting existing environment variables", () => {
    writeFileSync(
      path.join(tempDir, ".env"),
      [
        "# comment",
        "export TELEGRAM_BOT_TOKEN=from-file",
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
    process.env.container = "docker";

    const config = loadConfig();

    expect(config.workspace).toBe("/workspace");
  });

  it("honors NORDRELAY_WORKSPACE even when the runtime source root is the cwd", () => {
    const workspace = path.join(tempDir, "selected-workspace");
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.NORDRELAY_WORKSPACE = workspace;
    process.env.NORDRELAY_SOURCE_ROOT = tempDir;

    const config = loadConfig();

    expect(config.workspace).toBe(workspace);
  });

  it("does not use the runtime source root as workspace when launched from a package directory", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.NORDRELAY_SOURCE_ROOT = tempDir;

    const config = loadConfig();

    expect(config.workspace).toBe(homedir());
  });

  it("parses MAX_FILE_SIZE when configured", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.MAX_FILE_SIZE = String(5 * 1024 * 1024);

    const config = loadConfig();

    expect(config.maxFileSize).toBe(5 * 1024 * 1024);
  });

  it("parses artifact retention settings", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.ARTIFACT_RETENTION_DAYS = "14.5";
    process.env.ARTIFACT_MAX_TURNS = "80";
    process.env.ARTIFACT_MAX_INBOX_DIRS = "12";

    const config = loadConfig();

    expect(config.artifactRetentionDays).toBe(14.5);
    expect(config.artifactMaxTurnDirs).toBe(80);
    expect(config.artifactMaxInboxDirs).toBe(12);
  });

  it("parses global channel defaults and channel overrides", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.NORDRELAY_CLI_MIRROR_MODE = "full";
    process.env.NORDRELAY_CLI_MIRROR_MIN_UPDATE_MS = "9000";
    process.env.NORDRELAY_NOTIFY_MODE = "all";
    process.env.NORDRELAY_QUIET_HOURS = "22-7";
    process.env.NORDRELAY_AUTO_SEND_ARTIFACTS = "true";
    process.env.DISCORD_CLI_MIRROR_MODE = "final";
    process.env.DISCORD_NOTIFY_MODE = "minimal";
    process.env.DISCORD_QUIET_HOURS = "off";
    process.env.DISCORD_AUTO_SEND_ARTIFACTS = "false";

    const config = loadConfig();

    expect(config.mirrorMode).toBe("full");
    expect(config.mirrorMinUpdateMs).toBe(9000);
    expect(config.notifyMode).toBe("all");
    expect(config.quietHours).toEqual({ startHour: 22, endHour: 7 });
    expect(config.autoSendArtifacts).toBe(true);
    expect(config.telegramMirrorMode).toBe("full");
    expect(config.telegramMirrorMinUpdateMs).toBe(9000);
    expect(config.webMirrorMode).toBe("full");
    expect(config.webMirrorMinUpdateMs).toBe(9000);
    expect(config.telegramNotifyMode).toBe("all");
    expect(config.telegramQuietHours).toEqual({ startHour: 22, endHour: 7 });
    expect(config.telegramAutoSendArtifacts).toBe(true);
    expect(config.discordMirrorMode).toBe("final");
    expect(config.discordNotifyMode).toBe("minimal");
    expect(config.discordQuietHours).toBeNull();
    expect(config.discordAutoSendArtifacts).toBe(false);
  });

  it("parses TELEGRAM_AUTO_SEND_ARTIFACTS as a Telegram override", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.NORDRELAY_AUTO_SEND_ARTIFACTS = "false";
    process.env.TELEGRAM_AUTO_SEND_ARTIFACTS = "true";

    expect(loadConfig().telegramAutoSendArtifacts).toBe(true);

    process.env.TELEGRAM_AUTO_SEND_ARTIFACTS = "0";
    expect(loadConfig().telegramAutoSendArtifacts).toBe(false);
  });

  it("parses CODEX_SYNC_INTERVAL_MS", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.CODEX_SYNC_INTERVAL_MS = "2500";

    const config = loadConfig();

    expect(config.codexSyncIntervalMs).toBe(2500);
  });

  it("parses external Codex busy polling settings", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.CODEX_EXTERNAL_BUSY_CHECK_MS = "1500";
    process.env.CODEX_EXTERNAL_BUSY_STALE_MS = "600000";

    const config = loadConfig();

    expect(config.codexExternalBusyCheckMs).toBe(1500);
    expect(config.codexExternalBusyStaleMs).toBe(600_000);
  });

  it("parses Pi agent settings", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
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

  it("parses Hermes agent settings", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.NORDRELAY_CODEX_ENABLED = "false";
    process.env.NORDRELAY_HERMES_ENABLED = "true";
    process.env.NORDRELAY_DEFAULT_AGENT = "hermes";
    process.env.HERMES_CLI_PATH = "/usr/local/bin/hermes";
    process.env.HERMES_HOME = "/home/user/.hermes-test";
    process.env.HERMES_STATE_DB_PATH = "/tmp/hermes-state.db";
    process.env.HERMES_API_BASE_URL = "http://127.0.0.1:9999";
    process.env.HERMES_API_KEY = "hermes-secret";
    process.env.HERMES_DEFAULT_MODEL = "openai/gpt-5.5";
    process.env.HERMES_DEFAULT_REASONING = "xhigh";
    process.env.HERMES_DEFAULT_PROFILE = "yolo";

    const config = loadConfig();

    expect(config.codexEnabled).toBe(false);
    expect(config.hermesEnabled).toBe(true);
    expect(config.defaultAgent).toBe("hermes");
    expect(config.hermesCliPath).toBe("/usr/local/bin/hermes");
    expect(config.hermesHome).toBe("/home/user/.hermes-test");
    expect(config.hermesStateDbPath).toBe("/tmp/hermes-state.db");
    expect(config.hermesApiBaseUrl).toBe("http://127.0.0.1:9999");
    expect(config.hermesApiKey).toBe("hermes-secret");
    expect(config.hermesDefaultModel).toBe("openai/gpt-5.5");
    expect(config.hermesDefaultReasoning).toBe("xhigh");
    expect(config.hermesDefaultLaunchProfileId).toBe("yolo");
  });

  it("parses OpenClaw agent settings", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.NORDRELAY_CODEX_ENABLED = "false";
    process.env.NORDRELAY_OPENCLAW_ENABLED = "true";
    process.env.NORDRELAY_DEFAULT_AGENT = "openclaw";
    process.env.OPENCLAW_CLI_PATH = "/usr/local/bin/openclaw";
    process.env.OPENCLAW_GATEWAY_URL = "ws://127.0.0.1:19999";
    process.env.OPENCLAW_GATEWAY_TOKEN = "openclaw-token";
    process.env.OPENCLAW_GATEWAY_PASSWORD = "openclaw-password";
    process.env.OPENCLAW_AGENT_ID = "work";
    process.env.OPENCLAW_HOME = "/home/user/.openclaw-test";
    process.env.OPENCLAW_STATE_DIR = "/tmp/openclaw-state";
    process.env.OPENCLAW_DEFAULT_MODEL = "openai/gpt-5.5";
    process.env.OPENCLAW_DEFAULT_THINKING = "xhigh";
    process.env.OPENCLAW_DEFAULT_PROFILE = "local";

    const config = loadConfig();

    expect(config.codexEnabled).toBe(false);
    expect(config.openClawEnabled).toBe(true);
    expect(config.defaultAgent).toBe("openclaw");
    expect(config.openClawCliPath).toBe("/usr/local/bin/openclaw");
    expect(config.openClawGatewayUrl).toBe("ws://127.0.0.1:19999");
    expect(config.openClawGatewayToken).toBe("openclaw-token");
    expect(config.openClawGatewayPassword).toBe("openclaw-password");
    expect(config.openClawAgentId).toBe("work");
    expect(config.openClawHome).toBe("/home/user/.openclaw-test");
    expect(config.openClawStateDir).toBe("/tmp/openclaw-state");
    expect(config.openClawDefaultModel).toBe("openai/gpt-5.5");
    expect(config.openClawDefaultThinking).toBe("xhigh");
    expect(config.openClawDefaultLaunchProfileId).toBe("local");
  });

  it("parses Claude Code agent settings", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.NORDRELAY_CODEX_ENABLED = "false";
    process.env.NORDRELAY_CLAUDE_CODE_ENABLED = "true";
    process.env.NORDRELAY_DEFAULT_AGENT = "claude-code";
    process.env.CLAUDE_CODE_CLI_PATH = "/usr/local/bin/claude";
    process.env.CLAUDE_CONFIG_DIR = "/tmp/claude-config";
    process.env.CLAUDE_CODE_DEFAULT_MODEL = "sonnet";
    process.env.CLAUDE_CODE_DEFAULT_EFFORT = "xhigh";
    process.env.CLAUDE_CODE_DEFAULT_PROFILE = "plan";
    process.env.CLAUDE_CODE_MAX_TURNS = "12";

    const config = loadConfig();

    expect(config.codexEnabled).toBe(false);
    expect(config.claudeCodeEnabled).toBe(true);
    expect(config.defaultAgent).toBe("claude-code");
    expect(config.claudeCodeCliPath).toBe("/usr/local/bin/claude");
    expect(config.claudeCodeConfigDir).toBe("/tmp/claude-config");
    expect(config.claudeCodeDefaultModel).toBe("sonnet");
    expect(config.claudeCodeDefaultEffort).toBe("xhigh");
    expect(config.claudeCodeDefaultLaunchProfileId).toBe("plan");
    expect(config.claudeCodeMaxTurns).toBe(12);
  });

  it("rejects a default agent that is not enabled", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.NORDRELAY_CODEX_ENABLED = "false";
    process.env.NORDRELAY_DEFAULT_AGENT = "codex";

    expect(() => loadConfig()).toThrow("At least one agent must be enabled");

    process.env.NORDRELAY_PI_ENABLED = "true";
    expect(() => loadConfig()).toThrow("NORDRELAY_DEFAULT_AGENT=codex requires NORDRELAY_CODEX_ENABLED=true");

    process.env.NORDRELAY_DEFAULT_AGENT = "hermes";
    expect(() => loadConfig()).toThrow("NORDRELAY_DEFAULT_AGENT=hermes requires NORDRELAY_HERMES_ENABLED=true");

    process.env.NORDRELAY_DEFAULT_AGENT = "openclaw";
    expect(() => loadConfig()).toThrow("NORDRELAY_DEFAULT_AGENT=openclaw requires NORDRELAY_OPENCLAW_ENABLED=true");

    process.env.NORDRELAY_DEFAULT_AGENT = "claude-code";
    expect(() => loadConfig()).toThrow("NORDRELAY_DEFAULT_AGENT=claude-code requires NORDRELAY_CLAUDE_CODE_ENABLED=true");
  });

  it("parses CONNECTOR_LOG_FORMAT", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";
    process.env.CONNECTOR_LOG_FORMAT = "json";

    const config = loadConfig();

    expect(config.logFormat).toBe("json");
  });

  it("parses ENABLE_TELEGRAM_LOGIN boolean values", () => {
    process.env.TELEGRAM_BOT_TOKEN = "bot-token";

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
