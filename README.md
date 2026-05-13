# NordRelay

NordRelay is a remote control plane for coding agents across messaging channels. The current implementation connects Codex, Pi, Hermes, OpenClaw, and Claude Code coding-agent sessions to Telegram, keeps independent sessions per chat or forum topic, streams replies and tool activity back to Telegram, supports files, photos, voice input, model controls, session browsing, retry/abort, and CLI handback.

The repo is both a local Codex marketplace and a standalone Node app. The plugin lives in `plugins/nordrelay/`; the full bot runtime lives in `src/` and uses `@openai/codex-sdk` for Codex, Pi RPC mode for Pi, the Hermes API Server for Hermes, the OpenClaw Gateway WebSocket RPC surface for OpenClaw, and the Claude Agent SDK for Claude Code.

## Features

Session control:

- Independent coding-agent sessions per Telegram private chat, group chat, and forum topic.
- `/agent` switches a Telegram context between enabled agents such as Codex, Pi, Hermes, OpenClaw, and Claude Code.
- Persistent Telegram context metadata in the active workspace under `.nordrelay/contexts.json`.
- `/new` starts a fresh thread, with workspace selection when known workspaces are available.
- `/session` shows thread id, workspace, launch profile, launch behavior, model, reasoning, fast mode, context usage, token totals, and subscription limit remaining percentages.
- `/sessions` opens a paginated browser for recent sessions from the selected agent.
- `/sessions <query>` filters recent sessions by id, title, workspace, model, or first message.
- `/sync` manually refreshes the active Telegram session from local CLI state when the selected agent supports state watching.
- `/pin`, `/unpin`, and `/pinned` keep important threads at the top of Telegram session browsing.
- `/switch <session-id>` switches directly to an existing session.
- `/attach <session-id>` binds an existing agent session to the current chat or topic.
- Existing thread metadata is imported on switch/attach, including model, reasoning effort, sandbox mode, and approval policy.
- Codex session usage is read from local rollout JSONL files, including context-used percent, total input/output tokens, 5h limit remaining, and weekly limit remaining.
- `/handback` returns a ready-to-run CLI command for continuing in the native agent CLI.
- `/retry` resends the last prompt for the current Telegram context.
- `/queue`, inline run/top/up/down/cancel buttons, `/cancel <queue-id>`, and `/clearqueue` manage queued prompts for a busy Telegram context.
- `/queue later <minutes> <prompt>` schedules a prompt for later execution, and `/queue inspect <queue-id>` shows full queue metadata.
- `/abort`, `/stop`, and the inline Abort button cancel the active agent turn.
- Busy prompts are queued per Telegram context instead of being dropped.
- If the attached thread is currently active in the local agent CLI, Telegram prompts are queued until that CLI task finishes.
- Active Codex, Pi, Hermes, OpenClaw, and Claude Code CLI/API turns are mirrored into Telegram with configurable `off`, `status`, `final`, or `full` modes.
- `/mirror` controls CLI mirroring per Telegram context.
- Queues survive connector restarts and are resumed automatically when the external CLI turn becomes idle.
- `/notify` controls completion/status notifications and quiet hours per Telegram context.
- `/workspaces` lists allowed workspaces and shows workspace guardrail warnings.
- `/status`, `/health`, and `/version` report connector runtime health from Telegram.
- `/tasks` and `/progress` show the current turn status, queue length, active tool, elapsed time, and last error.
- `/activity` shows a compact timeline of recent rollout events for the active thread, with filters and export.
- `/diagnostics` reports redacted runtime, config, user/group authorization, Telegram rate-limit, mirror, voice, session, queue, and progress details.
- `/lock`, `/unlock`, and `/locks` provide a team write-lock for shared sessions so one user can operate while others watch.
- `/audit` shows recent prompt, queue, lock, command, authentication, permission-denied, user, group, Telegram-link, Telegram-chat, and web-session audit events for admins.

Adapter architecture:

- Telegram is implemented as the first channel adapter with text, typing, streaming edits, inline buttons, files, photos, voice, topics, and webhook capability metadata.
- `/channels` shows available and planned messaging adapters for Discord, WhatsApp, Slack, and Matrix.
- Codex, Pi, Hermes, OpenClaw, and Claude Code are implemented as agent adapters.
- `/agents` shows available/planned agent adapters and whether Codex, Pi, Hermes, OpenClaw, and Claude Code are enabled.
- Shared command-action renderers and a channel runtime contract keep inbound commands, outbound messages, typing, files, inline actions, and streaming-ready delivery separate from Telegram-specific API calls.

Codex runtime:

- Uses `@openai/codex-sdk` to start, resume, and stream Codex threads.
- Prefers the host `codex` executable on `PATH`, so Codex CLI updates are picked up automatically; the SDK-bundled CLI is used only as fallback.
- Supports model selection through `/model`, using Codex model cache when available and fallback models otherwise.
- Supports reasoning effort selection through `/reasoning` and the backward-compatible `/effort` alias: `minimal`, `low`, `medium`, `high`, `xhigh`.
- Supports launch profiles through `/launch_profiles` and `/launch`.
- Built-in launch profiles include Default, Read Only, Review, and optional Full Access.
- Custom launch profiles can be configured with `CODEX_LAUNCH_PROFILES_JSON`.
- Unsafe `danger-full-access` profiles require `ENABLE_UNSAFE_LAUNCH_PROFILES=true` and Telegram confirmation.
- Review or unsafe launch profiles require an inline Telegram approval before each prompt is executed.
- Fast mode can be toggled with `/fast` and mirrors Codex's `fast_default_opt_out` setting from `~/.codex/config.toml`.
- Active Telegram sessions periodically sync model, reasoning, workspace, launch metadata, and fast-mode defaults from local agent state where supported.
- Active local Codex CLI tasks are detected from rollout JSONL files so Telegram does not race the CLI on the same thread.
- `/diagnostics` includes rollout path, activity status, stale/idle reason, line count, and last update time.
- Optional per-turn token usage footer with `SHOW_TURN_TOKEN_USAGE=true`.

Pi runtime:

- Pi support is opt-in with `NORDRELAY_PI_ENABLED=true`.
- The default Telegram agent is selected with `NORDRELAY_DEFAULT_AGENT=codex`, `pi`, `hermes`, `openclaw`, or `claude-code`.
- Pi sessions are driven through official `pi --mode rpc` JSONL commands and events.
- Existing Pi sessions are discovered from `~/.pi/agent/sessions/` or `PI_SESSION_DIR`.
- `/sessions`, `/switch`, `/attach`, `/new`, `/session`, `/handback`, `/model`, `/reasoning`, `/abort`, `/stop`, `/retry`, `/queue`, files, photos, and voice input work for Pi contexts.
- Pi model selection uses `pi --list-models` and sends `set_model` through RPC for active sessions.
- Pi thinking levels use `/reasoning` and support `off`, `minimal`, `low`, `medium`, `high`, and `xhigh`.
- Pi token and context stats are read through `get_session_stats` when an RPC session is active.
- Pi launch profiles expose CLI safety modes such as default, read-only tools, no tools, offline, and safe offline.
- Pi external CLI activity is detected from Pi session JSONL files so Telegram/WebUI prompts queue while the same Pi session is busy.
- Pi CLI turns can be mirrored into Telegram/WebUI with status, tool activity, final answers, activity timelines, diagnostics, and generated artifact discovery.
- Pi provider auth checks report the environment variables expected for the selected provider.
- Codex-only subscription limit percentages remain Codex-specific; Pi reports token/context stats when available.

Hermes runtime:

- Hermes support is opt-in with `NORDRELAY_HERMES_ENABLED=true`.
- The default Telegram agent can be set with `NORDRELAY_DEFAULT_AGENT=hermes`.
- Hermes turns are executed through the Hermes API Server `/v1/runs` endpoint and streamed through `/v1/runs/{run_id}/events`.
- `/abort` and `/stop` use the Hermes run stop endpoint when a NordRelay-started Hermes run is active.
- Existing Hermes sessions are discovered from `~/.hermes/state.db`, or from `HERMES_STATE_DB_PATH` when configured.
- `/sessions`, `/switch`, `/attach`, `/new`, `/session`, `/handback`, `/model`, `/reasoning`, `/abort`, `/stop`, `/retry`, `/queue`, files, photos, and voice input work for Hermes contexts.
- Hermes model selection uses `/v1/models` when the API Server is reachable and falls back to the selected/default model.
- Hermes reasoning uses `/reasoning` and supports `none`, `minimal`, `low`, `medium`, `high`, and `xhigh`.
- Hermes launch profiles include `default`, `safe`, `readonly`, and `yolo`; profiles map to run instructions and Hermes approval responses.
- Hermes external activity is detected from `state.db`, so Telegram/WebUI prompts queue while the same Hermes session has an unfinished CLI turn.
- Hermes CLI/API turns can be mirrored into Telegram/WebUI with status, tool activity, final answers, activity timelines, diagnostics, and generated artifact discovery.
- `/auth` checks that the Hermes API Server is reachable and that `HERMES_API_KEY` is usable when configured.

OpenClaw runtime:

- OpenClaw support is opt-in with `NORDRELAY_OPENCLAW_ENABLED=true`.
- The default Telegram agent can be set with `NORDRELAY_DEFAULT_AGENT=openclaw`.
- OpenClaw turns are executed through the OpenClaw Gateway WebSocket RPC endpoint configured by `OPENCLAW_GATEWAY_URL`.
- `/abort` and `/stop` call the OpenClaw Gateway cancel method when a NordRelay-started OpenClaw run is active.
- Existing OpenClaw sessions are discovered from `openclaw sessions --all-agents --json`, or from the state directory configured with `OPENCLAW_HOME` or `OPENCLAW_STATE_DIR`.
- `/sessions`, `/switch`, `/attach`, `/new`, `/session`, `/handback`, `/model`, `/reasoning`, `/abort`, `/stop`, `/retry`, `/queue`, files, photos, and voice input work for OpenClaw contexts.
- OpenClaw model selection uses the Gateway `models.list` method when reachable and falls back to `openclaw models list --json`.
- OpenClaw thinking uses `/reasoning` and supports `off`, `minimal`, `low`, `medium`, `high`, and `xhigh`.
- OpenClaw launch profiles include `default`, `safe`, `readonly`, `local`, and `deliver`; profiles map to Gateway run flags and additional instructions.
- OpenClaw external activity is detected from OpenClaw session state, so Telegram/WebUI prompts queue while the same OpenClaw session has an unfinished CLI turn.
- OpenClaw Gateway turns can be mirrored into Telegram/WebUI with status, tool activity, final answers, activity timelines, diagnostics, and generated artifact discovery.
- `/auth` checks that the OpenClaw Gateway is reachable and that `OPENCLAW_GATEWAY_TOKEN` or `OPENCLAW_GATEWAY_PASSWORD` is usable when configured.

Claude Code runtime:

- Claude Code support is opt-in with `NORDRELAY_CLAUDE_CODE_ENABLED=true`.
- The default Telegram agent can be set with `NORDRELAY_DEFAULT_AGENT=claude-code`.
- Claude Code turns are executed through `@anthropic-ai/claude-agent-sdk`, using the host `claude` executable when available and the SDK bundled runtime otherwise.
- Existing Claude Code sessions are discovered from `~/.claude/projects/`, or from `CLAUDE_CONFIG_DIR/projects` when configured.
- `/sessions`, `/switch`, `/attach`, `/new`, `/session`, `/handback`, `/model`, `/reasoning`, `/abort`, `/stop`, `/retry`, `/queue`, files, photos, and voice input work for Claude Code contexts.
- Claude Code model selection exposes common aliases and model ids; explicit values from existing sessions are preserved.
- Claude Code effort uses `/reasoning` and supports `off`, `low`, `medium`, `high`, and `xhigh`.
- Claude Code launch profiles include `default`, `accept-edits`, `plan`, `readonly`, `no-tools`, and optional `bypass-permissions`.
- Claude Code external activity is detected from transcript JSONL files, so Telegram/WebUI prompts queue while the same Claude Code session has an unfinished CLI turn.
- Claude Code SDK turns can be mirrored into Telegram/WebUI with status, tool activity, final answers, activity timelines, diagnostics, and generated artifact discovery.
- `/auth` checks the host Claude Code CLI auth state when `claude auth status` is available.

Telegram input:

- Plain text messages become prompts for the selected agent.
- Voice and audio messages are transcribed before being sent to the selected agent.
- Voice transcription uses local `faster-whisper` on Linux, local `parakeet-coreml` on macOS Apple Silicon, or OpenAI Whisper when `OPENAI_API_KEY` is set.
- `/voice` can select backend preference, language, and transcribe-only mode.
- Photo messages are passed to the selected agent as local image input when supported.
- Document messages are downloaded, sanitized, size-checked, and staged under `.nordrelay/inbox/<turn-id>/`.
- Telegram media groups and albums are combined into one agent turn with all photos and documents staged together.
- Uploaded documents include prompt instructions telling the selected agent where files were staged.
- Staged document and photo prompts are persisted so `/retry` and queued execution can replay them after a restart.
- Telegram forum topics are treated as separate work contexts.

Telegram output:

- Assistant replies stream back to Telegram with debounced message edits.
- Telegram `typing` status is sent while the selected agent is working.
- Markdown is converted to Telegram HTML where possible, with fallback to plain text.
- Long replies are split to respect Telegram message limits.
- Tool activity can be displayed as summary, full output, errors only, or hidden with `TOOL_VERBOSITY`.
- Command execution, web search, file changes, MCP tool calls, error items, and todo-list updates are surfaced.
- Todo-list updates are rendered as a live plan/status message.
- Generated artifacts from `.nordrelay/turns/<turn-id>/out/` are retained for manual retrieval with `/artifacts`.
- Workspace files detected after mirrored Codex, Pi, Hermes, OpenClaw, or Claude Code CLI/API turns are indexed as `/artifacts` entries, even when automatic artifact delivery is disabled.
- Automatic artifact summaries and file uploads are disabled by default; set `TELEGRAM_AUTO_SEND_ARTIFACTS=true` to send them after turns.
- Workspace artifact detection sorts by modification time and supports configurable ignored directories and globs.
- Image artifacts are sent with Telegram previews; large multi-file outputs are bundled into one ZIP when possible.
- `/artifacts` lists recent generated files and can resend the latest or a specific artifact turn.
- `/artifacts` includes inline actions to resend, ZIP, or delete artifact turns.
- `/artifacts images`, `/artifacts docs`, `/artifacts search <text>`, and `/artifacts delete <turn-id>` filter, find, and clean up artifacts from Telegram.
- Old artifact and inbox turn directories are pruned automatically with configurable retention.
- Optional Telegram message reactions can acknowledge work start and completion with `ENABLE_TELEGRAM_REACTIONS=true`.

Authentication and safety:

- WebUI login is required for every dashboard page, API route, SSE stream, artifact download, and health endpoint.
- Access is managed through NordRelay users, groups, permissions, web sessions, and linked Telegram identities.
- Built-in groups are `Admin`, `User`, and `Read Only`; custom groups can be created in the WebUI and can restrict allowed agents, workspace roots, and Telegram chats.
- The last active admin cannot be disabled or demoted, and web sessions are revoked when passwords or group memberships change.
- Admins can review and revoke active WebUI sessions from the Users page.
- Telegram private chats require a linked active NordRelay user.
- Telegram group and forum chats must be registered before use; admins can run `/register_chat` in the chat or enable chats in the WebUI.
- `/whoami` shows the linked NordRelay account and groups.
- `/link <code>` links a Telegram account to a NordRelay user after a link code is created in the WebUI or with `nordrelay user link-code`.
- WebUI login and Telegram link attempts are rate-limited to reduce brute-force risk.
- User, group, Telegram-link, Telegram-chat, web-session, login, and permission-denied events are written to the audit log.
- `/auth` reports Codex authentication, Pi provider environment health, Hermes API Server reachability, OpenClaw Gateway reachability, or Claude Code CLI auth for the selected agent.
- `/login` starts Telegram-managed CLI auth for Codex, Hermes, or Claude Code when enabled.
- `/logout` signs out of CLI auth for Codex, Hermes, or Claude Code; Codex logout is disabled while `CODEX_API_KEY` is in use.
- `CODEX_API_KEY` can be used for host-side Codex authentication.
- Friendly error messages are returned for auth, network, model, rate-limit, timeout, and context-length failures.
- Outgoing Telegram messages and logs redact common token/API-key patterns, with optional custom redaction patterns.
- Workspace allow/warn roots can prevent accidental operation in the wrong project directory.

Operations:

- Plugin command/skill starts, stops, restarts, and inspects the connector process.
- Manual process commands support `start`, `stop`, `restart`, `status`, and `foreground`.
- Telegram admin commands support `/logs`, `/diagnostics`, `/restart`, and `/update` for NordRelay and agent CLIs.
- `/update` detects the install type: npm installs update with `npm install -g @nordbyte/nordrelay@latest`; source checkouts pull `origin/main`, install dependencies, run check, tests, and build, then restart.
- `/update agents`, `/update <agent>`, `/update jobs`, `/update log <id>`, `/update cancel <id>`, and `/update input <id> <text>` manage Codex, Pi, Hermes, OpenClaw, and Claude Code updater jobs from Telegram.
- `/logs` renders redacted connector, NordRelay update, and agent update logs with local-time timestamps, levels, file path, last-modified time, and highlighted warnings/errors.
- Logs can be emitted as timestamped plain text or JSON records with `CONNECTOR_LOG_FORMAT`.
- Telegram sends/edits/documents are routed through a rate-limit queue that honors Telegram retry-after responses.
- Context metadata, queues, and preferences are written atomically with backup recovery.
- Context metadata, queues, preferences, audit events, and locks can use JSON files or the optional SQLite state backend with `NORDRELAY_STATE_BACKEND=sqlite`.
- Runtime config, state, and logs are written under `~/.nordrelay/`.
- `nordrelay init` creates a private runtime config, `nordrelay doctor` validates host prerequisites, and `nordrelay web` starts the connector plus a full local WebUI dashboard.
- The WebUI has responsive header/sidebar/footer navigation, live chat streaming, session controls, queue/artifact/log/diagnostic views, and settings management.
- The WebUI supports light and dark themes, tabbed settings groups, paginated session browsing, and chat uploads for images, documents, and audio transcription.
- The WebUI exposes REST and SSE endpoints for chat streaming, sessions, settings, queue, artifacts, logs, health, and diagnostics.
- The dashboard can bind to `127.0.0.1` or `0.0.0.0`; user login and session cookies are mandatory in both modes.
- Telegram can run with long polling or an HTTP webhook via `TELEGRAM_TRANSPORT=webhook`.
- Version freshness checks are cached with `NORDRELAY_VERSION_CACHE_TTL_MS` to keep `/version` responsive.
- CI includes typecheck, tests, package dry run, npm audit, and a separate secret-scan workflow.
- `npm run dev`, `npm run build`, `npm run check`, `npm test`, `npm start`, `npm stop`, and `npm run status` are available.
- Dockerfile and `docker-compose.yml` are included for containerized operation.
- A `launchd/start.sh` helper is included for host-managed startup.

## First Run Setup

Recommended npm setup:

```bash
npm install -g @nordbyte/nordrelay
nordrelay init
nordrelay user list
nordrelay doctor
nordrelay start
```

npm is the fastest install path and is the recommended default for normal use. `nordrelay init` writes the private runtime config to `~/.nordrelay/nordrelay.env`.

Non-interactive setup is also supported:

```bash
nordrelay init \
  --token 123456789:replace-me \
  --admin-email you@example.com \
  --admin-name "Your Name" \
  --admin-password "replace-with-a-long-password" \
  --telegram-user-id 123456789
```

`--telegram-user-id` is optional, but linking the first admin during setup is the fastest way to use Telegram immediately.

Source checkout setup:

Install dependencies and build the runtime:

```bash
npm install
npm run build
mkdir -p ~/.nordrelay
cp .env.example ~/.nordrelay/nordrelay.env
chmod 600 ~/.nordrelay/nordrelay.env
```

Create the Telegram bot:

1. Open Telegram and talk to `@BotFather`.
2. Run `/newbot`.
3. Choose a display name and bot username.
4. Copy the bot token into `TELEGRAM_BOT_TOKEN` in `~/.nordrelay/nordrelay.env`.
5. Create the first admin user with `nordrelay init` or `nordrelay user create-admin`.
6. Link Telegram from the WebUI, with `nordrelay user link-telegram`, or by creating a link code and sending `/link <code>` to the bot.

Minimal private-bot `~/.nordrelay/nordrelay.env`:

```dotenv
TELEGRAM_BOT_TOKEN=123456789:replace-me
NORDRELAY_CODEX_ENABLED=true
NORDRELAY_PI_ENABLED=false
NORDRELAY_HERMES_ENABLED=false
NORDRELAY_OPENCLAW_ENABLED=false
NORDRELAY_CLAUDE_CODE_ENABLED=false
NORDRELAY_DEFAULT_AGENT=codex
CODEX_SANDBOX_MODE=workspace-write
CODEX_APPROVAL_POLICY=never
```

User and Telegram access management:

- `nordrelay init` creates the first admin user and writes `~/.nordrelay/users.json`.
- `nordrelay user create-admin --email you@example.com --name "Your Name"` creates another admin.
- `nordrelay user create --email dev@example.com --name "Dev" --group user` creates a normal user.
- `nordrelay user link-telegram --email you@example.com --telegram-user-id 123456789` links a Telegram account directly.
- `nordrelay user link-code --email you@example.com` creates a short-lived code that the user sends as `/link <code>` to the bot.
- Group chats are disabled until an admin enables them from the WebUI or runs `/register_chat` inside the group.

Codex authentication:

- Preferred local setup: run `codex login` on the host before starting the connector.
- Remote setup: use `/auth` and `/login` in Telegram if `ENABLE_TELEGRAM_LOGIN=true`.
- API-key setup: set `CODEX_API_KEY`; `/logout` is disabled while `CODEX_API_KEY` is in use.

Pi setup:

- Install Pi from https://pi.dev/ and confirm `pi --help` works on the host.
- npm installs should use the current package name: `npm install -g @earendil-works/pi-coding-agent`.
- Set `NORDRELAY_PI_ENABLED=true` in `~/.nordrelay/nordrelay.env`.
- Keep `NORDRELAY_DEFAULT_AGENT=codex` to start chats in Codex, or set `NORDRELAY_DEFAULT_AGENT=pi` to start chats in Pi.
- Optional: set `PI_SESSION_DIR` if your Pi sessions are not stored in `~/.pi/agent/sessions/`.
- Optional: set `PI_DEFAULT_MODEL=openai-codex/gpt-5.5` and `PI_DEFAULT_THINKING=medium`.

Hermes setup:

- Install Hermes Agent and confirm `hermes --help` works on the host.
- Start the Hermes API Server locally and confirm `GET http://127.0.0.1:8642/health` returns OK.
- Set `NORDRELAY_HERMES_ENABLED=true` in `~/.nordrelay/nordrelay.env`.
- Keep `NORDRELAY_DEFAULT_AGENT=codex` to start chats in Codex, or set `NORDRELAY_DEFAULT_AGENT=hermes` to start chats in Hermes.
- Set `HERMES_API_BASE_URL` if the API Server is not listening on `http://127.0.0.1:8642`.
- Set `HERMES_API_KEY` when the Hermes API Server is protected with `API_SERVER_KEY`.
- Optional: use `/login` or run `hermes login --no-browser` on the host to refresh Hermes provider credentials.
- Optional: set `HERMES_STATE_DB_PATH` if your Hermes session database is not stored at `~/.hermes/state.db`.
- Optional: set `HERMES_DEFAULT_MODEL`, `HERMES_DEFAULT_REASONING`, and `HERMES_DEFAULT_PROFILE`.

OpenClaw setup:

- Install OpenClaw and confirm `openclaw --help` works on the host.
- Start the OpenClaw Gateway and confirm the WebSocket endpoint is reachable.
- Set `NORDRELAY_OPENCLAW_ENABLED=true` in `~/.nordrelay/nordrelay.env`.
- Keep `NORDRELAY_DEFAULT_AGENT=codex` to start chats in Codex, or set `NORDRELAY_DEFAULT_AGENT=openclaw` to start chats in OpenClaw.
- Set `OPENCLAW_GATEWAY_URL` if the Gateway is not listening on `ws://127.0.0.1:18789`.
- Set `OPENCLAW_GATEWAY_TOKEN` or `OPENCLAW_GATEWAY_PASSWORD` when the Gateway requires shared-secret auth.
- Optional: set `OPENCLAW_AGENT_ID` if you want a specific OpenClaw agent instead of `main`.
- Optional: set `OPENCLAW_HOME` or `OPENCLAW_STATE_DIR` if your OpenClaw session state is stored outside `~/.openclaw`.
- Optional: set `OPENCLAW_DEFAULT_MODEL`, `OPENCLAW_DEFAULT_THINKING`, and `OPENCLAW_DEFAULT_PROFILE`.

Claude Code setup:

- Install Claude Code and confirm `claude --help` works on the host, or use the SDK bundled runtime.
- Use `/login` or run `claude auth login` on the host when your Claude Code installation requires local auth.
- Set `NORDRELAY_CLAUDE_CODE_ENABLED=true` in `~/.nordrelay/nordrelay.env`.
- Keep `NORDRELAY_DEFAULT_AGENT=codex` to start chats in Codex, or set `NORDRELAY_DEFAULT_AGENT=claude-code` to start chats in Claude Code.
- Optional: set `CLAUDE_CODE_CLI_PATH` if `claude` is not on `PATH`.
- Optional: set `CLAUDE_CONFIG_DIR` if your Claude Code sessions are not stored under `~/.claude`.
- Optional: set `CLAUDE_CODE_DEFAULT_MODEL`, `CLAUDE_CODE_DEFAULT_EFFORT`, `CLAUDE_CODE_DEFAULT_PROFILE`, and `CLAUDE_CODE_MAX_TURNS`.

Register the local Codex marketplace:

```bash
codex plugin marketplace add ~/projects/nordrelay
```

An example local marketplace entry is available at `docs/nordrelay-marketplace.example.json`. Keep personal `.agents/` marketplace files outside the public repo.

## Running

From Codex, ask:

```text
Starte Telegram Remote
```

Where Codex exposes namespaced plugin commands, this also works:

```text
/nordrelay:remote
```

The command is only a process-manager shortcut; Telegram contains the actual controls.

Manual process commands:

```bash
nordrelay init
nordrelay doctor
nordrelay start
nordrelay status
nordrelay restart
nordrelay stop
nordrelay foreground
nordrelay web
```

Source checkout process commands:

```bash
node plugins/nordrelay/scripts/nordrelay.mjs start
node plugins/nordrelay/scripts/nordrelay.mjs status
node plugins/nordrelay/scripts/nordrelay.mjs restart
node plugins/nordrelay/scripts/nordrelay.mjs stop
node plugins/nordrelay/scripts/nordrelay.mjs foreground
node plugins/nordrelay/scripts/nordrelay.mjs user list
node plugins/nordrelay/scripts/nordrelay.mjs doctor
node plugins/nordrelay/scripts/nordrelay.mjs web
```

NPM shortcuts:

```bash
npm start
npm run status
npm stop
npm run foreground
```

Runtime files:

- PID file: `~/.nordrelay/nordrelay.pid`
- State file: `~/.nordrelay/state.json`
- Log file: `~/.nordrelay/nordrelay.log`
- Home override: `NORDRELAY_HOME=/custom/path`
- Local dashboard: `nordrelay web --host 127.0.0.1 --port 31878`
- `nordrelay start` and `nordrelay status` print the configured WebUI URL.

## WebUI Dashboard

Start the local WebUI:

```bash
nordrelay web
```

If the connector is not already running, `nordrelay web` starts it automatically before binding the dashboard.

Open:

```text
http://127.0.0.1:31878/
```

The dashboard is a second NordRelay client next to Telegram. It can:

- Start a new Codex, Pi, Hermes, OpenClaw, or Claude Code session.
- Start a new session from a modal with agent, workspace, model, reasoning/thinking, fast mode, and launch-profile choices.
- Switch or attach existing sessions, and copy thread IDs from the session list.
- Send prompts and receive streamed text/tool/plan updates through Server-Sent Events.
- Upload images, documents, and audio files from the chat composer. Images are passed as image inputs, documents are staged for the agent, and audio is transcribed through the configured voice backend.
- Keep a persistent per-thread WebUI chat history across page reloads.
- Control the active session model, reasoning/thinking, fast mode, and launch profile directly from the chat view.
- Abort turns, hand sessions back to the native CLI, and inspect the active session.
- Manage queued prompts with pause/resume, run, cancel, reorder buttons, and drag-and-drop prioritization.
- Browse, preview, download, ZIP, and delete artifacts.
- Inspect the activity timeline for WebUI and mirrored CLI turns.
- Edit all supported runtime settings from tabbed Settings groups with option selects, validation feedback, and restart actions.
- View filtered connector/update/agent-update logs, structured diagnostics, enabled channels, and agent adapters.
- Inspect a per-agent capability matrix showing model, reasoning, launch, fast mode, attachments, activity, usage, auth, login/logout, and handback support.
- Check NordRelay and agent CLI versions, then start Codex, Pi, Hermes, OpenClaw, or Claude Code updates from outdated version rows with live output, cancel, delete-log, and stdin response controls for interactive updaters.
- Build dashboard CSS and client JavaScript from modular source assets through esbuild, then serve them as authenticated static assets instead of inline HTML.

Dashboard API endpoints are served under `/api/*`. Streaming uses `GET /api/events`.

Dashboard auth:

```dotenv
NORDRELAY_DASHBOARD_HOST=127.0.0.1
NORDRELAY_DASHBOARD_PORT=31878
```

The dashboard always requires NordRelay email/password login. Login cookies use `SameSite=Strict`, and every dashboard route, API endpoint, SSE stream, artifact download, and health endpoint requires an authenticated active user with the matching permission.

Webhook mode:

```dotenv
TELEGRAM_TRANSPORT=webhook
TELEGRAM_WEBHOOK_URL=https://relay.example
TELEGRAM_WEBHOOK_HOST=127.0.0.1
TELEGRAM_WEBHOOK_PORT=8080
TELEGRAM_WEBHOOK_PATH=/telegram/webhook
TELEGRAM_WEBHOOK_SECRET=replace-with-random-secret
```

Run NordRelay behind your reverse proxy so the public URL forwards to `http://127.0.0.1:8080/telegram/webhook`. Dashboard health checks are available to authenticated WebUI sessions through `/healthz` and `/api/health`.

## Telegram Commands

- `/start` shows welcome text and the selected launch profile.
- `/help` shows the grouped command reference.
- `/channels` shows available and planned messaging adapters.
- `/agents` shows available and planned coding-agent adapters.
- `/agent` selects the active agent for this Telegram context.
- `/link <code>` links the Telegram account to a NordRelay user.
- `/whoami` shows the linked NordRelay user, groups, and permissions.
- `/register_chat` enables the current Telegram group or forum chat for NordRelay when the linked user has user-management permission.
- `/new` starts a new thread. If the selected agent knows multiple workspaces, Telegram shows a workspace picker.
- `/session` shows current thread details.
- `/sessions` opens a paginated recent-session picker.
- `/sessions <query>` searches recent sessions.
- `/sync` syncs the active session from local CLI state when supported.
- `/pinned` opens a pinned-thread picker.
- `/pin [thread-id]` pins a thread for this Telegram context; defaults to the active thread.
- `/unpin [thread-id]` unpins a thread for this Telegram context; defaults to the active thread.
- `/switch <session-id>` switches directly to a known session.
- `/attach <session-id>` binds a known session to the current chat or forum topic.
- `/handback` detaches the active session and prints the native CLI resume command.
- `/retry` resends the last prompt for this Telegram context.
- `/queue` shows queued prompts for this Telegram context with inline run/top/up/down/cancel buttons.
- `/queue pause` pauses automatic queued prompt execution.
- `/queue resume` resumes automatic queued prompt execution.
- `/queue later <minutes> <prompt>` schedules a prompt for later execution.
- `/queue inspect <queue-id>` shows one queued prompt with created time, schedule time, attempts, and last error.
- `/queue move <queue-id> top|up|down` changes queued prompt priority.
- `/queue run <queue-id>` resumes the queue and runs that prompt next when the session is idle.
- Queued prompt replies include a cancel button while the prompt is still waiting.
- `/cancel <queue-id>` removes one queued prompt; the queue id is the short code shown in messages such as `Queued prompt 332kmt`.
- `/clearqueue` clears queued prompts for this Telegram context.
- `/activity [all|tools|errors|user|agent|tasks] [limit] [since 1h] [export]` shows or exports rollout activity for the active thread.
- `/audit [limit]` shows recent audit events. Requires `audit.read`.
- `/lock` locks writes for this Telegram session to the current user.
- `/unlock` releases the current session write lock.
- `/locks` lists active write locks.
- `/artifacts [latest|zip latest|turn-id|images|docs|search <text>|delete <turn-id>]` lists, filters, resends, zips, searches, or deletes generated artifacts for the current workspace.
- `/workspaces` lists workspaces known to the selected agent and allowed by the workspace policy.
- `/abort` cancels the current operation.
- `/stop` is an alias for `/abort`.
- `/launch_profiles` or `/launch` opens the launch profile picker.
- `/fast [on|off]` toggles Codex fast mode. Without an argument it flips the current state.
- `/model` opens the model picker.
- `/reasoning` opens the selected agent's reasoning or thinking picker.
- `/effort` is a backward-compatible alias for `/reasoning`.
- `/mirror [off|status|final|full]` controls local CLI mirroring for this Telegram context.
- `/notify [off|minimal|all]` controls Telegram notifications.
- `/notify quiet HH-HH` sets quiet hours; `/notify quiet off` disables them.
- `/auth` reports Codex authentication status, Pi provider environment health, Hermes API Server reachability, OpenClaw Gateway reachability, or Claude Code CLI auth for the selected agent.
- `/login` starts Telegram-initiated CLI login for Codex, Hermes, or Claude Code when one of those agents is selected.
- `/logout` signs out from CLI auth for Codex, Hermes, or Claude Code when one of those agents is selected; Codex logout is disabled while `CODEX_API_KEY` is active.
- `/voice` reports voice transcription backends and current voice preferences.
- `/voice backend auto|parakeet|faster-whisper|openai` selects backend preference.
- `/voice language auto|<code>` selects transcription language.
- `/voice transcribe_only on|off` controls whether voice is only transcribed or also sent to the selected agent.
- `/tasks` or `/progress` reports the current turn and queue progress.
- `/status` reports connector runtime status.
- `/health` reports runtime health, auth, PIDs, Codex CLI, Pi CLI, Hermes CLI, OpenClaw CLI, Claude Code CLI, and state DB.
- `/version` reports connector, Codex CLI, Pi CLI, Hermes CLI, OpenClaw CLI, and Claude Code CLI paths plus installed/latest NordRelay, Codex, Pi, Hermes, OpenClaw, and Claude Code versions with status icons.
- `/logs [lines]` shows a redacted, timestamped connector log tail. Requires `logs.read`.
- `/logs update [lines]` shows the self-update log. Requires `logs.read`.
- `/logs agent [lines]` shows the aggregate agent updater log. Requires `logs.read`.
- `/logs all [lines]` shows connector, self-update, and agent update logs together. Requires `logs.read`.
- `/diagnostics` shows redacted connector diagnostics. Requires `logs.read`.
- `/restart` restarts the connector process. Requires `system.restart`.
- `/update` updates through npm or git depending on the detected install type, then restarts only on success. Requires `updates.run`.
- `/update agents`, `/update <agent>`, `/update jobs`, `/update log <id>`, `/update cancel <id>`, and `/update input <id> <text>` manage agent CLI update jobs. Requires `updates.run`.

## Command Examples

Switching to an existing thread:

```text
/sessions
```

Tap a listed thread/session. The connector imports workspace, model, reasoning/thinking, and provider-specific metadata from the selected agent.

Direct session switch:

```text
/switch 019e178a-f275-7d01-95d6-c244ff3e30ed
```

Attach an existing CLI session to the current Telegram topic:

```text
/attach 019e178a-f275-7d01-95d6-c244ff3e30ed
```

Hand a session back to the native CLI:

```text
/handback
```

The bot replies with a command like:

```bash
cd ~/projects/my-workspace && codex resume 019e178a-f275-7d01-95d6-c244ff3e30ed
```

For Pi sessions the command looks like:

```bash
cd ~/projects/my-workspace && pi --session ~/.pi/agent/sessions/.../session.jsonl
```

For Hermes sessions the command looks like:

```bash
cd ~/projects/my-workspace && hermes --resume 20260512_181422_ab12cd34
```

For OpenClaw sessions the command looks like:

```bash
cd ~/projects/my-workspace && openclaw agent --agent main --session-id nordrelay-openclaw-a1b2c3d4e5f6 --message '<your next message>'
```

For Claude Code sessions the command looks like:

```bash
cd ~/projects/my-workspace && claude --resume 019e178a-f275-7d01-95d6-c244ff3e30ed
```

Change model:

```text
/model
```

Tap the model to use for new or reattached threads.

Change reasoning effort:

```text
/reasoning
```

For Codex choose one of `minimal`, `low`, `medium`, `high`, or `xhigh`. For Pi choose one of `off`, `minimal`, `low`, `medium`, `high`, or `xhigh`. For Hermes choose one of `none`, `minimal`, `low`, `medium`, `high`, or `xhigh`. For OpenClaw choose one of `off`, `minimal`, `low`, `medium`, `high`, or `xhigh`. For Claude Code choose one of `off`, `low`, `medium`, `high`, or `xhigh`.

Toggle fast mode:

```text
/fast
/fast on
/fast off
```

Fast mode maps to launch profiles: `on` selects an approval policy of `never`, while `off` selects an approval-requesting profile such as Review. If a thread is idle, `/fast` reattaches the current thread with the selected launch behavior immediately.

Choose launch profile:

```text
/launch_profiles
```

Tap the profile. Unsafe profiles require confirmation before they become active.

## File, Photo, Voice, and Artifact Workflow

Text:

- Any non-command text message becomes a prompt for the selected agent.
- While the selected agent works, Telegram shows `typing`.
- Replies stream back into the same chat or topic.

Photos:

- Send a photo with or without a caption.
- The connector downloads it and passes it to the selected agent as local image input.
- The caption becomes the text prompt when present.
- Sending multiple photos as a Telegram album creates one combined agent prompt.

Documents:

- Send a document with or without a caption.
- The connector downloads it, sanitizes the filename, enforces `MAX_FILE_SIZE`, and stages it under:

```text
<workspace>/.nordrelay/inbox/<turn-id>/
```

- The selected agent receives prompt instructions with the staged file paths.
- The caption becomes the text prompt when present.
- Document albums and mixed media groups are processed as one turn; oversized files are skipped and reported.

Artifacts:

- For generated files that should be returned to Telegram, tell the selected agent to write them to:

```text
<workspace>/.nordrelay/turns/<turn-id>/out/
```

- The connector stores files in that directory and keeps them available for `/artifacts`.
- Automatic Telegram artifact delivery is off by default. Set `TELEGRAM_AUTO_SEND_ARTIFACTS=true` to collect and send files right after a turn.
- When automatic delivery or explicit `/artifacts` sending is used, image outputs are sent with Telegram previews and other outputs are sent as documents.
- When more than five artifacts are sent, the connector tries to send one ZIP bundle instead of many separate files.
- Use `/artifacts` to list recent artifact turns with inline Send/ZIP/Delete actions.
- Use `/artifacts latest`, `/artifacts zip latest`, or `/artifacts <turn-id>` from text commands.
- Use `/artifacts images`, `/artifacts docs`, or `/artifacts search <text>` to narrow large artifact histories.
- Use `/artifacts delete <turn-id>` to delete an artifact turn without opening the inline confirmation flow.
- Telegram file delivery is capped at the configured `MAX_FILE_SIZE` per artifact or ZIP bundle.
- Old turn and inbox directories are pruned automatically to keep workspace state compact.

Voice and audio:

- Send a Telegram voice note or audio file.
- The connector transcribes it, then sends the transcript to the selected agent.
- Local transcription is tried first with `parakeet-coreml` or `faster-whisper` when installed.
- OpenAI Whisper is used when `OPENAI_API_KEY` is set.

Voice prerequisites:

```bash
# macOS Apple Silicon
brew install ffmpeg
npm install parakeet-coreml
```

```bash
# Debian/Ubuntu
sudo apt-get install ffmpeg
python3 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install faster-whisper
```

```dotenv
FASTER_WHISPER_PYTHON=.venv/bin/python
FASTER_WHISPER_MODEL=base
FASTER_WHISPER_COMPUTE_TYPE=int8
```

Whisper fallback:

```dotenv
OPENAI_API_KEY=sk-...
```

Voice transcription uses `OPENAI_API_KEY`, not `CODEX_API_KEY`.

## Environment Reference

Telegram:

- `TELEGRAM_BOT_TOKEN`: required BotFather token.
- `TELEGRAM_RATE_LIMIT_MIN_INTERVAL_MS`: minimum interval for normal Telegram API sends. Defaults to `80`.
- `TELEGRAM_EDIT_MIN_INTERVAL_MS`: minimum interval for Telegram message edits. Defaults to `1200`.
- `TELEGRAM_TRANSPORT`: `polling` or `webhook`. Defaults to `polling`.
- `TELEGRAM_WEBHOOK_URL`: public base URL for webhook mode, for example `https://relay.example`.
- `TELEGRAM_WEBHOOK_HOST`: local bind host for webhook mode. Defaults to `127.0.0.1`.
- `TELEGRAM_WEBHOOK_PORT`: local bind port for webhook mode. Defaults to `8080`.
- `TELEGRAM_WEBHOOK_PATH`: webhook request path. Defaults to `/telegram/webhook`.
- `TELEGRAM_WEBHOOK_SECRET`: optional Telegram webhook secret token.
- `TELEGRAM_CLI_MIRROR_MODE`: default CLI mirror mode: `off`, `status`, `final`, or `full`. Defaults to `status`.
- `TELEGRAM_CLI_MIRROR_MIN_UPDATE_MS`: minimum interval for mirrored CLI status edits. Defaults to `4000`.
- `TELEGRAM_NOTIFY_MODE`: default notification mode: `off`, `minimal`, or `all`. Defaults to `minimal`.
- `TELEGRAM_QUIET_HOURS`: optional quiet-hour range in `HH-HH` format, for example `22-7`.
- `TELEGRAM_REDACT_PATTERNS`: comma-separated regular expressions for additional Telegram/log redaction.

User management:

- Users, groups, Telegram identities, Telegram group-chat access, and web sessions are stored in `~/.nordrelay/users.json`.
- Manage users in the WebUI Users page or with `nordrelay user list`, `create-admin`, `create`, `reset-password`, `link-telegram`, and `link-code`.
- Built-in groups are `admin`, `user`, and `readonly`.
- Group permissions include `inspect`, `sessions.read`, `sessions.write`, `prompt.send`, `prompt.abort`, `files.read`, `files.write`, `settings.read`, `settings.write`, `auth.manage`, `diagnostics.read`, `logs.read`, `logs.clear`, `queue.read`, `queue.write`, `updates.run`, `system.restart`, `users.read`, `users.write`, and `audit.read`.
- Custom groups can also restrict access to specific agent ids, workspace roots, and Telegram chat ids.

Agent selection:

- `NORDRELAY_CODEX_ENABLED`: enables Codex contexts. Defaults to `true`.
- `NORDRELAY_PI_ENABLED`: enables Pi contexts. Defaults to `false`.
- `NORDRELAY_HERMES_ENABLED`: enables Hermes contexts through the Hermes API Server. Defaults to `false`.
- `NORDRELAY_OPENCLAW_ENABLED`: enables OpenClaw contexts through the OpenClaw Gateway. Defaults to `false`.
- `NORDRELAY_CLAUDE_CODE_ENABLED`: enables Claude Code contexts through the Claude Agent SDK. Defaults to `false`.
- `NORDRELAY_DEFAULT_AGENT`: `codex`, `pi`, `hermes`, `openclaw`, or `claude-code`, used for new Telegram contexts. Defaults to the first enabled agent.
- `NORDRELAY_STATE_BACKEND`: `json` or `sqlite`. JSON is the default; SQLite requires `better-sqlite3`.
- `NORDRELAY_AUDIT_MAX_EVENTS`: maximum audit events retained. Defaults to `1000`.
- `NORDRELAY_SESSION_LOCK_TTL_MS`: session write-lock TTL. Defaults to `1800000`.
- `NORDRELAY_VERSION_CACHE_TTL_MS`: npm version freshness cache TTL. Defaults to `3600000`; set `0` to disable.

Dashboard:

- `NORDRELAY_DASHBOARD_HOST`: dashboard bind host. Defaults to `127.0.0.1`.
- `NORDRELAY_DASHBOARD_PORT`: dashboard bind port. Defaults to `31878`.
- `NORDRELAY_ENV_FILE`: optional explicit env-file path used by the wrapper and edited by the dashboard settings page. Defaults to `~/.nordrelay/nordrelay.env`.

Codex:

- `CODEX_API_KEY`: optional API key for Codex SDK auth.
- `CODEX_CLI_PATH`: optional explicit path to the Codex CLI executable.
- `CODEX_USE_BUNDLED_CLI`: set `true` to force the SDK-bundled Codex CLI instead of the host `codex` executable.
- `CODEX_MODEL`: default model for new threads.
- `CODEX_SYNC_INTERVAL_MS`: periodic local Codex-state sync interval for active Telegram sessions. Defaults to `10000`; set `0` to disable.
- `CODEX_EXTERNAL_BUSY_CHECK_MS`: how often queued Telegram prompts re-check an active local Codex CLI task. Defaults to `5000`.
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
- `ARTIFACT_RETENTION_DAYS`: artifact/inbox turn age before pruning. Defaults to `7`.
- `ARTIFACT_MAX_TURNS`: maximum artifact turn directories to keep per workspace. Defaults to `30`.
- `ARTIFACT_MAX_INBOX_DIRS`: maximum staged inbox directories to keep per workspace. Defaults to `30`.
- `ARTIFACT_IGNORE_DIRS`: comma-separated extra directory names or relative paths ignored during workspace artifact scans.
- `ARTIFACT_IGNORE_GLOBS`: comma-separated glob patterns ignored during workspace artifact scans.
- `TELEGRAM_AUTO_SEND_ARTIFACTS`: automatically post generated artifact summaries/files after Telegram turns and mirrored CLI turns. Defaults to `false`.

Workspace policy:

- `WORKSPACE_ALLOWED_ROOTS`: comma-separated root directories allowed for session switching and workspace selection. Empty means unrestricted.
- `WORKSPACE_WARN_ROOTS`: comma-separated broad roots that should be allowed but warned about in `/session` and `/workspaces`.

Auth and voice:

- `ENABLE_TELEGRAM_LOGIN`: enables `/login` and `/logout`. Defaults to `true`.
- `FASTER_WHISPER_PYTHON`: Python executable for local Linux voice transcription. Example: `.venv/bin/python`.
- `FASTER_WHISPER_MODEL`: faster-whisper model name. Defaults to `base`.
- `FASTER_WHISPER_DEVICE`: faster-whisper device. Defaults to `cpu`.
- `FASTER_WHISPER_COMPUTE_TYPE`: faster-whisper compute type. Defaults to `int8`.
- `FASTER_WHISPER_LANGUAGE`: optional fixed transcription language.
- `FASTER_WHISPER_TIMEOUT_MS`: local transcription timeout. Defaults to `600000`.
- `OPENAI_API_KEY`: enables Whisper transcription fallback for voice/audio.
- `VOICE_PREFERRED_BACKEND`: `auto`, `parakeet`, `faster-whisper`, or `openai`. Defaults to `auto`.
- `VOICE_DEFAULT_LANGUAGE`: optional default language code, for example `de` or `en`.
- `VOICE_TRANSCRIBE_ONLY`: when `true`, voice/audio messages are transcribed but not sent to the selected agent.

NordRelay wrapper:

- `NORDRELAY_HOME`: config/state/log directory override. Defaults to `~/.nordrelay`.
- `NORDRELAY_SOURCE_ROOT`: runtime source root override. Useful when the plugin is launched from Codex cache.
- `NORDRELAY_UPDATE_METHOD`: optional `auto`, `npm`, or `git` self-update method override. Auto uses git when the runtime root has a `.git` directory and npm otherwise.
- Agent updates from the dashboard and Telegram use each agent's native updater where possible: `codex update`, `pi update pi`, `hermes update --yes`, `openclaw update --yes`, and `claude update`.
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

Unsafe profiles are intentionally gated. Telegram asks for confirmation before applying them.

## Security Notes

- Create the first admin user during setup and keep that account protected with a strong password.
- Link Telegram accounts only to active NordRelay users that should control agents remotely.
- Enable Telegram group/forum chats only when the whole chat context is trusted for the permissions granted to linked users.
- Review group permissions before granting `prompt.send`, `prompt.abort`, `files.write`, `settings.write`, `updates.run`, `system.restart`, or `users.write`.
- Treat `danger-full-access` as equivalent to shell access on the host.
- Treat uploaded files as untrusted input. They are staged inside the active workspace so the selected sandbox policy still matters.
- Keep `CODEX_API_KEY`, `HERMES_API_KEY`, `OPENCLAW_GATEWAY_TOKEN`, `OPENCLAW_GATEWAY_PASSWORD`, and `OPENAI_API_KEY` in `~/.nordrelay/nordrelay.env` or host secret management.
- In group chats, remember that any linked user with prompt permissions can prompt the selected agent in that chat context.
- Use `TOOL_VERBOSITY=summary` or `errors-only` when command output may include sensitive data.
- Review and unsafe launch profiles add a Telegram approve/deny gate before each turn starts.

## Troubleshooting

Polling conflict:

- Symptom: Telegram reports conflict or only one connector receives messages.
- Cause: the same bot token is being polled by another process.
- Fix: stop the other process or run `npm stop`, then `npm start`.

Stale plugin cache:

- Symptom: Codex uses old command or skill text after a repo update.
- Fix: reinstall/update the local marketplace or copy the plugin directory into the Codex plugin cache.
- Current local cache path: `~/.codex/plugins/cache/nordrelay-local/nordrelay/<version>/`.

Missing dependencies:

- Symptom: startup says runtime is missing.
- Fix:

```bash
npm install
npm run build
```

Auth failures:

- Symptom: prompt execution says Codex is not authenticated.
- Fix: run `codex login` on the host, use `/login`, or set `CODEX_API_KEY`.
- Use `/auth` to check the current auth method.

No sessions listed:

- Symptom: `/sessions` says no recent threads found.
- Cause for Codex: `~/.codex/state_*.sqlite` is missing, unreadable, or has no active threads.
- Cause for Pi: `~/.pi/agent/sessions/` or `PI_SESSION_DIR` is missing, unreadable, or has no session JSONL files.
- Cause for Hermes: `~/.hermes/state.db` or `HERMES_STATE_DB_PATH` is missing, unreadable, or has no session rows.
- Cause for OpenClaw: `openclaw sessions --all-agents --json` returns no sessions, or `OPENCLAW_HOME`/`OPENCLAW_STATE_DIR` points at the wrong state location.
- Cause for Claude Code: `~/.claude/projects/` or `CLAUDE_CONFIG_DIR/projects` is missing, unreadable, or has no session JSONL files.
- Fix: run the selected agent locally once, resume or create a session, then try `/sessions` again.

Wrong model, reasoning, or fast mode after switching:

- The connector reads model, reasoning, workspace, sandbox, and approval metadata from supported local agent state on `/sessions`, `/switch`, `/attach`, and `/session`; Codex fast mode is read from `~/.codex/config.toml`.
- For Pi, the connector reads model/thinking from Pi JSONL sessions and refreshes active RPC state when a session is running.
- For Hermes, the connector reads model, reasoning, token usage, and message activity from Hermes `state.db`; `/model` and `/reasoning` values are sent with future API runs.
- For OpenClaw, the connector reads model, thinking, token usage, and activity from OpenClaw session state; `/model` and `/reasoning` values are sent with future Gateway runs.
- For Claude Code, the connector reads model, effort, token usage, and activity from Claude Code transcript JSONL files; `/model` and `/reasoning` values are sent with future SDK runs.
- If values look stale, make sure the selected local CLI has finished writing session state.

Pi not available:

- Symptom: `/agent` cannot switch to Pi, or startup says Pi CLI is missing.
- Fix: install Pi from https://pi.dev/, ensure `pi` is on `PATH`, or set `PI_CLI_PATH`.
- Enable Pi with `NORDRELAY_PI_ENABLED=true`.

Hermes not available:

- Symptom: `/agent` cannot switch to Hermes, `/auth` fails, or prompt execution says the Hermes API request failed.
- Fix: start the Hermes API Server, ensure `HERMES_API_BASE_URL` points to it, and set `HERMES_API_KEY` if the server requires a key.
- Enable Hermes with `NORDRELAY_HERMES_ENABLED=true`.

OpenClaw not available:

- Symptom: `/agent` cannot switch to OpenClaw, `/auth` fails, or prompt execution says the OpenClaw Gateway request failed.
- Fix: start the OpenClaw Gateway, ensure `OPENCLAW_GATEWAY_URL` points to it, and set `OPENCLAW_GATEWAY_TOKEN` or `OPENCLAW_GATEWAY_PASSWORD` if the Gateway requires shared-secret auth.
- Enable OpenClaw with `NORDRELAY_OPENCLAW_ENABLED=true`.

Claude Code not available:

- Symptom: `/agent` cannot switch to Claude Code, `/auth` fails, or prompt execution says Claude Code auth is missing.
- Fix: run `claude auth login` on the host, ensure `claude` is on `PATH`, or set `CLAUDE_CODE_CLI_PATH`.
- Enable Claude Code with `NORDRELAY_CLAUDE_CODE_ENABLED=true`.

Voice not working:

- Run `/voice` to list available backends.
- Install `ffmpeg` and `faster-whisper` on Linux, install `parakeet-coreml` on macOS Apple Silicon, or set `OPENAI_API_KEY`.
- Check `~/.nordrelay/nordrelay.log` for transcription errors.

Files not returned:

- Ensure Codex writes generated files to `.nordrelay/turns/<turn-id>/out/`.
- Files over 50 MB are skipped.
- Hidden files, temp files, and directories are ignored.
- Use `ARTIFACT_IGNORE_DIRS` and `ARTIFACT_IGNORE_GLOBS` to suppress project-specific build/cache output.
- Automatic artifact sending stays off unless `TELEGRAM_AUTO_SEND_ARTIFACTS=true`; `/artifacts` can still list and resend indexed outputs.

## Deployment

Foreground debugging:

```bash
npm run foreground
```

Background process:

```bash
npm start
npm run status
npm stop
```

Docker Compose:

```bash
docker compose up -d --build
docker compose logs -f
docker compose down
```

The compose file mounts:

- `${HOME}/.codex` into the container for Codex auth and thread state.
- `./workspace` as `/workspace` for container workspaces.

launchd helper:

```bash
NORDRELAY_SOURCE_ROOT=~/projects/nordrelay launchd/start.sh
```

Linux systemd example:

```ini
[Unit]
Description=NordRelay
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/nordrelay
Environment=NORDRELAY_SOURCE_ROOT=/opt/nordrelay
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Build before starting a service:

```bash
npm install
npm run build
```

## Architecture

- `plugins/nordrelay/`: Codex plugin bundle with manifest, skill, command, icon, and process wrapper.
- `plugins/nordrelay/scripts/nordrelay.mjs`: process manager for `start`, `stop`, `restart`, `status`, and `foreground`.
- `src/index.ts`: runtime entrypoint, config load, auth check, state-file writes, polling lifecycle, shutdown.
- `src/bot.ts`: Telegram prompt/session runtime, streaming, file/photo/voice handling, artifacts, and error handling.
- `src/telegram-access-commands.ts`, `src/telegram-update-commands.ts`, and `src/telegram-command-menu.ts`: focused Telegram command groups for access linking, update jobs, and command menu registration.
- `src/channel-adapter.ts`, `src/channel-runtime.ts`, and `src/channel-actions.ts`: channel descriptors, generic command routing, outbound delivery contracts, and channel-neutral command responses.
- `src/config-metadata.ts`: shared setting metadata used by the WebUI settings page and generated `.env.example`.
- `src/webui/`: focused WebUI source assets for core runtime state/API helpers, overview rendering, live events, chat/session workflows, admin pages, and CSS sections.
- `src/bot-preferences.ts`: per-context mirror, notification, quiet-hour, and voice preference persistence.
- `src/telegram-rate-limit.ts`: centralized Telegram API send/edit/document rate limiting and retry-after tracking.
- `src/persistence.ts`: atomic JSON/text writes with backup recovery.
- `src/redaction.ts`: common secret redaction and custom redaction pattern support.
- `src/workspace-policy.ts`: workspace allow/warn root evaluation.
- `src/access-control.ts`: user/group permission definitions and command/callback/WebUI permission mapping.
- `src/codex-session.ts`: Codex SDK service for new/resumed threads, streaming events, abort, model, reasoning, launch profiles, and handback.
- `src/pi-session.ts`: Pi RPC service for JSONL RPC sessions, streaming events, abort, model, thinking, launch profiles, and handback.
- `src/hermes-session.ts`: Hermes API Server service for streamed runs, stop, model, reasoning, launch profiles, attachments, and handback.
- `src/openclaw-session.ts`: OpenClaw Gateway service for streamed runs, cancel, model, thinking, launch profiles, attachments, and handback.
- `src/claude-code-session.ts`: Claude Agent SDK service for streamed runs, abort, model, effort, launch profiles, attachments, and handback.
- `src/session-registry.ts`: per-chat/topic session registry and persisted context metadata.
- `test/agent-adapter-contract.test.ts`: shared adapter contract coverage for descriptors, capability flags, reasoning options, launch profiles, and `AgentSessionService` method parity.
- `src/session-format.ts`: compact Telegram rendering for session details, token usage, and limits.
- `src/codex-state.ts`: reader for Codex `~/.codex/state_*.sqlite` thread, workspace, model, reasoning, sandbox, and approval metadata.
- `src/pi-state.ts`: reader for Pi session JSONL files, activity timelines, diagnostics, and external busy detection.
- `src/hermes-state.ts`: reader for Hermes `state.db` sessions, messages, token usage, activity timelines, diagnostics, and external busy detection.
- `src/hermes-api.ts`: Hermes API Server client for health, capabilities, models, runs, events, approvals, and stop.
- `src/openclaw-state.ts`: reader for OpenClaw session metadata, token usage, activity timelines, diagnostics, and external busy detection.
- `src/openclaw-gateway.ts`: OpenClaw Gateway WebSocket RPC client for health, models, runs, stream events, and cancel.
- `src/claude-code-state.ts`: reader for Claude Code transcript JSONL files, token usage, activity timelines, diagnostics, and external busy detection.
- `src/attachments.ts`: inbound file staging and artifact output path construction.
- `src/artifacts.ts`: generated artifact discovery, ZIP bundling, retention, and Telegram delivery filtering.
- `src/voice.ts`: audio decoding and transcription backend selection.
- `src/format.ts`: Telegram-safe HTML formatting and markdown conversion.
- `src/error-messages.ts`: user-facing error translation.
