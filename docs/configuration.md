# Configuration Reference

## Environment Reference

Dashboard:

- `NORDRELAY_WEBUI_ENABLED`: allows the local WebUI dashboard to start and counts as a valid access surface. Defaults to `true`.
- `NORDRELAY_AUTOSTART_ENABLED`: manages user-level autostart for the NordRelay connector from the WebUI Settings page. Defaults to `false`.
- `NORDRELAY_WEBUI_AUTOSTART_ENABLED`: manages user-level autostart for the WebUI dashboard from the WebUI Settings page. Defaults to `false`; the WebUI autostart starts the connector when needed.

Telegram:

- `TELEGRAM_ENABLED`: starts the Telegram adapter. Defaults to `true`.
- `TELEGRAM_BOT_TOKEN`: BotFather token. Required for the Telegram adapter to start.
- `TELEGRAM_RATE_LIMIT_MIN_INTERVAL_MS`: minimum interval for normal Telegram API sends. Defaults to `80`.
- `TELEGRAM_EDIT_MIN_INTERVAL_MS`: minimum interval for Telegram message edits. Defaults to `1200`.
- `TELEGRAM_TRANSPORT`: `polling` or `webhook`. Defaults to `polling`.
- `TELEGRAM_WEBHOOK_URL`: public base URL for webhook mode, for example `https://relay.example`.
- `TELEGRAM_WEBHOOK_HOST`: local bind host for webhook mode. Defaults to `127.0.0.1`.
- `TELEGRAM_WEBHOOK_PORT`: local bind port for webhook mode. Defaults to `8080`.
- `TELEGRAM_WEBHOOK_PATH`: webhook request path. Defaults to `/telegram/webhook`.
- `TELEGRAM_WEBHOOK_SECRET`: optional Telegram webhook secret token.
- `NORDRELAY_CLI_MIRROR_MODE`: default CLI mirror mode for chat adapters: `off`, `status`, `final`, or `full`. Defaults to `status`.
- `NORDRELAY_CLI_MIRROR_MIN_UPDATE_MS`: default minimum interval for mirrored CLI status edits. Defaults to `4000`.
- `NORDRELAY_WEB_CLI_MIRROR_MODE`, `NORDRELAY_WEB_CLI_MIRROR_MIN_UPDATE_MS`: optional WebUI-specific CLI mirror override and status update interval.
- `NORDRELAY_NOTIFY_MODE`: default notification mode for chat adapters: `off`, `minimal`, or `all`. Defaults to `minimal`.
- `NORDRELAY_QUIET_HOURS`: optional default quiet-hour range in `HH-HH` format, for example `22-7`; use `off` in a channel override to disable inherited quiet hours.
- `NORDRELAY_AUTO_SEND_ARTIFACTS`: default automatic artifact summaries/uploads for chat adapters. Defaults to `false`.
- `TELEGRAM_CLI_MIRROR_MODE`, `TELEGRAM_CLI_MIRROR_MIN_UPDATE_MS`, `TELEGRAM_NOTIFY_MODE`, `TELEGRAM_QUIET_HOURS`, and `TELEGRAM_AUTO_SEND_ARTIFACTS`: optional Telegram-specific overrides.
- `TELEGRAM_REDACT_PATTERNS`: comma-separated regular expressions for additional Telegram/log redaction.

Discord:

- `DISCORD_ENABLED`: starts the Discord adapter. Defaults to `false`.
- `DISCORD_BOT_TOKEN`: Discord bot token. Required for the Discord adapter to start.
- `DISCORD_CLIENT_ID`: Discord application/client id used for slash-command registration.
- `DISCORD_GUILD_IDS`: optional comma-separated guild ids for instant guild slash-command registration.
- `DISCORD_ALLOWED_GUILD_IDS`: optional guild allow-list before user/group permissions are checked.
- `DISCORD_ALLOWED_CHANNEL_IDS`: optional channel allow-list before user/group permissions are checked.
- `DISCORD_MESSAGE_CONTENT_ENABLED`: reads regular Discord text messages as prompts. Defaults to `true`.
- `DISCORD_COMMAND_MODE`: `slash`, `message`, or `both`. Defaults to `both`.
- `DISCORD_AUTO_REGISTER_COMMANDS`: registers slash commands on startup when `DISCORD_CLIENT_ID` is set. Defaults to `true`.
- `DISCORD_CLI_MIRROR_MODE`, `DISCORD_CLI_MIRROR_MIN_UPDATE_MS`, `DISCORD_NOTIFY_MODE`, `DISCORD_QUIET_HOURS`, and `DISCORD_AUTO_SEND_ARTIFACTS`: optional Discord-specific overrides for the channel-neutral defaults.

Slack:

- `SLACK_ENABLED`: starts the Slack adapter. Defaults to `false`.
- `SLACK_BOT_TOKEN`: Slack bot token. Required for the Slack adapter to start.
- `SLACK_APP_TOKEN`: Slack app-level token for Socket Mode. Required when `SLACK_SOCKET_MODE=true`.
- `SLACK_SIGNING_SECRET`: Slack signing secret for HTTP Events mode. Required when `SLACK_SOCKET_MODE=false`.
- `SLACK_SOCKET_MODE`: uses Slack Socket Mode instead of an HTTP Events receiver. Defaults to `true`.
- `SLACK_PORT`: HTTP receiver port when Socket Mode is disabled. Defaults to `3000`.
- `SLACK_ALLOWED_TEAM_IDS`: optional Slack workspace allow-list before user/group permissions are checked.
- `SLACK_ALLOWED_CHANNEL_IDS`: optional channel allow-list before user/group permissions are checked.
- `SLACK_MESSAGE_CONTENT_ENABLED`: reads regular Slack text messages as prompts. Defaults to `true`.
- `SLACK_COMMAND`: slash command configured in Slack. Defaults to `/nordrelay`.
- `SLACK_CLI_MIRROR_MODE`, `SLACK_CLI_MIRROR_MIN_UPDATE_MS`, `SLACK_NOTIFY_MODE`, `SLACK_QUIET_HOURS`, and `SLACK_AUTO_SEND_ARTIFACTS`: optional Slack-specific overrides for the channel-neutral defaults.

Matrix:

- `MATRIX_ENABLED`: starts the Matrix adapter. Defaults to `false`.
- `MATRIX_HOMESERVER_URL`: Matrix homeserver base URL, for example `https://matrix.example.com`. Required for the Matrix adapter to start.
- `MATRIX_ACCESS_TOKEN`: access token for the bot Matrix account. Required for the Matrix adapter to start.
- `MATRIX_USER_ID`: full bot Matrix user id, for example `@nordrelay:example.com`. Required for the Matrix adapter to start.
- `MATRIX_DEVICE_ID`: optional Matrix device id associated with the access token.
- `MATRIX_AUTOJOIN_INVITES`: automatically joins rooms where the bot user is invited. Defaults to `true`.
- `MATRIX_ALLOWED_ROOM_IDS`: optional Matrix room allow-list before user/group permissions are checked. Use room ids such as `!roomid:example.com`.
- `MATRIX_MESSAGE_CONTENT_ENABLED`: reads regular Matrix text messages as prompts. Defaults to `true`.
- `MATRIX_COMMAND_PREFIX`: text command prefix for Matrix clients, for example `!nr`. Slash-style messages such as `/session` are also recognized. Defaults to `!nr`.
- `MATRIX_SYNC_TIMEOUT_MS`: long-poll timeout passed to Matrix `/sync`. Defaults to `30000`.
- `MATRIX_POLL_TIMEOUT_MS`: HTTP timeout for each Matrix `/sync` request. Defaults to `35000`.
- `MATRIX_CLI_MIRROR_MODE`, `MATRIX_CLI_MIRROR_MIN_UPDATE_MS`, `MATRIX_NOTIFY_MODE`, `MATRIX_QUIET_HOURS`, and `MATRIX_AUTO_SEND_ARTIFACTS`: optional Matrix-specific overrides for the channel-neutral defaults.
- End-to-end encrypted Matrix rooms are not decrypted by NordRelay. Use unencrypted bot rooms or a bridge until Matrix E2EE support is added.

User management:

- Users, groups, Telegram identities, Telegram group-chat access, Discord identities, Discord channel access, Slack identities, Slack channel access, Matrix identities, Matrix room access, and web sessions are stored in `~/.nordrelay/users.json`.
- Manage users in the WebUI Users page or with `nordrelay user list`, `create-admin`, `create`, `reset-password`, `link-telegram`, `link-discord`, `link-slack`, `link-matrix`, `link-code`, `discord-link-code`, `slack-link-code`, and `matrix-link-code`.
- Built-in groups are `admin`, `user`, and `readonly`.
- Group permissions include `inspect`, `sessions.read`, `sessions.write`, `prompt.send`, `prompt.abort`, `files.read`, `files.write`, `settings.read`, `settings.write`, `auth.manage`, `diagnostics.read`, `logs.read`, `logs.clear`, `queue.read`, `queue.write`, `workflows.read`, `workflows.write`, `workflows.run`, `updates.run`, `system.restart`, `users.read`, `users.write`, `audit.read`, `peers.read`, `peers.write`, and `peers.connect`.
- Custom groups can also restrict access to specific agent ids, workspace roots, Telegram chat ids, Discord channel ids, Slack channel ids, and Matrix room ids.

Peers:

- `NORDRELAY_PEER_ENABLED`: starts the dedicated peer API. Defaults to `false`.
- `NORDRELAY_PEER_NAME`: optional human-readable node name shown to paired instances.
- `NORDRELAY_PEER_HOST`: peer API bind host. Defaults to `127.0.0.1`.
- `NORDRELAY_PEER_PORT`: peer API port. Defaults to `31979`.
- `NORDRELAY_PEER_PUBLIC_URL`: optional URL other instances should use to reach this node.
- `NORDRELAY_PEER_TLS_ENABLED`: serves the peer API over HTTPS with an automatically generated local certificate. Defaults to `true`.
- `NORDRELAY_PEER_REQUIRE_TLS`: refuses plaintext peer serving on non-loopback hosts. Defaults to `true`.
- Peer identity, TLS certificate, peers, invitations, and pending outbound relay requests are stored under `~/.nordrelay/identity.json`, `~/.nordrelay/tls/`, `~/.nordrelay/peers.json`, and `~/.nordrelay/peer-relay-queue.json`.
- Peer invitations expire after at most 24 hours even if a longer lifetime is requested.

Agent selection:

- `NORDRELAY_CODEX_ENABLED`: enables Codex contexts. Defaults to `true`.
- `NORDRELAY_PI_ENABLED`: enables Pi contexts. Defaults to `false`.
- `NORDRELAY_HERMES_ENABLED`: enables Hermes contexts through the Hermes API Server. Defaults to `false`.
- `NORDRELAY_OPENCLAW_ENABLED`: enables OpenClaw contexts through the OpenClaw Gateway. Defaults to `false`.
- `NORDRELAY_CLAUDE_CODE_ENABLED`: enables Claude Code contexts through the Claude Agent SDK. Defaults to `false`.
- `NORDRELAY_DEFAULT_AGENT`: `codex`, `pi`, `hermes`, `openclaw`, or `claude-code`, used for new chat contexts. Defaults to the first enabled agent.
- `NORDRELAY_STATE_BACKEND`: `json` or `sqlite`. JSON is the default; SQLite requires `better-sqlite3`.
- `NORDRELAY_AUDIT_MAX_EVENTS`: maximum audit events retained. Defaults to `1000`.
- `NORDRELAY_SESSION_LOCK_TTL_MS`: session write-lock TTL. Defaults to `1800000`.
- `NORDRELAY_VERSION_CACHE_TTL_MS`: npm version freshness cache TTL. Defaults to `3600000`; set `0` to disable.
- `NORDRELAY_CLI_VERSION_CACHE_TTL_MS`: installed agent CLI version cache TTL. Defaults to `60000`; set `0` to disable.

Dashboard:

- `NORDRELAY_DASHBOARD_HOST`: dashboard bind host. Defaults to `127.0.0.1`.
- `NORDRELAY_DASHBOARD_PORT`: dashboard bind port. Defaults to `31878`.
- `NORDRELAY_ENV_FILE`: optional explicit env-file path used by the wrapper and edited by the dashboard settings page. Defaults to `~/.nordrelay/nordrelay.env`.

Codex:

- `CODEX_API_KEY`: optional API key for Codex SDK auth.
- `CODEX_CLI_PATH`: optional explicit path to the Codex CLI executable.
- `CODEX_USE_BUNDLED_CLI`: set `true` to force the SDK-bundled Codex CLI instead of the host `codex` executable.
- `CODEX_MODEL`: default model for new threads.
- `CODEX_SYNC_INTERVAL_MS`: periodic local Codex-state sync interval for active chat sessions. Defaults to `10000`; set `0` to disable.
- `CODEX_EXTERNAL_BUSY_CHECK_MS`: how often queued chat prompts re-check an active local Codex CLI task. Defaults to `5000`.
- `CODEX_EXTERNAL_BUSY_STALE_MS`: maximum age for an unclosed rollout task before it is treated as stale instead of active. Defaults to `300000`.
- `CODEX_SANDBOX_MODE`: default sandbox mode, one of `read-only`, `workspace-write`, `danger-full-access`.
- `CODEX_APPROVAL_POLICY`: default approval policy, one of `never`, `on-request`, `on-failure`, `untrusted`.
- `CODEX_LAUNCH_PROFILES_JSON`: JSON array of additional launch profiles.
- `CODEX_DEFAULT_LAUNCH_PROFILE`: profile id used by default. Defaults to `default`.
- `ENABLE_UNSAFE_LAUNCH_PROFILES`: set `true` to expose `danger-full-access` profiles.

Pi:

- `PI_CLI_PATH`: optional explicit path to the Pi CLI executable. Defaults to `pi` on `PATH`.
- `PI_SESSION_DIR`: optional Pi session directory. Defaults to `~/.pi/agent/sessions/` or `PI_CODING_AGENT_SESSION_DIR`.
- `PI_DEFAULT_MODEL`: optional default model pattern for new Pi sessions, for example `openai-codex/gpt-5.5`.
- `PI_DEFAULT_THINKING`: default Pi thinking level: `off`, `minimal`, `low`, `medium`, `high`, or `xhigh`. Defaults to `medium`.
- `PI_DEFAULT_PROFILE`: default Pi launch profile: `default`, `readonly`, `no-tools`, `offline`, or `safe-offline`. Defaults to `default`.

Hermes:

- `HERMES_CLI_PATH`: optional explicit path to the Hermes CLI executable. Defaults to `hermes` on `PATH`.
- `HERMES_HOME`: optional Hermes home directory. Defaults to `~/.hermes`.
- `HERMES_STATE_DB_PATH`: optional explicit Hermes `state.db` path. Overrides `HERMES_HOME`.
- `HERMES_API_BASE_URL`: Hermes API Server base URL. Defaults to `http://127.0.0.1:8642`.
- `HERMES_API_KEY`: optional bearer token for the Hermes API Server.
- `HERMES_DEFAULT_MODEL`: optional model label sent with new Hermes API runs.
- `HERMES_DEFAULT_REASONING`: default Hermes reasoning effort: `none`, `minimal`, `low`, `medium`, `high`, or `xhigh`.
- `HERMES_DEFAULT_PROFILE`: default Hermes launch profile: `default`, `safe`, `readonly`, or `yolo`. Defaults to `default`.

OpenClaw:

- `OPENCLAW_CLI_PATH`: optional explicit path to the OpenClaw CLI executable. Defaults to `openclaw` on `PATH`.
- `OPENCLAW_GATEWAY_URL`: OpenClaw Gateway WebSocket URL. Defaults to `ws://127.0.0.1:18789`.
- `OPENCLAW_GATEWAY_TOKEN`: optional shared-secret token for the OpenClaw Gateway.
- `OPENCLAW_GATEWAY_PASSWORD`: optional shared-secret password for the OpenClaw Gateway.
- `OPENCLAW_AGENT_ID`: OpenClaw agent id used for runs and session discovery. Defaults to `main`.
- `OPENCLAW_HOME`: optional OpenClaw home directory. Defaults to `~/.openclaw`.
- `OPENCLAW_STATE_DIR`: optional explicit OpenClaw state directory. Overrides `OPENCLAW_HOME`.
- `OPENCLAW_DEFAULT_MODEL`: optional model label sent with new OpenClaw Gateway runs.
- `OPENCLAW_DEFAULT_THINKING`: default OpenClaw thinking level: `off`, `minimal`, `low`, `medium`, `high`, or `xhigh`.
- `OPENCLAW_DEFAULT_PROFILE`: default OpenClaw launch profile: `default`, `safe`, `readonly`, `local`, or `deliver`. Defaults to `default`.

Claude Code:

- `CLAUDE_CODE_CLI_PATH`: optional explicit path to the Claude Code CLI executable. Defaults to `claude` on `PATH`, then the SDK bundled runtime.
- `CLAUDE_CONFIG_DIR`: optional Claude config directory. Defaults to `~/.claude`.
- `CLAUDE_CODE_DEFAULT_MODEL`: optional default Claude Code model alias or model id.
- `CLAUDE_CODE_DEFAULT_EFFORT`: default Claude Code effort: `off`, `low`, `medium`, `high`, or `xhigh`.
- `CLAUDE_CODE_DEFAULT_PROFILE`: default Claude Code launch profile: `default`, `accept-edits`, `plan`, `readonly`, `no-tools`, or `bypass-permissions`. Defaults to `default`.
- `CLAUDE_CODE_MAX_TURNS`: maximum agentic turns per Claude Code prompt. Defaults to `100`.

Telegram output:

- `CONNECTOR_LOG_FORMAT`: `text` or `json`. Defaults to `text`.
- `TOOL_VERBOSITY`: `all`, `summary`, `errors-only`, or `none`.
- `SHOW_TURN_TOKEN_USAGE`: appends per-turn token usage when `true`.
- `ENABLE_TELEGRAM_REACTIONS`: enables Telegram reactions when `true`.
- `MAX_FILE_SIZE`: maximum inbound Telegram document size in bytes. Defaults to 20 MB.
- `NORDRELAY_ARTIFACT_DELIVERY`: default artifact delivery mode for chat adapters. Supported values: `manual-only`, `summary`, `summary-with-actions`, `auto-files`, `auto-zip`, `images-only`, and `off`.
- `TELEGRAM_ARTIFACT_DELIVERY`, `DISCORD_ARTIFACT_DELIVERY`, `SLACK_ARTIFACT_DELIVERY`, and `MATRIX_ARTIFACT_DELIVERY`: optional channel-specific artifact delivery overrides.
- `ARTIFACT_MAX_TOTAL_BYTES`: optional managed artifact storage quota in bytes. `0` disables quota enforcement.
- `ARTIFACT_WARN_PERCENT`: warning threshold for the artifact quota. Defaults to `80`.
- `ARTIFACT_RETENTION_DAYS`: artifact/inbox turn age before pruning. Defaults to `7`.
- `ARTIFACT_MAX_TURNS`: maximum artifact turn directories to keep per workspace. Defaults to `30`.
- `ARTIFACT_MAX_INBOX_DIRS`: maximum staged inbox directories to keep per workspace. Defaults to `30`.
- `ARTIFACT_IGNORE_DIRS`: comma-separated extra directory names or relative paths ignored during workspace artifact scans.
- `ARTIFACT_IGNORE_GLOBS`: comma-separated glob patterns ignored during workspace artifact scans.
- `TELEGRAM_AUTO_SEND_ARTIFACTS`, `DISCORD_AUTO_SEND_ARTIFACTS`, `SLACK_AUTO_SEND_ARTIFACTS`, and `MATRIX_AUTO_SEND_ARTIFACTS`: compatibility booleans that map to artifact delivery defaults when the newer delivery mode is not set.

Workspace policy:

- `WORKSPACE_ALLOWED_ROOTS`: comma-separated root directories allowed for session switching and workspace selection. Empty means unrestricted.
- `WORKSPACE_WARN_ROOTS`: comma-separated broad roots that should be allowed but warned about in `/session` and `/workspaces`.
- `NORDRELAY_SESSION_WORKSPACE_MODE`: controls how new NordRelay sessions choose a workspace. `shared` keeps the current workspace behavior, `worktree` creates an isolated Git worktree per new session, and `attached` marks external/manual sessions without creating a worktree.
- `NORDRELAY_SESSION_WORKTREE_ROOT`: directory for session worktrees and integration worktrees. Defaults to `~/.nordrelay/worktrees`.
- `NORDRELAY_SESSION_WORKTREE_BRANCH_PREFIX`: Git branch prefix for session and integration branches. Defaults to `nr/session`.

Auth and voice:

- `ENABLE_TELEGRAM_LOGIN`: enables `/login` and `/logout`. Defaults to `true`.
- `FASTER_WHISPER_PYTHON`: Python executable for local Linux voice transcription. Example: `.venv/bin/python`.
- `FASTER_WHISPER_MODEL`: faster-whisper model name. Defaults to `base`.
- `FASTER_WHISPER_DEVICE`: faster-whisper device. Defaults to `cpu`.
- `FASTER_WHISPER_COMPUTE_TYPE`: faster-whisper compute type. Defaults to `int8`.
- `FASTER_WHISPER_LANGUAGE`: optional fixed transcription language.
- `FASTER_WHISPER_TIMEOUT_MS`: local transcription timeout. Defaults to `600000`.
- `COHERE_TRANSCRIBE_PYTHON`: Python executable with `torch`, `transformers`, `librosa`, `soundfile`, and `accelerate` installed. Defaults to `FASTER_WHISPER_PYTHON`.
- `COHERE_TRANSCRIBE_MODEL`: Hugging Face model id. Defaults to `CohereLabs/cohere-transcribe-03-2026`.
- `COHERE_TRANSCRIBE_DEVICE`: local device for Cohere Transcribe. Defaults to `auto`.
- `COHERE_TRANSCRIBE_DTYPE`: local dtype for Cohere Transcribe. Defaults to `auto`.
- `COHERE_TRANSCRIBE_PUNCTUATION`: enables punctuation/casing for Cohere Transcribe. Defaults to `true`.
- `COHERE_TRANSCRIBE_MAX_NEW_TOKENS`: maximum generated transcription tokens. Defaults to `1024`.
- `COHERE_TRANSCRIBE_TIMEOUT_MS`: local Cohere Transcribe timeout. Defaults to `1800000`.
- `HF_TOKEN`: optional Hugging Face token for gated local model downloads.
- `OPENAI_API_KEY`: enables Whisper transcription fallback for voice/audio.
- `VOICE_PREFERRED_BACKEND`: `auto`, `parakeet`, `faster-whisper`, `cohere-transcribe`, or `openai`. Defaults to `auto`.
- `VOICE_DEFAULT_LANGUAGE`: optional default language code, for example `de` or `en`. Leave empty or set `auto` for backend auto-detect where supported; Parakeet ignores this value and Cohere Transcribe expects one of its supported language codes.
- `VOICE_TRANSCRIBE_ONLY`: when `true`, voice/audio messages are transcribed but not sent to the selected agent.

NordRelay wrapper:

- `NORDRELAY_HOME`: config/state/log directory override. Defaults to `~/.nordrelay`.
- `NORDRELAY_SOURCE_ROOT`: runtime source root override. Useful when the plugin is launched from Codex cache.
- `NORDRELAY_UPDATE_METHOD`: optional `auto`, `npm`, or `git` self-update method override used by `nordrelay update`, `/update`, and the WebUI update button. Auto uses git when the runtime root has a `.git` directory and npm otherwise.
- Agent updates from the dashboard and Telegram use each agent's native updater where possible: `codex update`, `pi update pi`, `hermes update --yes`, `openclaw update --yes`, and `claude update`. Not-installed agents can be installed from the dashboard or with `/update install <agent>` using npm global installs.
- `NORDRELAY_KEEP_PENDING_UPDATES`: set true to avoid dropping pending Telegram updates on start.
- `NORDRELAY_FORWARD_TOOL_OUTPUT`: backward-compatible alias that sets `TOOL_VERBOSITY=all` when `TOOL_VERBOSITY` is unset.
- `NORDRELAY_STATE_FILE`: internal state-file path passed by the wrapper.
- `NORDRELAY_WRAPPER_PID`: internal wrapper PID passed to the runtime.
- `NORDRELAY_DROP_PENDING_UPDATES`: internal polling startup flag.


## Launch Profiles

Built-in profiles:

- `default`: uses `CODEX_SANDBOX_MODE` and `CODEX_APPROVAL_POLICY`.
- `readonly`: `read-only` with `never`.
- `review`: `workspace-write` with `on-request`.
- `full-access`: `danger-full-access` with `never`, only when unsafe profiles are enabled.

Custom profile example:

```dotenv
CODEX_LAUNCH_PROFILES_JSON=[{"id":"review-safe","label":"Review Safe","sandboxMode":"workspace-write","approvalPolicy":"on-request"}]
CODEX_DEFAULT_LAUNCH_PROFILE=review-safe
```

Multiple profiles:

```dotenv
CODEX_LAUNCH_PROFILES_JSON=[{"id":"readonly-audit","label":"Readonly Audit","sandboxMode":"read-only","approvalPolicy":"never"},{"id":"interactive","label":"Interactive","sandboxMode":"workspace-write","approvalPolicy":"on-request"}]
```

Unsafe full-access profile:

```dotenv
ENABLE_UNSAFE_LAUNCH_PROFILES=true
CODEX_LAUNCH_PROFILES_JSON=[{"id":"host-full","label":"Host Full Access","sandboxMode":"danger-full-access","approvalPolicy":"never"}]
```

Unsafe profiles are intentionally gated. Chat adapters ask for confirmation before applying them.
