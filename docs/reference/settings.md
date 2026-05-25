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

## Security

| Key | Purpose |
| --- | --- |
| `NORDRELAY_WEBAUTHN_ENABLED` | Enable WebUI passkeys |
| `NORDRELAY_WEBAUTHN_RP_NAME` | Passkey relying-party display name |
| `NORDRELAY_WEBAUTHN_RP_ID` | Optional passkey relying-party domain |
| `NORDRELAY_WEBAUTHN_ORIGIN` | Optional expected WebUI origin |

## Plugins

| Key | Purpose |
| --- | --- |
| `NORDRELAY_PLUGINS_ENABLED` | Enable local plugin metadata loading and plugin extension points |
| `NORDRELAY_PLUGIN_GITHUB_INSTALL_ENABLED` | Allow installing plugins from GitHub repository URLs |
| `NORDRELAY_PLUGIN_ALLOW_BUILD_SCRIPTS` | Reserved switch for trusted plugin build hooks |

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
| `DISCORD_CLI_MIRROR_MODE` | Discord-specific CLI mirror override |
| `DISCORD_CLI_MIRROR_MIN_UPDATE_MS` | Discord mirror edit/update throttle |
| `DISCORD_NOTIFY_MODE` | Discord-specific completion notification override |
| `DISCORD_QUIET_HOURS` | Discord-specific quiet-hours override |
| `DISCORD_AUTO_SEND_ARTIFACTS` | Discord-specific automatic artifact delivery override |
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
| `SLACK_CLI_MIRROR_MODE` | Slack-specific CLI mirror override |
| `SLACK_CLI_MIRROR_MIN_UPDATE_MS` | Slack mirror edit/update throttle |
| `SLACK_NOTIFY_MODE` | Slack-specific completion notification override |
| `SLACK_QUIET_HOURS` | Slack-specific quiet-hours override |
| `SLACK_AUTO_SEND_ARTIFACTS` | Slack-specific automatic artifact delivery override |
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
| `MATRIX_CLI_MIRROR_MODE` | Matrix-specific CLI mirror override |
| `MATRIX_CLI_MIRROR_MIN_UPDATE_MS` | Matrix mirror edit/update throttle |
| `MATRIX_NOTIFY_MODE` | Matrix-specific completion notification override |
| `MATRIX_QUIET_HOURS` | Matrix-specific quiet-hours override |
| `MATRIX_AUTO_SEND_ARTIFACTS` | Matrix-specific automatic artifact delivery override |

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
| `ENABLE_TELEGRAM_LOGIN` | Allow Telegram `/login` and `/logout` flows |
| `ENABLE_TELEGRAM_REACTIONS` | Send Telegram reactions when supported |
| `TELEGRAM_RATE_LIMIT_MIN_INTERVAL_MS` | Minimum Telegram send interval |
| `TELEGRAM_EDIT_MIN_INTERVAL_MS` | Minimum Telegram edit interval |
| `NORDRELAY_CLI_MIRROR_MODE` | Default CLI mirror mode |
| `NORDRELAY_CLI_MIRROR_MIN_UPDATE_MS` | Mirrored edit interval |
| `NORDRELAY_WEB_CLI_MIRROR_MODE` | WebUI mirror override |
| `NORDRELAY_WEB_CLI_MIRROR_MIN_UPDATE_MS` | WebUI mirror edit/update throttle |
| `NORDRELAY_NOTIFY_MODE` | Completion notification mode |
| `NORDRELAY_QUIET_HOURS` | Default quiet hours |
| `NORDRELAY_ARTIFACTS_ENABLED` | Enable generated-artifact tracking |
| `NORDRELAY_AUTO_SEND_ARTIFACTS` | Legacy artifact auto-summary switch |
| `NORDRELAY_ARTIFACT_DELIVERY` | Default artifact delivery mode |
| `TELEGRAM_CLI_MIRROR_MODE` | Telegram-specific CLI mirror override |
| `TELEGRAM_CLI_MIRROR_MIN_UPDATE_MS` | Telegram mirror edit/update throttle |
| `TELEGRAM_NOTIFY_MODE` | Telegram-specific completion notification override |
| `TELEGRAM_QUIET_HOURS` | Telegram-specific quiet-hours override |
| `TELEGRAM_REDACT_PATTERNS` | Additional comma-separated redaction regex patterns |
| `NORDRELAY_UPDATE_METHOD` | Connector update method: `auto`, `npm`, or `git` |
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
| `TELEGRAM_AUTO_SEND_ARTIFACTS` | Telegram-specific automatic artifact delivery override |
| `TELEGRAM_ARTIFACT_DELIVERY` | Telegram-specific artifact delivery mode |
| `DISCORD_ARTIFACT_DELIVERY` | Discord-specific artifact delivery mode |
| `SLACK_ARTIFACT_DELIVERY` | Slack-specific artifact delivery mode |
| `MATRIX_ARTIFACT_DELIVERY` | Matrix-specific artifact delivery mode |
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
| `FFMPEG_PATH` | Optional absolute ffmpeg executable path |
| `FASTER_WHISPER_PYTHON` | Python executable for faster-whisper |
| `FASTER_WHISPER_MODEL` | faster-whisper model name |
| `FASTER_WHISPER_DEVICE` | faster-whisper device |
| `FASTER_WHISPER_COMPUTE_TYPE` | faster-whisper compute type |
| `FASTER_WHISPER_LANGUAGE` | Fixed faster-whisper transcription language |
| `FASTER_WHISPER_TIMEOUT_MS` | faster-whisper transcription timeout |
| `COHERE_TRANSCRIBE_PYTHON` | Python executable for local Cohere Transcribe |
| `COHERE_TRANSCRIBE_MODEL` | Hugging Face model id for local Cohere Transcribe |
| `COHERE_TRANSCRIBE_DEVICE` | Local Cohere Transcribe device |
| `COHERE_TRANSCRIBE_DTYPE` | Local Cohere Transcribe dtype |
| `COHERE_TRANSCRIBE_PUNCTUATION` | Enable local Cohere punctuation/casing |
| `COHERE_TRANSCRIBE_MAX_NEW_TOKENS` | Maximum generated local Cohere transcription tokens |
| `COHERE_TRANSCRIBE_TIMEOUT_MS` | Local Cohere Transcribe timeout |
| `OPENAI_API_KEY` | Optional Whisper fallback key |
| `HF_TOKEN` | Optional Hugging Face token for gated model downloads |
