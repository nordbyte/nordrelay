export interface SettingDefinition {
  key: string;
  label: string;
  group: string;
  kind: "string" | "boolean" | "number" | "secret" | "list" | "json";
  description: string;
  restartRequired: boolean;
  options?: string[];
}

export const SECRET_KEYS = new Set([
  "TELEGRAM_BOT_TOKEN",
  "CODEX_API_KEY",
  "HERMES_API_KEY",
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_GATEWAY_PASSWORD",
  "OPENAI_API_KEY",
  "TELEGRAM_WEBHOOK_SECRET",
]);

export const SETTING_DEFINITIONS: SettingDefinition[] = [
  setting("TELEGRAM_BOT_TOKEN", "Telegram bot token", "Telegram", "secret", "BotFather token.", true),
  setting("TELEGRAM_TRANSPORT", "Telegram transport", "Telegram", "string", "polling or webhook.", true, ["polling", "webhook"]),
  setting("TELEGRAM_WEBHOOK_URL", "Webhook public URL", "Telegram", "string", "Public base URL for webhook mode.", true),
  setting("TELEGRAM_WEBHOOK_HOST", "Webhook bind host", "Telegram", "string", "Local webhook bind host.", true),
  setting("TELEGRAM_WEBHOOK_PORT", "Webhook bind port", "Telegram", "number", "Local webhook bind port.", true),
  setting("TELEGRAM_WEBHOOK_PATH", "Webhook path", "Telegram", "string", "Webhook request path.", true),
  setting("TELEGRAM_WEBHOOK_SECRET", "Webhook secret", "Telegram", "secret", "Optional Telegram webhook secret token.", true),

  setting("NORDRELAY_CODEX_ENABLED", "Enable Codex", "Agents", "boolean", "Allow Codex sessions.", true),
  setting("NORDRELAY_PI_ENABLED", "Enable Pi", "Agents", "boolean", "Allow Pi sessions.", true),
  setting("NORDRELAY_HERMES_ENABLED", "Enable Hermes", "Agents", "boolean", "Allow Hermes sessions through the Hermes API Server.", true),
  setting("NORDRELAY_OPENCLAW_ENABLED", "Enable OpenClaw", "Agents", "boolean", "Allow OpenClaw sessions through the OpenClaw Gateway.", true),
  setting("NORDRELAY_CLAUDE_CODE_ENABLED", "Enable Claude Code", "Agents", "boolean", "Allow Claude Code sessions through the Claude Agent SDK.", true),
  setting("NORDRELAY_DEFAULT_AGENT", "Default agent", "Agents", "string", "codex, pi, hermes, openclaw, or claude-code.", true, ["codex", "pi", "hermes", "openclaw", "claude-code"]),
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
  setting("PI_DEFAULT_PROFILE", "Default Pi profile", "Pi", "string", "default, readonly, no-tools, offline, or safe-offline.", true, ["default", "readonly", "no-tools", "offline", "safe-offline"]),

  setting("HERMES_CLI_PATH", "Hermes CLI path", "Hermes", "string", "Optional Hermes executable path.", true),
  setting("HERMES_HOME", "Hermes home", "Hermes", "string", "Optional Hermes home directory. Defaults to ~/.hermes.", true),
  setting("HERMES_STATE_DB_PATH", "Hermes state DB path", "Hermes", "string", "Optional explicit Hermes state.db path.", true),
  setting("HERMES_API_BASE_URL", "Hermes API base URL", "Hermes", "string", "Hermes API Server base URL.", true),
  setting("HERMES_API_KEY", "Hermes API key", "Hermes", "secret", "Bearer token for the Hermes API Server.", true),
  setting("HERMES_DEFAULT_MODEL", "Default Hermes model", "Hermes", "string", "Default model label sent to Hermes API runs.", false),
  setting("HERMES_DEFAULT_REASONING", "Default Hermes reasoning", "Hermes", "string", "none, minimal, low, medium, high, or xhigh.", false, ["none", "minimal", "low", "medium", "high", "xhigh"]),
  setting("HERMES_DEFAULT_PROFILE", "Default Hermes profile", "Hermes", "string", "default, safe, readonly, or yolo.", true, ["default", "safe", "readonly", "yolo"]),

  setting("OPENCLAW_CLI_PATH", "OpenClaw CLI path", "OpenClaw", "string", "Optional OpenClaw executable path.", true),
  setting("OPENCLAW_GATEWAY_URL", "OpenClaw Gateway URL", "OpenClaw", "string", "OpenClaw Gateway WebSocket URL.", true),
  setting("OPENCLAW_GATEWAY_TOKEN", "OpenClaw Gateway token", "OpenClaw", "secret", "Shared-secret token for the OpenClaw Gateway.", true),
  setting("OPENCLAW_GATEWAY_PASSWORD", "OpenClaw Gateway password", "OpenClaw", "secret", "Shared-secret password for the OpenClaw Gateway.", true),
  setting("OPENCLAW_AGENT_ID", "OpenClaw agent ID", "OpenClaw", "string", "Configured OpenClaw agent id, for example main or work.", false),
  setting("OPENCLAW_HOME", "OpenClaw home", "OpenClaw", "string", "Optional OpenClaw home directory. Defaults to ~/.openclaw.", true),
  setting("OPENCLAW_STATE_DIR", "OpenClaw state dir", "OpenClaw", "string", "Optional OpenClaw state directory.", true),
  setting("OPENCLAW_DEFAULT_MODEL", "Default OpenClaw model", "OpenClaw", "string", "Default OpenClaw model id.", false),
  setting("OPENCLAW_DEFAULT_THINKING", "Default OpenClaw thinking", "OpenClaw", "string", "off, minimal, low, medium, high, or xhigh.", false, ["off", "minimal", "low", "medium", "high", "xhigh"]),
  setting("OPENCLAW_DEFAULT_PROFILE", "Default OpenClaw profile", "OpenClaw", "string", "default, safe, readonly, local, or deliver.", true, ["default", "safe", "readonly", "local", "deliver"]),

  setting("CLAUDE_CODE_CLI_PATH", "Claude Code CLI path", "Claude Code", "string", "Optional Claude Code executable path. Defaults to claude on PATH or the SDK bundled runtime.", true),
  setting("CLAUDE_CONFIG_DIR", "Claude config dir", "Claude Code", "string", "Optional Claude config directory. Defaults to ~/.claude.", true),
  setting("CLAUDE_CODE_DEFAULT_MODEL", "Default Claude Code model", "Claude Code", "string", "Default Claude Code model alias or model id.", false),
  setting("CLAUDE_CODE_DEFAULT_EFFORT", "Default Claude Code effort", "Claude Code", "string", "off, low, medium, high, or xhigh.", false, ["off", "low", "medium", "high", "xhigh"]),
  setting("CLAUDE_CODE_DEFAULT_PROFILE", "Default Claude Code profile", "Claude Code", "string", "default, accept-edits, plan, readonly, no-tools, or bypass-permissions.", true, ["default", "accept-edits", "plan", "readonly", "no-tools", "bypass-permissions"]),
  setting("CLAUDE_CODE_MAX_TURNS", "Claude Code max turns", "Claude Code", "number", "Maximum agentic turns for each Claude Code prompt.", false),

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
  setting("NORDRELAY_CLI_VERSION_CACHE_TTL_MS", "CLI version cache TTL", "Workspace", "number", "Installed agent CLI version cache TTL.", true),

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

  setting("NORDRELAY_DASHBOARD_HOST", "Dashboard host", "Dashboard", "string", "WebUI bind host.", true),
  setting("NORDRELAY_DASHBOARD_PORT", "Dashboard port", "Dashboard", "number", "WebUI bind port.", true),
  setting("NORDRELAY_ENV_FILE", "Env file path", "Dashboard", "string", "Optional explicit env-file path used by the CLI wrapper and dashboard.", true),
];

const EXAMPLE_VALUES: Record<string, string> = {
  "TELEGRAM_BOT_TOKEN": "123456789:replace-me",
  "NORDRELAY_CODEX_ENABLED": "true",
  "NORDRELAY_PI_ENABLED": "false",
  "NORDRELAY_HERMES_ENABLED": "false",
  "NORDRELAY_OPENCLAW_ENABLED": "false",
  "NORDRELAY_CLAUDE_CODE_ENABLED": "false",
  "NORDRELAY_DEFAULT_AGENT": "codex",
  "CODEX_API_KEY": "",
  "CODEX_CLI_PATH": "",
  "CODEX_USE_BUNDLED_CLI": "false",
  "CODEX_MODEL": "",
  "CODEX_SYNC_INTERVAL_MS": "10000",
  "CODEX_EXTERNAL_BUSY_CHECK_MS": "5000",
  "CODEX_EXTERNAL_BUSY_STALE_MS": "300000",
  "CODEX_SANDBOX_MODE": "workspace-write",
  "CODEX_APPROVAL_POLICY": "never",
  "CODEX_LAUNCH_PROFILES_JSON": "",
  "CODEX_DEFAULT_LAUNCH_PROFILE": "default",
  "ENABLE_UNSAFE_LAUNCH_PROFILES": "false",
  "PI_CLI_PATH": "",
  "PI_SESSION_DIR": "",
  "PI_DEFAULT_MODEL": "",
  "PI_DEFAULT_THINKING": "medium",
  "PI_DEFAULT_PROFILE": "default",
  "HERMES_CLI_PATH": "",
  "HERMES_HOME": "",
  "HERMES_STATE_DB_PATH": "",
  "HERMES_API_BASE_URL": "http://127.0.0.1:8642",
  "HERMES_API_KEY": "",
  "HERMES_DEFAULT_MODEL": "",
  "HERMES_DEFAULT_REASONING": "",
  "HERMES_DEFAULT_PROFILE": "default",
  "OPENCLAW_CLI_PATH": "",
  "OPENCLAW_GATEWAY_URL": "ws://127.0.0.1:18789",
  "OPENCLAW_GATEWAY_TOKEN": "",
  "OPENCLAW_GATEWAY_PASSWORD": "",
  "OPENCLAW_AGENT_ID": "main",
  "OPENCLAW_HOME": "",
  "OPENCLAW_STATE_DIR": "",
  "OPENCLAW_DEFAULT_MODEL": "",
  "OPENCLAW_DEFAULT_THINKING": "",
  "OPENCLAW_DEFAULT_PROFILE": "default",
  "CLAUDE_CODE_CLI_PATH": "",
  "CLAUDE_CONFIG_DIR": "",
  "CLAUDE_CODE_DEFAULT_MODEL": "",
  "CLAUDE_CODE_DEFAULT_EFFORT": "",
  "CLAUDE_CODE_DEFAULT_PROFILE": "default",
  "CLAUDE_CODE_MAX_TURNS": "100",
  "CONNECTOR_LOG_FORMAT": "text",
  "TOOL_VERBOSITY": "summary",
  "SHOW_TURN_TOKEN_USAGE": "false",
  "ENABLE_TELEGRAM_LOGIN": "true",
  "ENABLE_TELEGRAM_REACTIONS": "false",
  "TELEGRAM_RATE_LIMIT_MIN_INTERVAL_MS": "80",
  "TELEGRAM_EDIT_MIN_INTERVAL_MS": "1200",
  "TELEGRAM_TRANSPORT": "polling",
  "TELEGRAM_WEBHOOK_URL": "",
  "TELEGRAM_WEBHOOK_HOST": "127.0.0.1",
  "TELEGRAM_WEBHOOK_PORT": "8080",
  "TELEGRAM_WEBHOOK_PATH": "/telegram/webhook",
  "TELEGRAM_WEBHOOK_SECRET": "",
  "TELEGRAM_CLI_MIRROR_MODE": "status",
  "TELEGRAM_CLI_MIRROR_MIN_UPDATE_MS": "4000",
  "TELEGRAM_NOTIFY_MODE": "minimal",
  "TELEGRAM_QUIET_HOURS": "",
  "TELEGRAM_REDACT_PATTERNS": "",
  "MAX_FILE_SIZE": "20971520",
  "ARTIFACT_RETENTION_DAYS": "7",
  "ARTIFACT_MAX_TURNS": "30",
  "ARTIFACT_MAX_INBOX_DIRS": "30",
  "ARTIFACT_IGNORE_DIRS": "",
  "ARTIFACT_IGNORE_GLOBS": "",
  "TELEGRAM_AUTO_SEND_ARTIFACTS": "false",
  "NORDRELAY_STATE_BACKEND": "json",
  "NORDRELAY_AUDIT_MAX_EVENTS": "1000",
  "NORDRELAY_SESSION_LOCK_TTL_MS": "1800000",
  "NORDRELAY_VERSION_CACHE_TTL_MS": "3600000",
  "NORDRELAY_CLI_VERSION_CACHE_TTL_MS": "60000",
  "NORDRELAY_DASHBOARD_HOST": "127.0.0.1",
  "NORDRELAY_DASHBOARD_PORT": "31878",
  "NORDRELAY_ENV_FILE": "",
  "WORKSPACE_ALLOWED_ROOTS": "",
  "WORKSPACE_WARN_ROOTS": "",
  "OPENAI_API_KEY": "",
  "VOICE_PREFERRED_BACKEND": "auto",
  "VOICE_DEFAULT_LANGUAGE": "",
  "VOICE_TRANSCRIBE_ONLY": "false",
  "FASTER_WHISPER_PYTHON": ".venv/bin/python",
  "FASTER_WHISPER_MODEL": "base",
  "FASTER_WHISPER_DEVICE": "cpu",
  "FASTER_WHISPER_COMPUTE_TYPE": "int8",
  "FASTER_WHISPER_LANGUAGE": "",
  "FASTER_WHISPER_TIMEOUT_MS": "600000",
};

const GROUP_INTROS: Record<string, string> = {
  Telegram: "Required Telegram bot and transport settings.",
  Agents: "Agent access. Codex is enabled by default; Pi, Hermes, OpenClaw, and Claude Code are opt-in.",
  Codex: "Codex defaults for newly created or reattached sessions.",
  Pi: "Pi coding agent defaults.",
  Hermes: "Hermes Agent defaults. Hermes uses the Hermes API Server.",
  OpenClaw: "OpenClaw Agent defaults. OpenClaw uses the OpenClaw Gateway WebSocket RPC endpoint.",
  "Claude Code": "Claude Code defaults. NordRelay uses the Claude Agent SDK and the host claude CLI when present.",
  Operations: "Runtime output, logging, update, and Telegram behavior controls.",
  Artifacts: "File, artifact, and retention controls.",
  Workspace: "State and workspace guardrails.",
  Voice: "Optional voice transcription settings.",
  Dashboard: "Local WebUI dashboard. User login is required for every page, API route, SSE stream, artifact download, and health endpoint.",
};

export function envExampleValue(key: string): string {
  return EXAMPLE_VALUES[key] ?? "";
}

export function renderEnvExample(): string {
  const lines: string[] = [
    "# NordRelay runtime config example.",
    "# Access is managed with NordRelay users, groups, linked Telegram identities, and enabled Telegram group chats.",
    "# Create the first admin with `nordrelay init` or `nordrelay user create-admin`.",
  ];
  let currentGroup = "";
  for (const definition of SETTING_DEFINITIONS) {
    if (definition.group !== currentGroup) {
      currentGroup = definition.group;
      lines.push('', `# ${currentGroup}`, `# ${GROUP_INTROS[currentGroup] ?? definition.description}`);
    }
    lines.push(`# ${definition.description}`);
    if (definition.options?.length) {
      lines.push(`# Options: ${definition.options.join(", ")}`);
    }
    lines.push(`${definition.key}=${envExampleValue(definition.key)}`);
  }
  return `${lines.join('\n')}\n`;
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
