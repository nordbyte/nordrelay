import { existsSync, readFileSync } from "node:fs";
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
} from "./codex-launch.js";
import { isAgentId, PI_THINKING_LEVELS, type AgentId, type AgentReasoningEffort } from "./agent.js";
import {
  parseRolePoliciesJson,
  type TelegramRolePolicies,
} from "./access-control.js";
import {
  parseMirrorMode,
  parseNotifyMode,
  parseQuietHours,
  parseVoiceBackendPreference,
  type QuietHours,
  type TelegramMirrorMode,
  type TelegramNotifyMode,
  type VoiceBackendPreference,
} from "./bot-preferences.js";
import type { ConnectorLogFormat } from "./logger.js";
import type { StateBackendKind } from "./state-backend.js";

export type ToolVerbosity = "all" | "summary" | "errors-only" | "none";

export interface ConnectorConfig {
  telegramBotToken: string;
  telegramAllowedUserIds: number[];
  telegramAllowedUserIdSet: Set<number>;
  telegramAllowedChatIds: number[];
  telegramAllowedChatIdSet: Set<number>;
  telegramAdminUserIds: number[];
  telegramAdminUserIdSet: Set<number>;
  telegramReadOnlyUserIds: number[];
  telegramReadOnlyUserIdSet: Set<number>;
  telegramRolePolicies: TelegramRolePolicies;
  telegramAllowAnyChat: boolean;
  telegramRateLimitMinIntervalMs: number;
  telegramEditMinIntervalMs: number;
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
  workspace: string;
  workspaceAllowedRoots: string[];
  workspaceWarnRoots: string[];
  stateBackend: StateBackendKind;
  maxFileSize: number;
  artifactRetentionDays: number;
  artifactMaxTurnDirs: number;
  artifactMaxInboxDirs: number;
  artifactIgnoreDirs: string[];
  artifactIgnoreGlobs: string[];
  telegramAutoSendArtifacts: boolean;
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
}

export function loadConfig(): ConnectorConfig {
  loadEnvFile(path.resolve(process.cwd(), ".env"));

  const telegramBotToken = requireEnv("TELEGRAM_BOT_TOKEN");
  const telegramAllowAnyChat = parseBooleanEnv(optionalString(process.env.TELEGRAM_ALLOW_ANY_CHAT), false);
  const configuredAllowedUserIds = parseOptionalIdList(
    optionalString(process.env.TELEGRAM_ALLOWED_USER_IDS),
    "TELEGRAM_ALLOWED_USER_IDS",
    { positiveOnly: true },
  );
  const telegramAllowedChatIds = parseOptionalIdList(
    optionalString(process.env.TELEGRAM_ALLOWED_CHAT_IDS),
    "TELEGRAM_ALLOWED_CHAT_IDS",
    { positiveOnly: false },
  );
  const configuredAdminUserIds = parseOptionalIdList(
    optionalString(process.env.TELEGRAM_ADMIN_USER_IDS),
    "TELEGRAM_ADMIN_USER_IDS",
    { positiveOnly: true },
  );
  ensureTelegramAdminIds(configuredAdminUserIds);
  const telegramAllowedUserIds = mergeUniqueIds(configuredAllowedUserIds, configuredAdminUserIds);
  const telegramReadOnlyUserIds = parseOptionalIdList(
    optionalString(process.env.TELEGRAM_READONLY_USER_IDS),
    "TELEGRAM_READONLY_USER_IDS",
    { positiveOnly: true },
  );
  const telegramRolePolicies = parseRolePoliciesJson(optionalString(process.env.TELEGRAM_ROLE_POLICIES_JSON));
  ensureTelegramAllowlist(telegramAllowedUserIds, telegramAllowedChatIds, telegramAllowAnyChat);
  const telegramAdminUserIds = configuredAdminUserIds;
  const telegramRateLimitMinIntervalMs = parseNonNegativeIntegerEnv(optionalString(process.env.TELEGRAM_RATE_LIMIT_MIN_INTERVAL_MS), 80, "TELEGRAM_RATE_LIMIT_MIN_INTERVAL_MS");
  const telegramEditMinIntervalMs = parseNonNegativeIntegerEnv(optionalString(process.env.TELEGRAM_EDIT_MIN_INTERVAL_MS), 1_200, "TELEGRAM_EDIT_MIN_INTERVAL_MS");
  const telegramMirrorMode = parseMirrorMode(optionalString(process.env.TELEGRAM_CLI_MIRROR_MODE), "status");
  const telegramMirrorMinUpdateMs = parseNonNegativeIntegerEnv(optionalString(process.env.TELEGRAM_CLI_MIRROR_MIN_UPDATE_MS), 4_000, "TELEGRAM_CLI_MIRROR_MIN_UPDATE_MS");
  const telegramNotifyMode = parseNotifyMode(optionalString(process.env.TELEGRAM_NOTIFY_MODE), "minimal");
  const telegramQuietHours = parseQuietHours(optionalString(process.env.TELEGRAM_QUIET_HOURS));
  const telegramRedactPatterns = parseOptionalStringList(optionalString(process.env.TELEGRAM_REDACT_PATTERNS));
  const telegramTransport = parseTelegramTransport(optionalString(process.env.TELEGRAM_TRANSPORT));
  const telegramWebhookUrl = optionalString(process.env.TELEGRAM_WEBHOOK_URL);
  const telegramWebhookHost = optionalString(process.env.TELEGRAM_WEBHOOK_HOST) ?? "127.0.0.1";
  const telegramWebhookPort = parsePositiveIntegerEnv(optionalString(process.env.TELEGRAM_WEBHOOK_PORT), 8080, "TELEGRAM_WEBHOOK_PORT");
  const telegramWebhookPath = parseWebhookPath(optionalString(process.env.TELEGRAM_WEBHOOK_PATH));
  const telegramWebhookSecret = optionalString(process.env.TELEGRAM_WEBHOOK_SECRET);
  const workspace = resolveWorkspace();
  const workspaceAllowedRoots = parsePathList(optionalString(process.env.WORKSPACE_ALLOWED_ROOTS));
  const workspaceWarnRoots = parsePathList(optionalString(process.env.WORKSPACE_WARN_ROOTS));
  const stateBackend = parseStateBackend(optionalString(process.env.NORDRELAY_STATE_BACKEND));
  const maxFileSize = parseMaxFileSize(optionalString(process.env.MAX_FILE_SIZE));
  const artifactRetentionDays = parsePositiveNumberEnv(optionalString(process.env.ARTIFACT_RETENTION_DAYS), 7, "ARTIFACT_RETENTION_DAYS");
  const artifactMaxTurnDirs = parsePositiveIntegerEnv(optionalString(process.env.ARTIFACT_MAX_TURNS), 30, "ARTIFACT_MAX_TURNS");
  const artifactMaxInboxDirs = parsePositiveIntegerEnv(optionalString(process.env.ARTIFACT_MAX_INBOX_DIRS), 30, "ARTIFACT_MAX_INBOX_DIRS");
  const artifactIgnoreDirs = parseOptionalStringList(optionalString(process.env.ARTIFACT_IGNORE_DIRS));
  const artifactIgnoreGlobs = parseOptionalStringList(optionalString(process.env.ARTIFACT_IGNORE_GLOBS));
  const telegramAutoSendArtifacts = parseBooleanEnv(optionalString(process.env.TELEGRAM_AUTO_SEND_ARTIFACTS), false);
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
  ensureAtLeastOneAgentEnabled(codexEnabled, piEnabled);
  const piCliPath = optionalString(process.env.PI_CLI_PATH);
  const piSessionDir = optionalString(process.env.PI_SESSION_DIR);
  const piDefaultModel = optionalString(process.env.PI_DEFAULT_MODEL);
  const piDefaultThinking = parsePiThinkingLevel(optionalString(process.env.PI_DEFAULT_THINKING));
  const defaultAgent = parseDefaultAgent(
    optionalString(process.env.NORDRELAY_DEFAULT_AGENT),
    codexEnabled,
    piEnabled,
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
  const voiceDefaultLanguage = optionalString(process.env.VOICE_DEFAULT_LANGUAGE);
  const voiceTranscribeOnly = parseBooleanEnv(optionalString(process.env.VOICE_TRANSCRIBE_ONLY), false);
  const auditMaxEvents = parsePositiveIntegerEnv(optionalString(process.env.NORDRELAY_AUDIT_MAX_EVENTS), 1000, "NORDRELAY_AUDIT_MAX_EVENTS");
  const sessionLockTtlMs = parseNonNegativeIntegerEnv(optionalString(process.env.NORDRELAY_SESSION_LOCK_TTL_MS), 30 * 60 * 1000, "NORDRELAY_SESSION_LOCK_TTL_MS");

  if (telegramTransport === "webhook" && !telegramWebhookUrl) {
    throw new Error("TELEGRAM_TRANSPORT=webhook requires TELEGRAM_WEBHOOK_URL");
  }

  return {
    telegramBotToken,
    telegramAllowedUserIds,
    telegramAllowedUserIdSet: new Set(telegramAllowedUserIds),
    telegramAllowedChatIds,
    telegramAllowedChatIdSet: new Set(telegramAllowedChatIds),
    telegramAdminUserIds,
    telegramAdminUserIdSet: new Set(telegramAdminUserIds),
    telegramReadOnlyUserIds,
    telegramReadOnlyUserIdSet: new Set(telegramReadOnlyUserIds),
    telegramRolePolicies,
    telegramAllowAnyChat,
    telegramRateLimitMinIntervalMs,
    telegramEditMinIntervalMs,
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
    workspace,
    workspaceAllowedRoots,
    workspaceWarnRoots,
    stateBackend,
    maxFileSize,
    artifactRetentionDays,
    artifactMaxTurnDirs,
    artifactMaxInboxDirs,
    artifactIgnoreDirs,
    artifactIgnoreGlobs,
    telegramAutoSendArtifacts,
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
  };
}

/**
 * Workspace is derived automatically:
 * - In Docker: /workspace (the mount point)
 * - Outside Docker: process.cwd()
 */
function resolveWorkspace(): string {
  if (isRunningInDocker()) {
    return "/workspace";
  }
  return process.cwd();
}

function isRunningInDocker(): boolean {
  return existsSync("/.dockerenv") || process.env.container === "docker";
}

function loadEnvFile(envPath: string): void {
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

function parseOptionalIdList(
  raw: string | undefined,
  envName: string,
  options: { positiveOnly: boolean },
): number[] {
  if (!raw) {
    return [];
  }

  const ids = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || (options.positiveOnly ? parsed <= 0 : parsed === 0)) {
        throw new Error(`Invalid Telegram id in ${envName}: ${value}`);
      }
      return parsed;
    });

  if (raw.trim() && ids.length === 0) {
    throw new Error(`${envName} must contain at least one id`);
  }

  return ids;
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

function ensureTelegramAllowlist(
  userIds: number[],
  chatIds: number[],
  allowAnyChat: boolean,
): void {
  if (allowAnyChat) {
    return;
  }

  if (userIds.length > 0 || chatIds.length > 0) {
    return;
  }

  throw new Error(
    "TELEGRAM_ALLOWED_USER_IDS or TELEGRAM_ALLOWED_CHAT_IDS must contain at least one id",
  );
}

function ensureTelegramAdminIds(userIds: number[]): void {
  if (userIds.length === 0) {
    throw new Error("TELEGRAM_ADMIN_USER_IDS must contain at least one id");
  }
}

function mergeUniqueIds(...groups: number[][]): number[] {
  return Array.from(new Set(groups.flat()));
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

function ensureAtLeastOneAgentEnabled(codexEnabled: boolean, piEnabled: boolean): void {
  if (!codexEnabled && !piEnabled) {
    throw new Error("At least one agent must be enabled: set NORDRELAY_CODEX_ENABLED=true or NORDRELAY_PI_ENABLED=true");
  }
}

function parseDefaultAgent(
  raw: string | undefined,
  codexEnabled: boolean,
  piEnabled: boolean,
): AgentId {
  if (!raw) {
    return codexEnabled ? "codex" : "pi";
  }

  if (!isAgentId(raw)) {
    throw new Error(`Invalid NORDRELAY_DEFAULT_AGENT: ${raw}. Expected codex or pi`);
  }
  if (raw === "codex" && !codexEnabled) {
    throw new Error("NORDRELAY_DEFAULT_AGENT=codex requires NORDRELAY_CODEX_ENABLED=true");
  }
  if (raw === "pi" && !piEnabled) {
    throw new Error("NORDRELAY_DEFAULT_AGENT=pi requires NORDRELAY_PI_ENABLED=true");
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
