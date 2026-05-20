import { existsSync, readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createBuiltinLaunchProfiles,
  createDefaultLaunchProfile,
  findLaunchProfile,
  isCodexApprovalPolicy,
  isCodexSandboxMode,
  parseLaunchProfilesJson,
  type CodexApprovalPolicy,
  type CodexLaunchProfile,
  type CodexSandboxMode,
} from "../agents/codex/codex-launch.js";
import {
  CLAUDE_CODE_EFFORT_LEVELS,
  HERMES_REASONING_EFFORTS,
  OPENCLAW_THINKING_LEVELS,
  isAgentId,
  PI_THINKING_LEVELS,
  type AgentId,
  type AgentReasoningEffort,
} from "../agents/shared/agent.js";
import {
  parseMirrorMode,
  parseNotifyMode,
  parseQuietHours,
  parseVoiceBackendPreference,
  type ChannelMirrorMode,
  type ChannelNotifyMode,
  type QuietHours,
  type TelegramMirrorMode,
  type TelegramNotifyMode,
  type VoiceBackendPreference,
} from "../state/bot-preferences.js";
import type { ConnectorLogFormat } from "./logger.js";
import { checkStateBackendAvailability, type StateBackendKind } from "../state/state-backend.js";
import {
  artifactDeliveryModeFromAutoSend,
  parseArtifactDeliveryMode,
  type ArtifactDeliveryMode,
} from "../artifacts/artifact-delivery.js";
import { SESSION_WORKSPACE_MODES, type SessionWorkspaceMode } from "../worktrees/worktree-types.js";
import { SessionWorktreeService } from "../worktrees/worktree-service.js";

export type ToolVerbosity = "all" | "summary" | "errors-only" | "none";
export type ArtifactSafeFilePolicy = "off" | "warn" | "block";

export interface ConnectorConfig {
  adapterWarnings?: string[];
  webuiEnabled: boolean;
  autostartEnabled: boolean;
  webuiAutostartEnabled: boolean;
  telegramEnabled: boolean;
  telegramBotToken: string;
  telegramRateLimitMinIntervalMs: number;
  telegramEditMinIntervalMs: number;
  mirrorMode: ChannelMirrorMode;
  mirrorMinUpdateMs: number;
  webMirrorMode: ChannelMirrorMode;
  webMirrorMinUpdateMs: number;
  notifyMode: ChannelNotifyMode;
  quietHours: QuietHours | null;
  autoSendArtifacts: boolean;
  artifactDeliveryMode: ArtifactDeliveryMode;
  telegramMirrorMode: TelegramMirrorMode;
  telegramMirrorMinUpdateMs: number;
  telegramNotifyMode: TelegramNotifyMode;
  telegramQuietHours: QuietHours | null;
  telegramRedactPatterns: string[];
  telegramTransport: "polling" | "webhook";
  telegramWebhookUrl?: string;
  telegramWebhookHost: string;
  telegramWebhookPort: number;
  telegramWebhookPath: string;
  telegramWebhookSecret?: string;
  discordEnabled: boolean;
  discordBotToken?: string;
  discordClientId?: string;
  discordGuildIds: string[];
  discordAllowedGuildIds: string[];
  discordAllowedChannelIds: string[];
  discordMessageContentEnabled: boolean;
  discordCommandMode: "slash" | "message" | "both";
  discordAutoRegisterCommands: boolean;
  discordMirrorMode: ChannelMirrorMode;
  discordMirrorMinUpdateMs: number;
  discordNotifyMode: ChannelNotifyMode;
  discordQuietHours: QuietHours | null;
  discordAutoSendArtifacts: boolean;
  discordArtifactDeliveryMode: ArtifactDeliveryMode;
  slackEnabled: boolean;
  slackBotToken?: string;
  slackAppToken?: string;
  slackSigningSecret?: string;
  slackSocketMode: boolean;
  slackPort: number;
  slackAllowedTeamIds: string[];
  slackAllowedChannelIds: string[];
  slackMessageContentEnabled: boolean;
  slackCommand: string;
  slackMirrorMode: ChannelMirrorMode;
  slackMirrorMinUpdateMs: number;
  slackNotifyMode: ChannelNotifyMode;
  slackQuietHours: QuietHours | null;
  slackAutoSendArtifacts: boolean;
  slackArtifactDeliveryMode: ArtifactDeliveryMode;
  matrixEnabled: boolean;
  matrixHomeserverUrl?: string;
  matrixAccessToken?: string;
  matrixUserId?: string;
  matrixDeviceId?: string;
  matrixAutojoinInvites: boolean;
  matrixAllowedRoomIds: string[];
  matrixMessageContentEnabled: boolean;
  matrixCommandPrefix: string;
  matrixSyncTimeoutMs: number;
  matrixPollTimeoutMs: number;
  matrixMirrorMode: ChannelMirrorMode;
  matrixMirrorMinUpdateMs: number;
  matrixNotifyMode: ChannelNotifyMode;
  matrixQuietHours: QuietHours | null;
  matrixAutoSendArtifacts: boolean;
  matrixArtifactDeliveryMode: ArtifactDeliveryMode;
  workspace: string;
  workspaceAllowedRoots: string[];
  workspaceWarnRoots: string[];
  sessionWorkspaceMode: SessionWorkspaceMode;
  sessionWorktreeRoot: string;
  sessionWorktreeBranchPrefix: string;
  stateBackend: StateBackendKind;
  maxFileSize: number;
  artifactRetentionDays: number;
  artifactMaxTurnDirs: number;
  artifactMaxInboxDirs: number;
  artifactIgnoreDirs: string[];
  artifactIgnoreGlobs: string[];
  telegramAutoSendArtifacts: boolean;
  telegramArtifactDeliveryMode: ArtifactDeliveryMode;
  artifactMaxTotalBytes: number;
  artifactWarnPercent: number;
  artifactSafeFilePolicy: ArtifactSafeFilePolicy;
  codexEnabled: boolean;
  codexApiKey?: string;
  codexModel?: string;
  codexSyncIntervalMs: number;
  codexExternalBusyCheckMs: number;
  codexExternalBusyStaleMs: number;
  codexSandboxMode: CodexSandboxMode;
  codexApprovalPolicy: CodexApprovalPolicy;
  launchProfiles: CodexLaunchProfile[];
  defaultLaunchProfileId: string;
  enableUnsafeLaunchProfiles: boolean;
  piEnabled: boolean;
  piCliPath?: string;
  piSessionDir?: string;
  piDefaultModel?: string;
  piDefaultThinking: AgentReasoningEffort;
  piDefaultLaunchProfileId: string;
  hermesEnabled: boolean;
  hermesCliPath?: string;
  hermesHome?: string;
  hermesStateDbPath?: string;
  hermesApiBaseUrl: string;
  hermesApiKey?: string;
  hermesDefaultModel?: string;
  hermesDefaultReasoning?: AgentReasoningEffort;
  hermesDefaultLaunchProfileId: string;
  openClawEnabled: boolean;
  openClawCliPath?: string;
  openClawGatewayUrl: string;
  openClawGatewayToken?: string;
  openClawGatewayPassword?: string;
  openClawAgentId: string;
  openClawHome?: string;
  openClawStateDir?: string;
  openClawDefaultModel?: string;
  openClawDefaultThinking?: AgentReasoningEffort;
  openClawDefaultLaunchProfileId: string;
  claudeCodeEnabled: boolean;
  claudeCodeCliPath?: string;
  claudeCodeConfigDir?: string;
  claudeCodeDefaultModel?: string;
  claudeCodeDefaultEffort?: AgentReasoningEffort;
  claudeCodeDefaultLaunchProfileId: string;
  claudeCodeMaxTurns: number;
  defaultAgent: AgentId;
  toolVerbosity: ToolVerbosity;
  logFormat: ConnectorLogFormat;
  showTurnTokenUsage: boolean;
  enableTelegramLogin: boolean;
  enableTelegramReactions: boolean;
  voicePreferredBackend: VoiceBackendPreference;
  voiceDefaultLanguage?: string;
  voiceTranscribeOnly: boolean;
  auditMaxEvents: number;
  sessionLockTtlMs: number;
  dashboardCacheTtlMs: number;
  activeDiscoveryCacheTtlMs: number;
  openClawActiveDiscoveryCacheTtlMs: number;
  unifiedJobMaxItems: number;
  peerEnabled: boolean;
  peerName?: string;
  peerHost: string;
  peerPort: number;
  peerPublicUrl?: string;
  peerTlsEnabled: boolean;
  peerRequireTls: boolean;
  peerHealthCheckMs: number;
  peerDiscoveryTimeoutMs: number;
  peerOutboundRelayEnabled: boolean;
  peerOutboundRelayPeerIds: string[];
  peerOutboundRelayPollMs: number;
}

export function loadConfig(): ConnectorConfig {
  loadEnvFile(path.resolve(process.cwd(), ".env"));

  const adapterWarnings: string[] = [];
  const webuiEnabled = parseBooleanEnv(optionalString(process.env.NORDRELAY_WEBUI_ENABLED), true);
  const autostartEnabled = parseBooleanEnv(optionalString(process.env.NORDRELAY_AUTOSTART_ENABLED), false);
  const webuiAutostartEnabled = parseBooleanEnv(optionalString(process.env.NORDRELAY_WEBUI_AUTOSTART_ENABLED), false);
  const requestedTelegramEnabled = parseBooleanEnv(optionalString(process.env.TELEGRAM_ENABLED), true);
  const telegramBotToken = optionalString(process.env.TELEGRAM_BOT_TOKEN) ?? "";
  const telegramRateLimitMinIntervalMs = parseNonNegativeIntegerEnv(optionalString(process.env.TELEGRAM_RATE_LIMIT_MIN_INTERVAL_MS), 80, "TELEGRAM_RATE_LIMIT_MIN_INTERVAL_MS");
  const telegramEditMinIntervalMs = parseNonNegativeIntegerEnv(optionalString(process.env.TELEGRAM_EDIT_MIN_INTERVAL_MS), 1_200, "TELEGRAM_EDIT_MIN_INTERVAL_MS");
  const mirrorMode = parseMirrorMode(optionalString(process.env.NORDRELAY_CLI_MIRROR_MODE), "status");
  const mirrorMinUpdateMs = parseNonNegativeIntegerEnv(optionalString(process.env.NORDRELAY_CLI_MIRROR_MIN_UPDATE_MS), 4_000, "NORDRELAY_CLI_MIRROR_MIN_UPDATE_MS");
  const webMirrorMode = parseMirrorMode(optionalString(process.env.NORDRELAY_WEB_CLI_MIRROR_MODE), mirrorMode);
  const webMirrorMinUpdateMs = parseNonNegativeIntegerEnv(optionalString(process.env.NORDRELAY_WEB_CLI_MIRROR_MIN_UPDATE_MS), mirrorMinUpdateMs, "NORDRELAY_WEB_CLI_MIRROR_MIN_UPDATE_MS");
  const notifyMode = parseNotifyMode(optionalString(process.env.NORDRELAY_NOTIFY_MODE), "minimal");
  const quietHours = parseQuietHoursOverride(process.env.NORDRELAY_QUIET_HOURS, null);
  const autoSendArtifacts = parseBooleanEnv(optionalString(process.env.NORDRELAY_AUTO_SEND_ARTIFACTS), false);
  const artifactDeliveryMode = parseArtifactDeliveryMode(
    optionalString(process.env.NORDRELAY_ARTIFACT_DELIVERY),
    artifactDeliveryModeFromAutoSend(autoSendArtifacts),
  );
  const telegramMirrorMode = parseMirrorMode(optionalString(process.env.TELEGRAM_CLI_MIRROR_MODE), mirrorMode);
  const telegramMirrorMinUpdateMs = parseNonNegativeIntegerEnv(optionalString(process.env.TELEGRAM_CLI_MIRROR_MIN_UPDATE_MS), mirrorMinUpdateMs, "TELEGRAM_CLI_MIRROR_MIN_UPDATE_MS");
  const telegramNotifyMode = parseNotifyMode(optionalString(process.env.TELEGRAM_NOTIFY_MODE), notifyMode);
  const telegramQuietHours = parseQuietHoursOverride(process.env.TELEGRAM_QUIET_HOURS, quietHours);
  const telegramRedactPatterns = parseOptionalStringList(optionalString(process.env.TELEGRAM_REDACT_PATTERNS));
  const telegramTransport = parseTelegramTransport(optionalString(process.env.TELEGRAM_TRANSPORT));
  const telegramWebhookUrl = optionalString(process.env.TELEGRAM_WEBHOOK_URL);
  const telegramWebhookHost = optionalString(process.env.TELEGRAM_WEBHOOK_HOST) ?? "127.0.0.1";
  const telegramWebhookPort = parsePositiveIntegerEnv(optionalString(process.env.TELEGRAM_WEBHOOK_PORT), 8080, "TELEGRAM_WEBHOOK_PORT");
  const telegramWebhookPath = parseWebhookPath(optionalString(process.env.TELEGRAM_WEBHOOK_PATH));
  const telegramWebhookSecret = optionalString(process.env.TELEGRAM_WEBHOOK_SECRET);
  const requestedDiscordEnabled = parseBooleanEnv(optionalString(process.env.DISCORD_ENABLED), false);
  const discordBotToken = optionalString(process.env.DISCORD_BOT_TOKEN);
  const discordClientId = optionalString(process.env.DISCORD_CLIENT_ID);
  const discordGuildIds = parseOptionalStringList(optionalString(process.env.DISCORD_GUILD_IDS));
  const discordAllowedGuildIds = parseOptionalStringList(optionalString(process.env.DISCORD_ALLOWED_GUILD_IDS));
  const discordAllowedChannelIds = parseOptionalStringList(optionalString(process.env.DISCORD_ALLOWED_CHANNEL_IDS));
  const discordMessageContentEnabled = parseBooleanEnv(optionalString(process.env.DISCORD_MESSAGE_CONTENT_ENABLED), true);
  const discordCommandMode = parseDiscordCommandMode(optionalString(process.env.DISCORD_COMMAND_MODE));
  const discordAutoRegisterCommands = parseBooleanEnv(optionalString(process.env.DISCORD_AUTO_REGISTER_COMMANDS), true);
  const discordMirrorMode = parseMirrorMode(optionalString(process.env.DISCORD_CLI_MIRROR_MODE), mirrorMode);
  const discordMirrorMinUpdateMs = parseNonNegativeIntegerEnv(optionalString(process.env.DISCORD_CLI_MIRROR_MIN_UPDATE_MS), mirrorMinUpdateMs, "DISCORD_CLI_MIRROR_MIN_UPDATE_MS");
  const discordNotifyMode = parseNotifyMode(optionalString(process.env.DISCORD_NOTIFY_MODE), notifyMode);
  const discordQuietHours = parseQuietHoursOverride(process.env.DISCORD_QUIET_HOURS, quietHours);
  const requestedSlackEnabled = parseBooleanEnv(optionalString(process.env.SLACK_ENABLED), false);
  const slackBotToken = optionalString(process.env.SLACK_BOT_TOKEN);
  const slackAppToken = optionalString(process.env.SLACK_APP_TOKEN);
  const slackSigningSecret = optionalString(process.env.SLACK_SIGNING_SECRET);
  const slackSocketMode = parseBooleanEnv(optionalString(process.env.SLACK_SOCKET_MODE), true);
  const slackPort = parsePositiveIntegerEnv(optionalString(process.env.SLACK_PORT), 3000, "SLACK_PORT");
  const slackAllowedTeamIds = parseOptionalStringList(optionalString(process.env.SLACK_ALLOWED_TEAM_IDS));
  const slackAllowedChannelIds = parseOptionalStringList(optionalString(process.env.SLACK_ALLOWED_CHANNEL_IDS));
  const slackMessageContentEnabled = parseBooleanEnv(optionalString(process.env.SLACK_MESSAGE_CONTENT_ENABLED), true);
  const slackCommand = parseSlackCommand(optionalString(process.env.SLACK_COMMAND));
  const slackMirrorMode = parseMirrorMode(optionalString(process.env.SLACK_CLI_MIRROR_MODE), mirrorMode);
  const slackMirrorMinUpdateMs = parseNonNegativeIntegerEnv(optionalString(process.env.SLACK_CLI_MIRROR_MIN_UPDATE_MS), mirrorMinUpdateMs, "SLACK_CLI_MIRROR_MIN_UPDATE_MS");
  const slackNotifyMode = parseNotifyMode(optionalString(process.env.SLACK_NOTIFY_MODE), notifyMode);
  const slackQuietHours = parseQuietHoursOverride(process.env.SLACK_QUIET_HOURS, quietHours);
  const requestedMatrixEnabled = parseBooleanEnv(optionalString(process.env.MATRIX_ENABLED), false);
  const matrixHomeserverUrl = normalizeBaseUrl(optionalString(process.env.MATRIX_HOMESERVER_URL));
  const matrixAccessToken = optionalString(process.env.MATRIX_ACCESS_TOKEN);
  const matrixUserId = optionalString(process.env.MATRIX_USER_ID);
  const matrixDeviceId = optionalString(process.env.MATRIX_DEVICE_ID);
  const matrixAutojoinInvites = parseBooleanEnv(optionalString(process.env.MATRIX_AUTOJOIN_INVITES), true);
  const matrixAllowedRoomIds = parseOptionalStringList(optionalString(process.env.MATRIX_ALLOWED_ROOM_IDS));
  const matrixMessageContentEnabled = parseBooleanEnv(optionalString(process.env.MATRIX_MESSAGE_CONTENT_ENABLED), true);
  const matrixCommandPrefix = parseMatrixCommandPrefix(optionalString(process.env.MATRIX_COMMAND_PREFIX));
  const matrixSyncTimeoutMs = parsePositiveIntegerEnv(optionalString(process.env.MATRIX_SYNC_TIMEOUT_MS), 30_000, "MATRIX_SYNC_TIMEOUT_MS");
  const matrixPollTimeoutMs = parsePositiveIntegerEnv(optionalString(process.env.MATRIX_POLL_TIMEOUT_MS), 35_000, "MATRIX_POLL_TIMEOUT_MS");
  const matrixMirrorMode = parseMirrorMode(optionalString(process.env.MATRIX_CLI_MIRROR_MODE), mirrorMode);
  const matrixMirrorMinUpdateMs = parseNonNegativeIntegerEnv(optionalString(process.env.MATRIX_CLI_MIRROR_MIN_UPDATE_MS), mirrorMinUpdateMs, "MATRIX_CLI_MIRROR_MIN_UPDATE_MS");
  const matrixNotifyMode = parseNotifyMode(optionalString(process.env.MATRIX_NOTIFY_MODE), notifyMode);
  const matrixQuietHours = parseQuietHoursOverride(process.env.MATRIX_QUIET_HOURS, quietHours);
  const workspace = resolveWorkspace();
  const workspaceAllowedRoots = parsePathList(optionalString(process.env.WORKSPACE_ALLOWED_ROOTS));
  const workspaceWarnRoots = parsePathList(optionalString(process.env.WORKSPACE_WARN_ROOTS));
  const sessionWorkspaceMode = parseSessionWorkspaceMode(optionalString(process.env.NORDRELAY_SESSION_WORKSPACE_MODE));
  const sessionWorktreeRoot = path.resolve(optionalString(process.env.NORDRELAY_SESSION_WORKTREE_ROOT) ?? SessionWorktreeService.defaultRoot());
  const sessionWorktreeBranchPrefix = parseBranchPrefix(optionalString(process.env.NORDRELAY_SESSION_WORKTREE_BRANCH_PREFIX));
  const stateBackend = parseStateBackend(optionalString(process.env.NORDRELAY_STATE_BACKEND));
  const stateBackendAvailability = checkStateBackendAvailability(workspace, stateBackend);
  if (!stateBackendAvailability.ok) {
    adapterWarnings.push(stateBackendAvailability.detail);
  }
  const maxFileSize = parseMaxFileSize(optionalString(process.env.MAX_FILE_SIZE));
  const artifactRetentionDays = parsePositiveNumberEnv(optionalString(process.env.ARTIFACT_RETENTION_DAYS), 7, "ARTIFACT_RETENTION_DAYS");
  const artifactMaxTurnDirs = parsePositiveIntegerEnv(optionalString(process.env.ARTIFACT_MAX_TURNS), 30, "ARTIFACT_MAX_TURNS");
  const artifactMaxInboxDirs = parsePositiveIntegerEnv(optionalString(process.env.ARTIFACT_MAX_INBOX_DIRS), 30, "ARTIFACT_MAX_INBOX_DIRS");
  const artifactIgnoreDirs = parseOptionalStringList(optionalString(process.env.ARTIFACT_IGNORE_DIRS));
  const artifactIgnoreGlobs = parseOptionalStringList(optionalString(process.env.ARTIFACT_IGNORE_GLOBS));
  const artifactMaxTotalBytes = parseNonNegativeIntegerEnv(optionalString(process.env.ARTIFACT_MAX_TOTAL_BYTES), 0, "ARTIFACT_MAX_TOTAL_BYTES");
  const artifactWarnPercent = parsePercentEnv(optionalString(process.env.ARTIFACT_WARN_PERCENT), 80, "ARTIFACT_WARN_PERCENT");
  const artifactSafeFilePolicy = parseArtifactSafeFilePolicy(optionalString(process.env.ARTIFACT_SAFE_FILE_POLICY));
  const telegramAutoSendArtifacts = parseBooleanEnv(optionalString(process.env.TELEGRAM_AUTO_SEND_ARTIFACTS), autoSendArtifacts);
  const discordAutoSendArtifacts = parseBooleanEnv(optionalString(process.env.DISCORD_AUTO_SEND_ARTIFACTS), autoSendArtifacts);
  const slackAutoSendArtifacts = parseBooleanEnv(optionalString(process.env.SLACK_AUTO_SEND_ARTIFACTS), autoSendArtifacts);
  const matrixAutoSendArtifacts = parseBooleanEnv(optionalString(process.env.MATRIX_AUTO_SEND_ARTIFACTS), autoSendArtifacts);
  const telegramArtifactDeliveryMode = parseArtifactDeliveryMode(
    optionalString(process.env.TELEGRAM_ARTIFACT_DELIVERY),
    optionalString(process.env.TELEGRAM_AUTO_SEND_ARTIFACTS) === undefined ? artifactDeliveryMode : artifactDeliveryModeFromAutoSend(telegramAutoSendArtifacts),
  );
  const discordArtifactDeliveryMode = parseArtifactDeliveryMode(
    optionalString(process.env.DISCORD_ARTIFACT_DELIVERY),
    optionalString(process.env.DISCORD_AUTO_SEND_ARTIFACTS) === undefined ? artifactDeliveryMode : artifactDeliveryModeFromAutoSend(discordAutoSendArtifacts),
  );
  const slackArtifactDeliveryMode = parseArtifactDeliveryMode(
    optionalString(process.env.SLACK_ARTIFACT_DELIVERY),
    optionalString(process.env.SLACK_AUTO_SEND_ARTIFACTS) === undefined ? artifactDeliveryMode : artifactDeliveryModeFromAutoSend(slackAutoSendArtifacts),
  );
  const matrixArtifactDeliveryMode = parseArtifactDeliveryMode(
    optionalString(process.env.MATRIX_ARTIFACT_DELIVERY),
    optionalString(process.env.MATRIX_AUTO_SEND_ARTIFACTS) === undefined ? artifactDeliveryMode : artifactDeliveryModeFromAutoSend(matrixAutoSendArtifacts),
  );
  const codexEnabled = parseBooleanEnv(optionalString(process.env.NORDRELAY_CODEX_ENABLED), true);
  const codexApiKey = optionalString(process.env.CODEX_API_KEY);
  const codexModel = optionalString(process.env.CODEX_MODEL);
  const codexSyncIntervalMs = parseNonNegativeIntegerEnv(optionalString(process.env.CODEX_SYNC_INTERVAL_MS), 10_000, "CODEX_SYNC_INTERVAL_MS");
  const codexExternalBusyCheckMs = parsePositiveIntegerEnv(
    optionalString(process.env.CODEX_EXTERNAL_BUSY_CHECK_MS),
    5_000,
    "CODEX_EXTERNAL_BUSY_CHECK_MS",
  );
  const codexExternalBusyStaleMs = parsePositiveIntegerEnv(
    optionalString(process.env.CODEX_EXTERNAL_BUSY_STALE_MS),
    5 * 60 * 1000,
    "CODEX_EXTERNAL_BUSY_STALE_MS",
  );
  const codexSandboxMode = parseSandboxMode(optionalString(process.env.CODEX_SANDBOX_MODE));
  const codexApprovalPolicy = parseApprovalPolicy(optionalString(process.env.CODEX_APPROVAL_POLICY));
  const enableUnsafeLaunchProfiles = parseBooleanEnv(
    optionalString(process.env.ENABLE_UNSAFE_LAUNCH_PROFILES),
    false,
  );
  const launchProfiles = parseLaunchProfiles(
    optionalString(process.env.CODEX_LAUNCH_PROFILES_JSON),
    codexSandboxMode,
    codexApprovalPolicy,
    enableUnsafeLaunchProfiles,
  );
  const defaultLaunchProfileId = parseDefaultLaunchProfileId(
    optionalString(process.env.CODEX_DEFAULT_LAUNCH_PROFILE),
    launchProfiles,
  );
  const piEnabled = parseBooleanEnv(optionalString(process.env.NORDRELAY_PI_ENABLED), false);
  const piCliPath = optionalString(process.env.PI_CLI_PATH);
  const piSessionDir = optionalString(process.env.PI_SESSION_DIR);
  const piDefaultModel = optionalString(process.env.PI_DEFAULT_MODEL);
  const piDefaultThinking = parsePiThinkingLevel(optionalString(process.env.PI_DEFAULT_THINKING));
  const piDefaultLaunchProfileId = optionalString(process.env.PI_DEFAULT_PROFILE) ?? "default";
  const hermesEnabled = parseBooleanEnv(optionalString(process.env.NORDRELAY_HERMES_ENABLED), false);
  const hermesCliPath = optionalString(process.env.HERMES_CLI_PATH);
  const hermesHome = optionalString(process.env.HERMES_HOME);
  const hermesStateDbPath = optionalString(process.env.HERMES_STATE_DB_PATH);
  const hermesApiBaseUrl = optionalString(process.env.HERMES_API_BASE_URL) ?? "http://127.0.0.1:8642";
  const hermesApiKey = optionalString(process.env.HERMES_API_KEY);
  const hermesDefaultModel = optionalString(process.env.HERMES_DEFAULT_MODEL);
  const hermesDefaultReasoning = parseHermesReasoningEffort(optionalString(process.env.HERMES_DEFAULT_REASONING));
  const hermesDefaultLaunchProfileId = optionalString(process.env.HERMES_DEFAULT_PROFILE) ?? "default";
  const openClawEnabled = parseBooleanEnv(optionalString(process.env.NORDRELAY_OPENCLAW_ENABLED), false);
  const openClawCliPath = optionalString(process.env.OPENCLAW_CLI_PATH);
  const openClawGatewayUrl = optionalString(process.env.OPENCLAW_GATEWAY_URL) ?? "ws://127.0.0.1:18789";
  const openClawGatewayToken = optionalString(process.env.OPENCLAW_GATEWAY_TOKEN);
  const openClawGatewayPassword = optionalString(process.env.OPENCLAW_GATEWAY_PASSWORD);
  const openClawAgentId = optionalString(process.env.OPENCLAW_AGENT_ID) ?? "main";
  const openClawHome = optionalString(process.env.OPENCLAW_HOME);
  const openClawStateDir = optionalString(process.env.OPENCLAW_STATE_DIR);
  const openClawDefaultModel = optionalString(process.env.OPENCLAW_DEFAULT_MODEL);
  const openClawDefaultThinking = parseOpenClawThinkingLevel(optionalString(process.env.OPENCLAW_DEFAULT_THINKING));
  const openClawDefaultLaunchProfileId = optionalString(process.env.OPENCLAW_DEFAULT_PROFILE) ?? "default";
  const claudeCodeEnabled = parseBooleanEnv(optionalString(process.env.NORDRELAY_CLAUDE_CODE_ENABLED), false);
  ensureAtLeastOneAgentEnabled(codexEnabled, piEnabled, hermesEnabled, openClawEnabled, claudeCodeEnabled);
  const claudeCodeCliPath = optionalString(process.env.CLAUDE_CODE_CLI_PATH);
  const claudeCodeConfigDir = optionalString(process.env.CLAUDE_CONFIG_DIR);
  const claudeCodeDefaultModel = optionalString(process.env.CLAUDE_CODE_DEFAULT_MODEL);
  const claudeCodeDefaultEffort = parseClaudeCodeEffort(optionalString(process.env.CLAUDE_CODE_DEFAULT_EFFORT));
  const claudeCodeDefaultLaunchProfileId = optionalString(process.env.CLAUDE_CODE_DEFAULT_PROFILE) ?? "default";
  const claudeCodeMaxTurns = parsePositiveIntegerEnv(optionalString(process.env.CLAUDE_CODE_MAX_TURNS), 100, "CLAUDE_CODE_MAX_TURNS");
  const defaultAgent = parseDefaultAgent(
    optionalString(process.env.NORDRELAY_DEFAULT_AGENT),
    codexEnabled,
    piEnabled,
    hermesEnabled,
    openClawEnabled,
    claudeCodeEnabled,
  );
  const toolVerbosity = parseToolVerbosity(optionalString(process.env.TOOL_VERBOSITY));
  const logFormat = parseLogFormat(optionalString(process.env.CONNECTOR_LOG_FORMAT));
  const showTurnTokenUsage = parseBooleanEnv(optionalString(process.env.SHOW_TURN_TOKEN_USAGE), false);
  const enableTelegramLogin = parseBooleanEnv(optionalString(process.env.ENABLE_TELEGRAM_LOGIN), true);
  const enableTelegramReactions = parseBooleanEnv(
    optionalString(process.env.ENABLE_TELEGRAM_REACTIONS),
    false,
  );
  const voicePreferredBackend = parseVoiceBackendPreference(optionalString(process.env.VOICE_PREFERRED_BACKEND));
  const voiceDefaultLanguage = parseVoiceDefaultLanguage(optionalString(process.env.VOICE_DEFAULT_LANGUAGE));
  const voiceTranscribeOnly = parseBooleanEnv(optionalString(process.env.VOICE_TRANSCRIBE_ONLY), false);
  const auditMaxEvents = parsePositiveIntegerEnv(optionalString(process.env.NORDRELAY_AUDIT_MAX_EVENTS), 1000, "NORDRELAY_AUDIT_MAX_EVENTS");
  const sessionLockTtlMs = parseNonNegativeIntegerEnv(optionalString(process.env.NORDRELAY_SESSION_LOCK_TTL_MS), 30 * 60 * 1000, "NORDRELAY_SESSION_LOCK_TTL_MS");
  const dashboardCacheTtlMs = parseNonNegativeIntegerEnv(optionalString(process.env.NORDRELAY_DASHBOARD_CACHE_TTL_MS), 10_000, "NORDRELAY_DASHBOARD_CACHE_TTL_MS");
  const activeDiscoveryCacheTtlMs = parseNonNegativeIntegerEnv(optionalString(process.env.NORDRELAY_ACTIVE_DISCOVERY_CACHE_TTL_MS), 5_000, "NORDRELAY_ACTIVE_DISCOVERY_CACHE_TTL_MS");
  const openClawActiveDiscoveryCacheTtlMs = parseNonNegativeIntegerEnv(optionalString(process.env.NORDRELAY_OPENCLAW_ACTIVE_DISCOVERY_CACHE_TTL_MS), 30_000, "NORDRELAY_OPENCLAW_ACTIVE_DISCOVERY_CACHE_TTL_MS");
  const unifiedJobMaxItems = parsePositiveIntegerEnv(optionalString(process.env.NORDRELAY_UNIFIED_JOB_MAX_ITEMS), 1000, "NORDRELAY_UNIFIED_JOB_MAX_ITEMS");
  const peerEnabled = parseBooleanEnv(optionalString(process.env.NORDRELAY_PEER_ENABLED), false);
  const peerName = optionalString(process.env.NORDRELAY_PEER_NAME);
  const peerHost = optionalString(process.env.NORDRELAY_PEER_HOST) ?? "127.0.0.1";
  const peerPort = parsePositiveIntegerEnv(optionalString(process.env.NORDRELAY_PEER_PORT), 31979, "NORDRELAY_PEER_PORT");
  const peerPublicUrl = optionalString(process.env.NORDRELAY_PEER_PUBLIC_URL);
  const peerTlsEnabled = parseBooleanEnv(optionalString(process.env.NORDRELAY_PEER_TLS_ENABLED), true);
  const peerRequireTls = parseBooleanEnv(optionalString(process.env.NORDRELAY_PEER_REQUIRE_TLS), true);
  const peerHealthCheckMs = parseNonNegativeIntegerEnv(optionalString(process.env.NORDRELAY_PEER_HEALTH_CHECK_MS), 60_000, "NORDRELAY_PEER_HEALTH_CHECK_MS");
  const peerDiscoveryTimeoutMs = parsePositiveIntegerEnv(optionalString(process.env.NORDRELAY_PEER_DISCOVERY_TIMEOUT_MS), 650, "NORDRELAY_PEER_DISCOVERY_TIMEOUT_MS");
  const peerOutboundRelayEnabled = parseBooleanEnv(optionalString(process.env.NORDRELAY_PEER_OUTBOUND_RELAY_ENABLED), false);
  const peerOutboundRelayPeerIds = parseOptionalStringList(optionalString(process.env.NORDRELAY_PEER_OUTBOUND_RELAY_PEERS));
  const peerOutboundRelayPollMs = parsePositiveIntegerEnv(optionalString(process.env.NORDRELAY_PEER_OUTBOUND_RELAY_POLL_MS), 1_000, "NORDRELAY_PEER_OUTBOUND_RELAY_POLL_MS");

  let telegramEnabled = requestedTelegramEnabled;
  if (telegramEnabled && telegramTransport === "webhook" && !telegramWebhookUrl) {
    telegramEnabled = false;
    adapterWarnings.push("Telegram disabled: TELEGRAM_TRANSPORT=webhook requires TELEGRAM_WEBHOOK_URL.");
  }
  if (telegramEnabled && !telegramBotToken) {
    telegramEnabled = false;
    adapterWarnings.push("Telegram disabled: TELEGRAM_BOT_TOKEN is missing.");
  }
  let discordEnabled = requestedDiscordEnabled;
  if (discordEnabled && !discordBotToken) {
    discordEnabled = false;
    adapterWarnings.push("Discord disabled: DISCORD_ENABLED=true requires DISCORD_BOT_TOKEN.");
  }
  let slackEnabled = requestedSlackEnabled;
  if (slackEnabled && !slackBotToken) {
    slackEnabled = false;
    adapterWarnings.push("Slack disabled: SLACK_ENABLED=true requires SLACK_BOT_TOKEN.");
  }
  if (slackEnabled && slackSocketMode && !slackAppToken) {
    slackEnabled = false;
    adapterWarnings.push("Slack disabled: SLACK_SOCKET_MODE=true requires SLACK_APP_TOKEN.");
  }
  if (slackEnabled && !slackSocketMode && !slackSigningSecret) {
    slackEnabled = false;
    adapterWarnings.push("Slack disabled: SLACK_SOCKET_MODE=false requires SLACK_SIGNING_SECRET.");
  }
  let matrixEnabled = requestedMatrixEnabled;
  if (matrixEnabled && !matrixHomeserverUrl) {
    matrixEnabled = false;
    adapterWarnings.push("Matrix disabled: MATRIX_ENABLED=true requires MATRIX_HOMESERVER_URL.");
  }
  if (matrixEnabled && !matrixAccessToken) {
    matrixEnabled = false;
    adapterWarnings.push("Matrix disabled: MATRIX_ENABLED=true requires MATRIX_ACCESS_TOKEN.");
  }
  if (matrixEnabled && !matrixUserId) {
    matrixEnabled = false;
    adapterWarnings.push("Matrix disabled: MATRIX_ENABLED=true requires MATRIX_USER_ID.");
  }
  if (!webuiEnabled && !telegramEnabled && !discordEnabled && !slackEnabled && !matrixEnabled) {
    const detail = adapterWarnings.length > 0 ? ` ${adapterWarnings.join(" ")}` : "";
    throw new Error(`At least WebUI or one usable chat adapter must be enabled.${detail}`);
  }

  return {
    adapterWarnings,
    webuiEnabled,
    autostartEnabled,
    webuiAutostartEnabled,
    telegramEnabled,
    telegramBotToken,
    telegramRateLimitMinIntervalMs,
    telegramEditMinIntervalMs,
    mirrorMode,
    mirrorMinUpdateMs,
    webMirrorMode,
    webMirrorMinUpdateMs,
    notifyMode,
    quietHours,
    autoSendArtifacts,
    artifactDeliveryMode,
    telegramMirrorMode,
    telegramMirrorMinUpdateMs,
    telegramNotifyMode,
    telegramQuietHours,
    telegramRedactPatterns,
    telegramTransport,
    telegramWebhookUrl,
    telegramWebhookHost,
    telegramWebhookPort,
    telegramWebhookPath,
    telegramWebhookSecret,
    discordEnabled,
    discordBotToken,
    discordClientId,
    discordGuildIds,
    discordAllowedGuildIds,
    discordAllowedChannelIds,
    discordMessageContentEnabled,
    discordCommandMode,
    discordAutoRegisterCommands,
    discordMirrorMode,
    discordMirrorMinUpdateMs,
    discordNotifyMode,
    discordQuietHours,
    discordAutoSendArtifacts,
    discordArtifactDeliveryMode,
    slackEnabled,
    slackBotToken,
    slackAppToken,
    slackSigningSecret,
    slackSocketMode,
    slackPort,
    slackAllowedTeamIds,
    slackAllowedChannelIds,
    slackMessageContentEnabled,
    slackCommand,
    slackMirrorMode,
    slackMirrorMinUpdateMs,
    slackNotifyMode,
    slackQuietHours,
    slackAutoSendArtifacts,
    slackArtifactDeliveryMode,
    matrixEnabled,
    matrixHomeserverUrl,
    matrixAccessToken,
    matrixUserId,
    matrixDeviceId,
    matrixAutojoinInvites,
    matrixAllowedRoomIds,
    matrixMessageContentEnabled,
    matrixCommandPrefix,
    matrixSyncTimeoutMs,
    matrixPollTimeoutMs,
    matrixMirrorMode,
    matrixMirrorMinUpdateMs,
    matrixNotifyMode,
    matrixQuietHours,
    matrixAutoSendArtifacts,
    matrixArtifactDeliveryMode,
    workspace,
    workspaceAllowedRoots,
    workspaceWarnRoots,
    sessionWorkspaceMode,
    sessionWorktreeRoot,
    sessionWorktreeBranchPrefix,
    stateBackend,
    maxFileSize,
    artifactRetentionDays,
    artifactMaxTurnDirs,
    artifactMaxInboxDirs,
    artifactIgnoreDirs,
    artifactIgnoreGlobs,
    telegramAutoSendArtifacts,
    telegramArtifactDeliveryMode,
    artifactMaxTotalBytes,
    artifactWarnPercent,
    artifactSafeFilePolicy,
    codexEnabled,
    codexApiKey,
    codexModel,
    codexSyncIntervalMs,
    codexExternalBusyCheckMs,
    codexExternalBusyStaleMs,
    codexSandboxMode,
    codexApprovalPolicy,
    launchProfiles,
    defaultLaunchProfileId,
    enableUnsafeLaunchProfiles,
    piEnabled,
    piCliPath,
    piSessionDir,
    piDefaultModel,
    piDefaultThinking,
    piDefaultLaunchProfileId,
    hermesEnabled,
    hermesCliPath,
    hermesHome,
    hermesStateDbPath,
    hermesApiBaseUrl,
    hermesApiKey,
    hermesDefaultModel,
    hermesDefaultReasoning,
    hermesDefaultLaunchProfileId,
    openClawEnabled,
    openClawCliPath,
    openClawGatewayUrl,
    openClawGatewayToken,
    openClawGatewayPassword,
    openClawAgentId,
    openClawHome,
    openClawStateDir,
    openClawDefaultModel,
    openClawDefaultThinking,
    openClawDefaultLaunchProfileId,
    claudeCodeEnabled,
    claudeCodeCliPath,
    claudeCodeConfigDir,
    claudeCodeDefaultModel,
    claudeCodeDefaultEffort,
    claudeCodeDefaultLaunchProfileId,
    claudeCodeMaxTurns,
    defaultAgent,
    toolVerbosity,
    logFormat,
    showTurnTokenUsage,
    enableTelegramLogin,
    enableTelegramReactions,
    voicePreferredBackend,
    voiceDefaultLanguage,
    voiceTranscribeOnly,
    auditMaxEvents,
    sessionLockTtlMs,
    dashboardCacheTtlMs,
    activeDiscoveryCacheTtlMs,
    openClawActiveDiscoveryCacheTtlMs,
    unifiedJobMaxItems,
    peerEnabled,
    peerName,
    peerHost,
    peerPort,
    peerPublicUrl,
    peerTlsEnabled,
    peerRequireTls,
    peerHealthCheckMs,
    peerDiscoveryTimeoutMs,
    peerOutboundRelayEnabled,
    peerOutboundRelayPeerIds,
    peerOutboundRelayPollMs,
  };
}

function resolveWorkspace(): string {
  const explicitWorkspace = optionalString(process.env.NORDRELAY_WORKSPACE);
  if (explicitWorkspace) {
    return path.resolve(explicitWorkspace);
  }
  if (isRunningInDocker()) {
    return "/workspace";
  }
  if (isRuntimeSourceRoot(process.cwd())) {
    return os.homedir();
  }
  return process.cwd();
}

function isRuntimeSourceRoot(candidate: string): boolean {
  const sourceRoot = optionalString(process.env.NORDRELAY_SOURCE_ROOT);
  return Boolean(sourceRoot && samePath(candidate, sourceRoot));
}

function samePath(left: string, right: string): boolean {
  return canonicalPath(left) === canonicalPath(right);
}

function canonicalPath(filePath: string): string {
  try {
    return realpathSync.native(path.resolve(filePath));
  } catch {
    return path.resolve(filePath);
  }
}

function isRunningInDocker(): boolean {
  return existsSync("/.dockerenv") || process.env.container === "docker";
}

export function loadEnvFile(envPath: string): void {
  if (!existsSync(envPath)) {
    return;
  }

  const contents = readFileSync(envPath, "utf8");
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
    const separatorIndex = normalized.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = normalized.slice(0, separatorIndex).trim();
    let value = normalized.slice(separatorIndex + 1).trim();

    if (!key || process.env[key] !== undefined) {
      continue;
    }

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value.replace(/\\n/g, "\n");
  }
}

function requireEnv(name: string): string {
  const value = optionalString(process.env[name]);
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeBaseUrl(value: string | undefined): string | undefined {
  return value?.replace(/\/+$/, "");
}

function parseVoiceDefaultLanguage(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === "auto" || normalized === "default" || normalized === "detect") {
    return undefined;
  }
  return normalized;
}

function parseQuietHoursOverride(value: string | undefined, fallback: QuietHours | null): QuietHours | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (normalized === "off" || normalized === "none" || normalized === "false" || normalized === "0") {
    return null;
  }
  return parseQuietHours(normalized);
}

function parseOptionalStringList(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function parsePathList(raw: string | undefined): string[] {
  return parseOptionalStringList(raw).map((value) => path.resolve(value));
}

function parseBooleanEnv(raw: string | undefined, defaultValue: boolean): boolean {
  if (!raw) {
    return defaultValue;
  }

  const lower = raw.toLowerCase();
  if (lower === "true" || lower === "1" || lower === "yes") {
    return true;
  }
  if (lower === "false" || lower === "0" || lower === "no") {
    return false;
  }

  console.warn(`Invalid boolean env value: "${raw}". Falling back to ${defaultValue}.`);
  return defaultValue;
}

function parseMaxFileSize(raw: string | undefined): number {
  if (!raw) {
    return 20 * 1024 * 1024;
  }

  const parsed = Number(raw);
  if (Number.isNaN(parsed) || parsed <= 0) {
    console.warn(`Invalid MAX_FILE_SIZE value: "${raw}". Falling back to 20 MB.`);
    return 20 * 1024 * 1024;
  }

  return parsed;
}

function parsePositiveNumberEnv(raw: string | undefined, defaultValue: number, envName: string): number {
  if (!raw) {
    return defaultValue;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(`Invalid ${envName} value: "${raw}". Falling back to ${defaultValue}.`);
    return defaultValue;
  }

  return parsed;
}

function parsePositiveIntegerEnv(raw: string | undefined, defaultValue: number, envName: string): number {
  const parsed = parsePositiveNumberEnv(raw, defaultValue, envName);
  return Math.floor(parsed);
}

function parseNonNegativeIntegerEnv(raw: string | undefined, defaultValue: number, envName: string): number {
  if (!raw) {
    return defaultValue;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.warn(`Invalid ${envName} value: "${raw}". Falling back to ${defaultValue}.`);
    return defaultValue;
  }

  return Math.floor(parsed);
}

function parsePercentEnv(raw: string | undefined, defaultValue: number, envName: string): number {
  if (!raw) {
    return defaultValue;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    console.warn(`Invalid ${envName} value: "${raw}". Falling back to ${defaultValue}.`);
    return defaultValue;
  }
  return parsed;
}

function parseArtifactSafeFilePolicy(raw: string | undefined): ArtifactSafeFilePolicy {
  if (!raw) return "warn";
  if (raw === "off" || raw === "warn" || raw === "block") return raw;
  console.warn(`Invalid ARTIFACT_SAFE_FILE_POLICY value: "${raw}". Expected off, warn, or block. Falling back to "warn".`);
  return "warn";
}

function parseSandboxMode(raw: string | undefined): CodexSandboxMode {
  if (!raw) {
    return "workspace-write";
  }

  if (!isCodexSandboxMode(raw)) {
    console.warn(
      `Invalid CODEX_SANDBOX_MODE value: "${raw}". Expected one of: read-only, workspace-write, danger-full-access. Falling back to "workspace-write".`,
    );
    return "workspace-write";
  }

  return raw;
}

function parseApprovalPolicy(raw: string | undefined): CodexApprovalPolicy {
  if (!raw) {
    return "never";
  }

  if (!isCodexApprovalPolicy(raw)) {
    console.warn(
      `Invalid CODEX_APPROVAL_POLICY value: "${raw}". Expected one of: never, on-request, on-failure, untrusted. Falling back to "never".`,
    );
    return "never";
  }

  return raw;
}

function parseToolVerbosity(raw: string | undefined): ToolVerbosity {
  if (!raw) {
    return "summary";
  }

  switch (raw) {
    case "all":
    case "summary":
    case "errors-only":
    case "none":
      return raw;
    default:
      console.warn(
        `Invalid TOOL_VERBOSITY value: "${raw}". Expected one of: all, summary, errors-only, none. Falling back to "summary".`,
      );
      return "summary";
  }
}

function parseLogFormat(raw: string | undefined): ConnectorLogFormat {
  if (!raw) {
    return "text";
  }

  if (raw === "text" || raw === "json") {
    return raw;
  }

  console.warn(`Invalid CONNECTOR_LOG_FORMAT value: "${raw}". Expected text or json. Falling back to "text".`);
  return "text";
}

function parseTelegramTransport(raw: string | undefined): "polling" | "webhook" {
  if (!raw) {
    return "polling";
  }
  if (raw === "polling" || raw === "webhook") {
    return raw;
  }
  console.warn(`Invalid TELEGRAM_TRANSPORT value: "${raw}". Expected polling or webhook. Falling back to polling.`);
  return "polling";
}

function parseDiscordCommandMode(raw: string | undefined): "slash" | "message" | "both" {
  if (!raw) {
    return "both";
  }
  if (raw === "slash" || raw === "message" || raw === "both") {
    return raw;
  }
  console.warn(`Invalid DISCORD_COMMAND_MODE value: "${raw}". Expected slash, message, or both. Falling back to both.`);
  return "both";
}

function parseSlackCommand(raw: string | undefined): string {
  const normalized = raw?.trim() || "/nordrelay";
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function parseMatrixCommandPrefix(raw: string | undefined): string {
  const normalized = raw?.trim() || "!nr";
  return normalized || "!nr";
}

function parseWebhookPath(raw: string | undefined): string {
  if (!raw) {
    return "/telegram/webhook";
  }
  return raw.startsWith("/") ? raw : `/${raw}`;
}

function parseStateBackend(raw: string | undefined): StateBackendKind {
  if (!raw) {
    return "json";
  }

  if (raw === "json" || raw === "sqlite") {
    return raw;
  }

  console.warn(`Invalid NORDRELAY_STATE_BACKEND value: "${raw}". Expected json or sqlite. Falling back to json.`);
  return "json";
}

function parseSessionWorkspaceMode(raw: string | undefined): SessionWorkspaceMode {
  if (!raw) {
    return "shared";
  }
  const normalized = raw.trim().toLowerCase();
  if (SESSION_WORKSPACE_MODES.includes(normalized as SessionWorkspaceMode)) {
    return normalized as SessionWorkspaceMode;
  }
  console.warn(`Invalid NORDRELAY_SESSION_WORKSPACE_MODE value: "${raw}". Expected shared, worktree, or attached. Falling back to shared.`);
  return "shared";
}

function parseBranchPrefix(raw: string | undefined): string {
  const normalized = (raw?.trim() || "nr/session").replace(/^\/+|\/+$/g, "");
  if (!normalized || normalized.includes("..") || /[\s~^:?*[\\]/.test(normalized)) {
    console.warn(`Invalid NORDRELAY_SESSION_WORKTREE_BRANCH_PREFIX value: "${raw}". Falling back to nr/session.`);
    return "nr/session";
  }
  return normalized;
}

function parseLaunchProfiles(
  raw: string | undefined,
  codexSandboxMode: CodexSandboxMode,
  codexApprovalPolicy: CodexApprovalPolicy,
  enableUnsafeLaunchProfiles: boolean,
): CodexLaunchProfile[] {
  const defaultProfile = createDefaultLaunchProfile(codexSandboxMode, codexApprovalPolicy);
  const profiles = createBuiltinLaunchProfiles(defaultProfile, {
    includeFullAccess: enableUnsafeLaunchProfiles,
  });

  if (!raw) {
    return profiles;
  }

  const parsedProfiles = parseLaunchProfilesJson(raw);
  const profileIndexes = new Map(profiles.map((profile, index) => [profile.id, index]));
  const explicitIds = new Set<string>();

  for (const profile of parsedProfiles) {
    if (profile.id === defaultProfile.id || explicitIds.has(profile.id)) {
      throw new Error(`Duplicate launch profile id: ${profile.id}`);
    }
    if (profile.unsafe && !enableUnsafeLaunchProfiles) {
      throw new Error(
        `Unsafe launch profile "${profile.id}" requires ENABLE_UNSAFE_LAUNCH_PROFILES=true`,
      );
    }

    const existingIndex = profileIndexes.get(profile.id);
    if (existingIndex === undefined) {
      profiles.push(profile);
      profileIndexes.set(profile.id, profiles.length - 1);
    } else {
      profiles[existingIndex] = profile;
    }

    explicitIds.add(profile.id);
  }

  return profiles;
}

function parseDefaultLaunchProfileId(
  raw: string | undefined,
  launchProfiles: CodexLaunchProfile[],
): string {
  if (!raw) {
    return launchProfiles[0]!.id;
  }

  const profile = findLaunchProfile(launchProfiles, raw);
  if (!profile) {
    throw new Error(`Unknown CODEX_DEFAULT_LAUNCH_PROFILE: ${raw}`);
  }

  return profile.id;
}

function ensureAtLeastOneAgentEnabled(
  codexEnabled: boolean,
  piEnabled: boolean,
  hermesEnabled = false,
  openClawEnabled = false,
  claudeCodeEnabled = false,
): void {
  if (!codexEnabled && !piEnabled && !hermesEnabled && !openClawEnabled && !claudeCodeEnabled) {
    throw new Error("At least one agent must be enabled: set NORDRELAY_CODEX_ENABLED=true, NORDRELAY_PI_ENABLED=true, NORDRELAY_HERMES_ENABLED=true, NORDRELAY_OPENCLAW_ENABLED=true, or NORDRELAY_CLAUDE_CODE_ENABLED=true");
  }
}

function parseDefaultAgent(
  raw: string | undefined,
  codexEnabled: boolean,
  piEnabled: boolean,
  hermesEnabled: boolean,
  openClawEnabled: boolean,
  claudeCodeEnabled: boolean,
): AgentId {
  if (!raw) {
    if (codexEnabled) return "codex";
    if (piEnabled) return "pi";
    if (hermesEnabled) return "hermes";
    if (openClawEnabled) return "openclaw";
    return "claude-code";
  }

  if (!isAgentId(raw)) {
    throw new Error(`Invalid NORDRELAY_DEFAULT_AGENT: ${raw}. Expected codex, pi, hermes, openclaw, or claude-code`);
  }
  if (raw === "codex" && !codexEnabled) {
    throw new Error("NORDRELAY_DEFAULT_AGENT=codex requires NORDRELAY_CODEX_ENABLED=true");
  }
  if (raw === "pi" && !piEnabled) {
    throw new Error("NORDRELAY_DEFAULT_AGENT=pi requires NORDRELAY_PI_ENABLED=true");
  }
  if (raw === "hermes" && !hermesEnabled) {
    throw new Error("NORDRELAY_DEFAULT_AGENT=hermes requires NORDRELAY_HERMES_ENABLED=true");
  }
  if (raw === "openclaw" && !openClawEnabled) {
    throw new Error("NORDRELAY_DEFAULT_AGENT=openclaw requires NORDRELAY_OPENCLAW_ENABLED=true");
  }
  if (raw === "claude-code" && !claudeCodeEnabled) {
    throw new Error("NORDRELAY_DEFAULT_AGENT=claude-code requires NORDRELAY_CLAUDE_CODE_ENABLED=true");
  }
  return raw;
}

function parsePiThinkingLevel(raw: string | undefined): AgentReasoningEffort {
  if (!raw) {
    return "medium";
  }
  if (PI_THINKING_LEVELS.includes(raw as AgentReasoningEffort)) {
    return raw as AgentReasoningEffort;
  }
  console.warn(
    `Invalid PI_DEFAULT_THINKING value: "${raw}". Expected one of: ${PI_THINKING_LEVELS.join(", ")}. Falling back to "medium".`,
  );
  return "medium";
}

function parseHermesReasoningEffort(raw: string | undefined): AgentReasoningEffort | undefined {
  if (!raw) {
    return undefined;
  }
  const normalized = raw === "off" ? "none" : raw;
  if (HERMES_REASONING_EFFORTS.includes(normalized as AgentReasoningEffort)) {
    return normalized as AgentReasoningEffort;
  }
  console.warn(
    `Invalid HERMES_DEFAULT_REASONING value: "${raw}". Expected one of: ${HERMES_REASONING_EFFORTS.join(", ")}. Falling back to model default.`,
  );
  return undefined;
}

function parseOpenClawThinkingLevel(raw: string | undefined): AgentReasoningEffort | undefined {
  if (!raw) {
    return undefined;
  }
  if (OPENCLAW_THINKING_LEVELS.includes(raw as AgentReasoningEffort)) {
    return raw as AgentReasoningEffort;
  }
  console.warn(
    `Invalid OPENCLAW_DEFAULT_THINKING value: "${raw}". Expected one of: ${OPENCLAW_THINKING_LEVELS.join(", ")}. Falling back to OpenClaw default.`,
  );
  return undefined;
}

function parseClaudeCodeEffort(raw: string | undefined): AgentReasoningEffort | undefined {
  if (!raw) {
    return undefined;
  }
  if (CLAUDE_CODE_EFFORT_LEVELS.includes(raw as AgentReasoningEffort)) {
    return raw as AgentReasoningEffort;
  }
  console.warn(
    `Invalid CLAUDE_CODE_DEFAULT_EFFORT value: "${raw}". Expected one of: ${CLAUDE_CODE_EFFORT_LEVELS.join(", ")}. Falling back to Claude Code default.`,
  );
  return undefined;
}
