# Settings keys

This page summarizes the runtime keys generated in `.env.example`.

## Dashboard

| Key | Purpose |
| --- | --- |
| `NORDRELAY_WEBUI_ENABLED` | Enable the login-protected WebUI |
| `NORDRELAY_AUTOSTART_ENABLED` | Manage connector autostart |
| `NORDRELAY_WEBUI_AUTOSTART_ENABLED` | Manage WebUI autostart |
| `NORDRELAY_DASHBOARD_HOST` | WebUI bind host |
| `NORDRELAY_DASHBOARD_PORT` | WebUI bind port |
| `NORDRELAY_ENV_FILE` | Explicit env-file path |

## Chat adapters

| Key | Purpose |
| --- | --- |
| `TELEGRAM_ENABLED` | Enable Telegram |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token |
| `TELEGRAM_TRANSPORT` | `polling` or `webhook` |
| `TELEGRAM_WEBHOOK_URL` | Public webhook base URL |
| `TELEGRAM_WEBHOOK_HOST` | Local webhook bind host |
| `TELEGRAM_WEBHOOK_PORT` | Local webhook bind port |
| `TELEGRAM_WEBHOOK_PATH` | Webhook path |
| `TELEGRAM_WEBHOOK_SECRET` | Optional Telegram webhook secret |
| `DISCORD_ENABLED` | Enable Discord |
| `DISCORD_BOT_TOKEN` | Discord bot token |
| `DISCORD_CLIENT_ID` | Discord application/client ID |
| `DISCORD_GUILD_IDS` | Guild IDs for fast slash-command registration |
| `DISCORD_ALLOWED_GUILD_IDS` | Guild allow-list |
| `DISCORD_ALLOWED_CHANNEL_IDS` | Channel allow-list |
| `DISCORD_MESSAGE_CONTENT_ENABLED` | Read normal Discord messages |
| `DISCORD_COMMAND_MODE` | `slash`, `message`, or `both` |
| `DISCORD_AUTO_REGISTER_COMMANDS` | Register Discord slash commands on startup |
| `SLACK_ENABLED` | Enable Slack |
| `SLACK_BOT_TOKEN` | Slack bot token |
| `SLACK_APP_TOKEN` | Slack Socket Mode app token |
| `SLACK_SIGNING_SECRET` | Slack Events signing secret |
| `SLACK_SOCKET_MODE` | Use Socket Mode |
| `SLACK_PORT` | HTTP events port when Socket Mode is off |
| `SLACK_ALLOWED_TEAM_IDS` | Slack team allow-list |
| `SLACK_ALLOWED_CHANNEL_IDS` | Slack channel allow-list |
| `SLACK_MESSAGE_CONTENT_ENABLED` | Read normal Slack messages |
| `SLACK_COMMAND` | Slack slash command |
| `MATRIX_ENABLED` | Enable Matrix |
| `MATRIX_HOMESERVER_URL` | Matrix homeserver base URL |
| `MATRIX_ACCESS_TOKEN` | Matrix bot access token |
| `MATRIX_USER_ID` | Matrix bot user ID |
| `MATRIX_DEVICE_ID` | Optional Matrix device ID |
| `MATRIX_AUTOJOIN_INVITES` | Auto-join invited rooms |
| `MATRIX_ALLOWED_ROOM_IDS` | Matrix room allow-list |
| `MATRIX_MESSAGE_CONTENT_ENABLED` | Read normal Matrix messages |
| `MATRIX_COMMAND_PREFIX` | Matrix text command prefix |
| `MATRIX_SYNC_TIMEOUT_MS` | Matrix `/sync` long-poll timeout |
| `MATRIX_POLL_TIMEOUT_MS` | Matrix HTTP request timeout |

## Agents

| Key | Purpose |
| --- | --- |
| `NORDRELAY_CODEX_ENABLED` | Enable Codex |
| `NORDRELAY_PI_ENABLED` | Enable Pi |
| `NORDRELAY_HERMES_ENABLED` | Enable Hermes |
| `NORDRELAY_OPENCLAW_ENABLED` | Enable OpenClaw |
| `NORDRELAY_CLAUDE_CODE_ENABLED` | Enable Claude Code |
| `NORDRELAY_DEFAULT_AGENT` | Default agent |
| `CODEX_API_KEY` | Optional Codex SDK API key |
| `CODEX_CLI_PATH` | Explicit Codex executable |
| `CODEX_USE_BUNDLED_CLI` | Force SDK-bundled Codex CLI |
| `CODEX_MODEL` | Default Codex model |
| `CODEX_SYNC_INTERVAL_MS` | Codex state sync interval |
| `CODEX_EXTERNAL_BUSY_CHECK_MS` | External CLI busy polling interval |
| `CODEX_EXTERNAL_BUSY_STALE_MS` | External CLI stale timeout |
| `CODEX_EXTERNAL_APPROVAL_CONTROL` | Allow local TTY approval control when OS permits it |
| `CODEX_EXTERNAL_APPROVAL_SUDO_HELPER` | Allow configured sudo helper fallback |
| `CODEX_SANDBOX_MODE` | Codex sandbox mode |
| `CODEX_APPROVAL_POLICY` | Codex approval policy |
| `CODEX_LAUNCH_PROFILES_JSON` | Extra Codex launch profiles |
| `CODEX_DEFAULT_LAUNCH_PROFILE` | Default launch profile ID |
| `ENABLE_UNSAFE_LAUNCH_PROFILES` | Show unsafe profiles |
| `PI_CLI_PATH` | Explicit Pi executable |
| `PI_SESSION_DIR` | Pi session directory |
| `PI_DEFAULT_MODEL` | Default Pi model |
| `PI_DEFAULT_THINKING` | Default Pi thinking level |
| `PI_DEFAULT_PROFILE` | Default Pi profile |
| `HERMES_CLI_PATH` | Explicit Hermes executable |
| `HERMES_HOME` | Hermes home directory |
| `HERMES_STATE_DB_PATH` | Hermes state database |
| `HERMES_API_BASE_URL` | Hermes API Server URL |
| `HERMES_API_KEY` | Hermes API bearer token |
| `HERMES_DEFAULT_MODEL` | Default Hermes model |
| `HERMES_DEFAULT_REASONING` | Default Hermes reasoning |
| `HERMES_DEFAULT_PROFILE` | Default Hermes profile |
| `OPENCLAW_CLI_PATH` | Explicit OpenClaw executable |
| `OPENCLAW_GATEWAY_URL` | OpenClaw Gateway WebSocket URL |
| `OPENCLAW_GATEWAY_TOKEN` | OpenClaw Gateway shared token |
| `OPENCLAW_GATEWAY_PASSWORD` | OpenClaw Gateway shared password |
| `OPENCLAW_AGENT_ID` | OpenClaw agent ID |
| `OPENCLAW_HOME` | OpenClaw home directory |
| `OPENCLAW_STATE_DIR` | OpenClaw state directory |
| `OPENCLAW_DEFAULT_MODEL` | Default OpenClaw model |
| `OPENCLAW_DEFAULT_THINKING` | Default OpenClaw thinking |
| `OPENCLAW_DEFAULT_PROFILE` | Default OpenClaw profile |
| `CLAUDE_CODE_CLI_PATH` | Explicit Claude Code executable |
| `CLAUDE_CONFIG_DIR` | Claude config directory |
| `CLAUDE_CODE_DEFAULT_MODEL` | Default Claude Code model |
| `CLAUDE_CODE_DEFAULT_EFFORT` | Default Claude Code effort |
| `CLAUDE_CODE_DEFAULT_PROFILE` | Default Claude Code profile |
| `CLAUDE_CODE_MAX_TURNS` | Maximum turns per prompt |

## Operations, artifacts, workspaces, peers, voice

| Key | Purpose |
| --- | --- |
| `CONNECTOR_LOG_FORMAT` | `text` or `json` |
| `TOOL_VERBOSITY` | Tool output verbosity |
| `SHOW_TURN_TOKEN_USAGE` | Append per-turn token usage |
| `NORDRELAY_CLI_MIRROR_MODE` | Default CLI mirror mode |
| `NORDRELAY_CLI_MIRROR_MIN_UPDATE_MS` | Mirrored edit interval |
| `NORDRELAY_WEB_CLI_MIRROR_MODE` | WebUI mirror override |
| `NORDRELAY_NOTIFY_MODE` | Completion notification mode |
| `NORDRELAY_QUIET_HOURS` | Default quiet hours |
| `NORDRELAY_ARTIFACTS_ENABLED` | Enable generated-artifact tracking |
| `NORDRELAY_AUTO_SEND_ARTIFACTS` | Legacy artifact auto-summary switch |
| `NORDRELAY_ARTIFACT_DELIVERY` | Default artifact delivery mode |
| `*_CLI_MIRROR_MODE` | Adapter-specific mirror override |
| `*_NOTIFY_MODE` | Adapter-specific notify override |
| `*_QUIET_HOURS` | Adapter-specific quiet hours |
| `*_ARTIFACT_DELIVERY` | Adapter-specific artifact delivery mode |
| `MAX_FILE_SIZE` | Attachment size limit |
| `ARTIFACT_MAX_TOTAL_BYTES` | Artifact storage quota |
| `ARTIFACT_WARN_PERCENT` | Artifact quota warning threshold |
| `ARTIFACT_SAFE_FILE_POLICY` | Sensitive-path handling |
| `ARTIFACT_RETENTION_DAYS` | Artifact retention days |
| `ARTIFACT_MAX_TURNS` | Retained artifact turns |
| `ARTIFACT_MAX_INBOX_DIRS` | Retained inbox directories |
| `ARTIFACT_IGNORE_DIRS` | Additional ignored directories |
| `ARTIFACT_IGNORE_GLOBS` | Additional ignored globs |
| `WORKSPACE_ALLOWED_ROOTS` | Workspace allow-list |
| `WORKSPACE_WARN_ROOTS` | Broad-root warnings |
| `NORDRELAY_WORKSPACE` | Default workspace |
| `NORDRELAY_SESSION_WORKSPACE_MODE` | `shared`, `worktree`, or `attached` |
| `NORDRELAY_SESSION_WORKTREE_ROOT` | Worktree root directory |
| `NORDRELAY_SESSION_WORKTREE_BRANCH_PREFIX` | Worktree branch prefix |
| `NORDRELAY_STATE_BACKEND` | `json` or `sqlite` |
| `NORDRELAY_AUDIT_MAX_EVENTS` | Retained audit events |
| `NORDRELAY_SESSION_LOCK_TTL_MS` | Session write-lock TTL |
| `NORDRELAY_DASHBOARD_CACHE_TTL_MS` | Dashboard cache TTL |
| `NORDRELAY_ACTIVE_DISCOVERY_CACHE_TTL_MS` | Active-session discovery cache TTL |
| `NORDRELAY_OPENCLAW_ACTIVE_DISCOVERY_CACHE_TTL_MS` | OpenClaw discovery cache TTL |
| `NORDRELAY_UNIFIED_JOB_MAX_ITEMS` | Retained unified jobs |
| `NORDRELAY_VERSION_CACHE_TTL_MS` | npm version cache TTL |
| `NORDRELAY_CLI_VERSION_CACHE_TTL_MS` | Installed CLI version cache TTL |
| `NORDRELAY_PEER_ENABLED` | Enable peer API |
| `NORDRELAY_PEER_NAME` | Local node display name |
| `NORDRELAY_PEER_HOST` | Peer API bind host |
| `NORDRELAY_PEER_PORT` | Peer API port |
| `NORDRELAY_PEER_PUBLIC_URL` | URL shared to other nodes |
| `NORDRELAY_PEER_TLS_ENABLED` | Serve peer API over HTTPS |
| `NORDRELAY_PEER_REQUIRE_TLS` | Reject plaintext on non-loopback |
| `NORDRELAY_PEER_HEALTH_CHECK_MS` | Peer health interval |
| `NORDRELAY_PEER_DISCOVERY_TIMEOUT_MS` | LAN discovery timeout |
| `NORDRELAY_PEER_OUTBOUND_RELAY_ENABLED` | Enable outbound relay polling |
| `NORDRELAY_PEER_OUTBOUND_RELAY_PEERS` | Outbound relay peer filter |
| `NORDRELAY_PEER_OUTBOUND_RELAY_POLL_MS` | Outbound relay poll interval |
| `VOICE_PREFERRED_BACKEND` | Voice backend preference |
| `VOICE_DEFAULT_LANGUAGE` | Default transcription language |
| `VOICE_TRANSCRIBE_ONLY` | Do not send transcripts as prompts |
| `FASTER_WHISPER_*` | faster-whisper runtime settings |
| `COHERE_TRANSCRIBE_*` | local Cohere Transcribe runtime settings |
| `OPENAI_API_KEY` | Optional Whisper fallback key |
| `HF_TOKEN` | Optional Hugging Face token for gated model downloads |
