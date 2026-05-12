import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface SettingDefinition {
  key: string;
  label: string;
  group: string;
  kind: "string" | "boolean" | "number" | "secret" | "list" | "json";
  description: string;
  restartRequired: boolean;
  options?: string[];
}

export interface SettingRecord extends SettingDefinition {
  value: string;
  effectiveValue: string;
  configured: boolean;
  masked: boolean;
}

export interface SettingsSnapshot {
  envPath: string;
  settings: SettingRecord[];
}

export interface SettingsUpdateResult {
  envPath: string;
  changedKeys: string[];
  restartRequired: boolean;
  errors: Array<{ key: string; message: string }>;
}

const SECRET_KEYS = new Set([
  "TELEGRAM_BOT_TOKEN",
  "CODEX_API_KEY",
  "OPENAI_API_KEY",
  "TELEGRAM_WEBHOOK_SECRET",
  "NORDRELAY_DASHBOARD_TOKEN",
  "NORDRELAY_DASHBOARD_PASSWORD",
]);

export const SETTING_DEFINITIONS: SettingDefinition[] = [
  setting("TELEGRAM_BOT_TOKEN", "Telegram bot token", "Telegram", "secret", "BotFather token.", true),
  setting("TELEGRAM_ADMIN_USER_IDS", "Telegram admin user IDs", "Telegram", "list", "Comma-separated Telegram users allowed to administer and use the bot.", true),
  setting("TELEGRAM_ALLOWED_USER_IDS", "Allowed operator user IDs", "Telegram", "list", "Optional non-admin operators.", true),
  setting("TELEGRAM_READONLY_USER_IDS", "Readonly user IDs", "Telegram", "list", "Users allowed to inspect but not mutate.", true),
  setting("TELEGRAM_ALLOWED_CHAT_IDS", "Allowed chat IDs", "Telegram", "list", "Optional chat allowlist.", true),
  setting("TELEGRAM_ALLOW_ANY_CHAT", "Allow any Telegram chat", "Telegram", "boolean", "Unsafe override; keep off for normal use.", true),
  setting("TELEGRAM_ROLE_POLICIES_JSON", "Role policy JSON", "Telegram", "json", "Granular Telegram permission policy.", true),
  setting("TELEGRAM_TRANSPORT", "Telegram transport", "Telegram", "string", "polling or webhook.", true, ["polling", "webhook"]),
  setting("TELEGRAM_WEBHOOK_URL", "Webhook public URL", "Telegram", "string", "Public base URL for webhook mode.", true),
  setting("TELEGRAM_WEBHOOK_HOST", "Webhook bind host", "Telegram", "string", "Local webhook bind host.", true),
  setting("TELEGRAM_WEBHOOK_PORT", "Webhook bind port", "Telegram", "number", "Local webhook bind port.", true),
  setting("TELEGRAM_WEBHOOK_PATH", "Webhook path", "Telegram", "string", "Webhook request path.", true),
  setting("TELEGRAM_WEBHOOK_SECRET", "Webhook secret", "Telegram", "secret", "Optional Telegram webhook secret token.", true),

  setting("NORDRELAY_CODEX_ENABLED", "Enable Codex", "Agents", "boolean", "Allow Codex sessions.", true),
  setting("NORDRELAY_PI_ENABLED", "Enable Pi", "Agents", "boolean", "Allow Pi sessions.", true),
  setting("NORDRELAY_DEFAULT_AGENT", "Default agent", "Agents", "string", "codex or pi.", true, ["codex", "pi"]),
  setting("CODEX_API_KEY", "Codex API key", "Codex", "secret", "Optional Codex SDK API key.", true),
  setting("CODEX_CLI_PATH", "Codex CLI path", "Codex", "string", "Optional explicit Codex executable path.", true),
  setting("CODEX_USE_BUNDLED_CLI", "Use bundled Codex CLI", "Codex", "boolean", "Force SDK-bundled CLI instead of host CLI.", true),
  setting("CODEX_MODEL", "Default Codex model", "Codex", "string", "Default model for new Codex threads.", false),
  setting("CODEX_SYNC_INTERVAL_MS", "Codex sync interval", "Codex", "number", "Local state sync interval.", true),
  setting("CODEX_EXTERNAL_BUSY_CHECK_MS", "External busy check", "Codex", "number", "External CLI busy polling interval.", true),
  setting("CODEX_EXTERNAL_BUSY_STALE_MS", "External busy stale timeout", "Codex", "number", "External CLI stale timeout.", true),
  setting("CODEX_SANDBOX_MODE", "Codex sandbox mode", "Codex", "string", "read-only, workspace-write, or danger-full-access.", true, ["read-only", "workspace-write", "danger-full-access"]),
  setting("CODEX_APPROVAL_POLICY", "Codex approval policy", "Codex", "string", "never, on-request, on-failure, or untrusted.", true, ["never", "on-request", "on-failure", "untrusted"]),
  setting("CODEX_LAUNCH_PROFILES_JSON", "Launch profiles JSON", "Codex", "json", "Additional launch profile definitions.", true),
  setting("CODEX_DEFAULT_LAUNCH_PROFILE", "Default launch profile", "Codex", "string", "Launch profile ID used by default.", true),
  setting("ENABLE_UNSAFE_LAUNCH_PROFILES", "Enable unsafe profiles", "Codex", "boolean", "Expose danger-full-access profiles.", true),

  setting("PI_CLI_PATH", "Pi CLI path", "Pi", "string", "Optional Pi executable path.", true),
  setting("PI_SESSION_DIR", "Pi session dir", "Pi", "string", "Optional Pi session directory.", true),
  setting("PI_DEFAULT_MODEL", "Default Pi model", "Pi", "string", "Default Pi model slug.", false),
  setting("PI_DEFAULT_THINKING", "Default Pi thinking", "Pi", "string", "off, minimal, low, medium, high, or xhigh.", false, ["off", "minimal", "low", "medium", "high", "xhigh"]),

  setting("CONNECTOR_LOG_FORMAT", "Log format", "Operations", "string", "text or json.", true, ["text", "json"]),
  setting("TOOL_VERBOSITY", "Tool verbosity", "Operations", "string", "all, summary, errors-only, or none.", false, ["all", "summary", "errors-only", "none"]),
  setting("SHOW_TURN_TOKEN_USAGE", "Show turn token usage", "Operations", "boolean", "Append per-turn token usage.", false),
  setting("ENABLE_TELEGRAM_LOGIN", "Enable Telegram login", "Operations", "boolean", "Allow /login and /logout.", true),
  setting("ENABLE_TELEGRAM_REACTIONS", "Enable Telegram reactions", "Operations", "boolean", "Send Telegram reactions.", true),
  setting("TELEGRAM_RATE_LIMIT_MIN_INTERVAL_MS", "Telegram send interval", "Operations", "number", "Minimum send interval.", true),
  setting("TELEGRAM_EDIT_MIN_INTERVAL_MS", "Telegram edit interval", "Operations", "number", "Minimum edit interval.", true),
  setting("TELEGRAM_CLI_MIRROR_MODE", "CLI mirror mode", "Operations", "string", "off, status, final, or full.", false, ["off", "status", "final", "full"]),
  setting("TELEGRAM_CLI_MIRROR_MIN_UPDATE_MS", "CLI mirror update interval", "Operations", "number", "Minimum mirrored edit interval.", true),
  setting("TELEGRAM_NOTIFY_MODE", "Notify mode", "Operations", "string", "off, minimal, or all.", false, ["off", "minimal", "all"]),
  setting("TELEGRAM_QUIET_HOURS", "Quiet hours", "Operations", "string", "HH-HH or blank.", false),
  setting("TELEGRAM_REDACT_PATTERNS", "Redaction patterns", "Operations", "list", "Additional comma-separated regex patterns.", true),
  setting("NORDRELAY_UPDATE_METHOD", "Update method", "Operations", "string", "auto, npm, or git.", true, ["auto", "npm", "git"]),

  setting("MAX_FILE_SIZE", "Max file size", "Artifacts", "number", "Max inbound/outbound file size.", true),
  setting("ARTIFACT_RETENTION_DAYS", "Artifact retention days", "Artifacts", "number", "Days before pruning.", true),
  setting("ARTIFACT_MAX_TURNS", "Max artifact turns", "Artifacts", "number", "Maximum artifact turns retained.", true),
  setting("ARTIFACT_MAX_INBOX_DIRS", "Max inbox dirs", "Artifacts", "number", "Maximum inbox dirs retained.", true),
  setting("ARTIFACT_IGNORE_DIRS", "Artifact ignore dirs", "Artifacts", "list", "Extra ignored dirs or relative paths.", true),
  setting("ARTIFACT_IGNORE_GLOBS", "Artifact ignore globs", "Artifacts", "list", "Extra ignored glob patterns.", true),
  setting("TELEGRAM_AUTO_SEND_ARTIFACTS", "Auto-send artifacts", "Artifacts", "boolean", "Automatically send artifact files.", false),

  setting("WORKSPACE_ALLOWED_ROOTS", "Workspace allowed roots", "Workspace", "list", "Restrict selectable workspaces.", true),
  setting("WORKSPACE_WARN_ROOTS", "Workspace warn roots", "Workspace", "list", "Warn for broad workspace roots.", true),
  setting("NORDRELAY_STATE_BACKEND", "State backend", "Workspace", "string", "json or sqlite.", true, ["json", "sqlite"]),
  setting("NORDRELAY_AUDIT_MAX_EVENTS", "Audit max events", "Workspace", "number", "Retained audit events.", true),
  setting("NORDRELAY_SESSION_LOCK_TTL_MS", "Session lock TTL", "Workspace", "number", "Write-lock TTL.", true),
  setting("NORDRELAY_VERSION_CACHE_TTL_MS", "Version cache TTL", "Workspace", "number", "NPM version cache TTL.", true),

  setting("OPENAI_API_KEY", "OpenAI API key", "Voice", "secret", "Whisper fallback API key.", true),
  setting("VOICE_PREFERRED_BACKEND", "Voice backend", "Voice", "string", "auto, parakeet, faster-whisper, or openai.", false, ["auto", "parakeet", "faster-whisper", "openai"]),
  setting("VOICE_DEFAULT_LANGUAGE", "Voice language", "Voice", "string", "Default transcription language.", false),
  setting("VOICE_TRANSCRIBE_ONLY", "Voice transcribe only", "Voice", "boolean", "Do not send voice transcripts as prompts.", false),
  setting("FASTER_WHISPER_PYTHON", "faster-whisper Python", "Voice", "string", "Python executable.", true),
  setting("FASTER_WHISPER_MODEL", "faster-whisper model", "Voice", "string", "Model name.", true),
  setting("FASTER_WHISPER_DEVICE", "faster-whisper device", "Voice", "string", "cpu, cuda, etc.", true),
  setting("FASTER_WHISPER_COMPUTE_TYPE", "faster-whisper compute type", "Voice", "string", "int8, float16, etc.", true),
  setting("FASTER_WHISPER_LANGUAGE", "faster-whisper language", "Voice", "string", "Fixed transcription language.", true),
  setting("FASTER_WHISPER_TIMEOUT_MS", "faster-whisper timeout", "Voice", "number", "Transcription timeout.", true),

  setting("NORDRELAY_DASHBOARD_TOKEN", "Dashboard token", "Dashboard", "secret", "Bearer/login token for WebUI.", true),
  setting("NORDRELAY_DASHBOARD_USER", "Dashboard user", "Dashboard", "string", "Optional Basic Auth user.", true),
  setting("NORDRELAY_DASHBOARD_PASSWORD", "Dashboard password", "Dashboard", "secret", "Optional Basic Auth password.", true),
  setting("NORDRELAY_DASHBOARD_HOST", "Dashboard host", "Dashboard", "string", "WebUI bind host.", true),
  setting("NORDRELAY_DASHBOARD_PORT", "Dashboard port", "Dashboard", "number", "WebUI bind port.", true),
];

export class SettingsService {
  constructor(private readonly envPath: string) {}

  async snapshot(env: NodeJS.ProcessEnv = process.env): Promise<SettingsSnapshot> {
    const parsed = await readEnvFile(this.envPath);
    const settings = SETTING_DEFINITIONS.map((definition) => {
      const configuredValue = parsed[definition.key];
      const effectiveValue = configuredValue ?? env[definition.key] ?? "";
      const masked = SECRET_KEYS.has(definition.key) && Boolean(effectiveValue);
      return {
        ...definition,
        value: masked ? maskSecret(effectiveValue) : effectiveValue,
        effectiveValue: masked ? maskSecret(effectiveValue) : effectiveValue,
        configured: configuredValue !== undefined,
        masked,
      };
    });
    return { envPath: this.envPath, settings };
  }

  async update(patch: Record<string, string | null | undefined>): Promise<SettingsUpdateResult> {
    const current = await readEnvFile(this.envPath);
    const changedKeys: string[] = [];
    const errors: Array<{ key: string; message: string }> = [];
    const definitions = new Map(SETTING_DEFINITIONS.map((definition) => [definition.key, definition]));

    for (const [key, rawValue] of Object.entries(patch)) {
      const definition = definitions.get(key);
      if (!definition) {
        continue;
      }
      const value = normalizeSettingValue(rawValue);
      if (value === undefined || isMaskedSecret(value)) {
        continue;
      }
      if (value === "") {
        if (current[key] !== undefined) {
          delete current[key];
          changedKeys.push(key);
        }
        continue;
      }
      const validationError = validateSettingValue(definition, value);
      if (validationError) {
        errors.push({ key, message: validationError });
        continue;
      }
      if (current[key] !== value) {
        current[key] = value;
        changedKeys.push(key);
      }
    }

    if (changedKeys.length > 0 && errors.length === 0) {
      await writeEnvFile(this.envPath, current);
    }

    return {
      envPath: this.envPath,
      changedKeys: errors.length === 0 ? changedKeys : [],
      restartRequired: errors.length === 0 && changedKeys.some((key) => definitions.get(key)?.restartRequired),
      errors,
    };
  }
}

export function resolveDashboardEnvPath(home: string, cwd = process.cwd()): string {
  if (process.env.NORDRELAY_ENV_FILE) {
    return path.resolve(process.env.NORDRELAY_ENV_FILE);
  }
  void cwd;
  return path.join(home, "nordrelay.env");
}

export function maskSecret(value: string): string {
  if (!value) {
    return "";
  }
  if (value.length <= 8) {
    return "********";
  }
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function setting(
  key: string,
  label: string,
  group: string,
  kind: SettingDefinition["kind"],
  description: string,
  restartRequired: boolean,
  options?: string[],
): SettingDefinition {
  return { key, label, group, kind, description, restartRequired, options };
}

function validateSettingValue(definition: SettingDefinition, value: string): string | null {
  if (definition.kind === "number" && !Number.isFinite(Number(value))) {
    return "Must be a number.";
  }
  if (definition.kind === "boolean" && !["true", "false", "1", "0", "yes", "no", "on", "off"].includes(value.toLowerCase())) {
    return "Must be true or false.";
  }
  if (definition.kind === "json") {
    try {
      JSON.parse(value);
    } catch (error) {
      return `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  if (definition.options && !definition.options.includes(value)) {
    return `Must be one of: ${definition.options.join(", ")}.`;
  }
  return null;
}

async function readEnvFile(filePath: string): Promise<Record<string, string>> {
  try {
    return parseEnvText(await readFile(filePath, "utf8"));
  } catch {
    return {};
  }
}

function parseEnvText(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
    const equals = normalized.indexOf("=");
    if (equals < 1) {
      continue;
    }
    const key = normalized.slice(0, equals).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }
    result[key] = unquoteEnvValue(normalized.slice(equals + 1).trim());
  }
  return result;
}

async function writeEnvFile(filePath: string, values: Record<string, string>): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const orderedKeys = [
    ...SETTING_DEFINITIONS.map((definition) => definition.key).filter((key) => values[key] !== undefined),
    ...Object.keys(values).filter((key) => !SETTING_DEFINITIONS.some((definition) => definition.key === key)).sort(),
  ];
  const lines = [
    "# NordRelay runtime config managed by the dashboard.",
    ...orderedKeys.map((key) => `${key}=${quoteEnvValue(values[key] ?? "")}`),
    "",
  ];
  await writeFile(filePath, lines.join("\n"), { mode: 0o600 });
}

function unquoteEnvValue(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1).replace(/\\n/g, "\n");
  }
  return value;
}

function quoteEnvValue(value: string): string {
  if (!value) {
    return "";
  }
  if (/^[A-Za-z0-9_./:@,+-]+$/.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}

function normalizeSettingValue(value: string | null | undefined): string | undefined {
  if (value === undefined || value === null) {
    return "";
  }
  return String(value).trim();
}

function isMaskedSecret(value: string): boolean {
  return value === "********" || /^\*+$/.test(value) || /^[^*]{1,4}\.\.\.[^*]{1,4}$/.test(value);
}
