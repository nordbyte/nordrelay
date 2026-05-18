# Features

## Session Control

- Independent coding-agent sessions per Telegram private chat, group chat, forum topic, Discord DM/channel/thread, Slack DM/channel/thread, WebUI, and peer target.
- `/agent` switches a chat context between enabled agents such as Codex, Pi, Hermes, OpenClaw, and Claude Code.
- Persistent channel context metadata in the active workspace under `.nordrelay/contexts.json`.
- `/new` starts a fresh thread, with workspace selection when known workspaces are available.
- New sessions can run in the shared workspace, in an isolated Git worktree, or as an attached/manual CLI session. The WebUI Sessions page has a Worktrees tab for committing per-session changes and merging selected session branches into an integration worktree.
- `/session` shows thread id, workspace, launch profile, launch behavior, model, reasoning, fast mode, context usage, token totals, and subscription limit remaining percentages.
- `/sessions` opens a paginated browser for recent sessions from the selected agent.
- `/sessions <query>` filters recent sessions by id, title, workspace, model, or first message.
- `/sync` manually refreshes the active chat session from local CLI state when the selected agent supports state watching.
- `/pin`, `/unpin`, and `/pinned` keep important threads at the top of Telegram session browsing.
- `/switch <session-id>` switches directly to an existing session.
- `/attach <session-id>` binds an existing agent session to the current chat or topic.
- Existing thread metadata is imported on switch/attach, including model, reasoning effort, sandbox mode, and approval policy.
- Codex session usage is read from local rollout JSONL files, including context-used percent, total input/output tokens, 5h limit remaining, and weekly limit remaining.
- `/handback` returns a ready-to-run CLI command for continuing in the native agent CLI.
- `/retry` resends the last prompt for the current chat context.
- Prompt templates and multi-step workflows can be created in the WebUI, previewed with variables, run locally or through a selected peer target, and started from Telegram, Discord, or Slack with `/template` and `/workflow`.
- Workflow runs are tracked as unified jobs with step status, trace links, retry/cancel actions, and persisted run history under the active NordRelay state backend.
- `/queue`, inline run/top/up/down/cancel buttons, `/cancel <queue-id>`, and `/clearqueue` manage queued prompts for a busy chat context.
- `/queue later <minutes> <prompt>` schedules a prompt for later execution, and `/queue inspect <queue-id>` shows full queue metadata.
- `/abort`, `/stop`, and the inline Abort button cancel the active agent turn.
- Busy prompts are queued per chat context instead of being dropped.
- If the attached thread is currently active in the local agent CLI, chat prompts are queued until that CLI task finishes.
- Active Codex, Pi, Hermes, OpenClaw, and Claude Code CLI/API turns are mirrored into Telegram, Discord, Slack, and the WebUI with configurable `off`, `status`, `final`, or `full` modes.
- `/mirror` controls CLI mirroring per chat context; the WebUI chat also supports `/mirror [off|status|final|full]` and a Mirror mode picker.
- Queues survive connector restarts and are resumed automatically when the external CLI turn becomes idle.
- `/notify` controls completion/status notifications and quiet hours per chat context.
- `/workspaces` lists allowed workspaces and shows workspace guardrail warnings.
- `/status`, `/health`, and `/version` report connector runtime health from chat adapters.
- `/tasks` and `/progress` show the current turn status, queue length, active tool, elapsed time, and last error.
- `/activity` shows a compact timeline of recent rollout events for the active thread, with filters and export.
- `/diagnostics` reports redacted runtime, config, user/group authorization, channel rate-limit, mirror, voice, session, queue, and progress details.
- `/support` exports a redacted diagnostics ZIP with config, health, versions, agent paths, recent logs, audit events, update jobs, state backend, and OS/Node/npm info.
- `/lock`, `/unlock`, and `/locks` provide a team write-lock for shared sessions so one user can operate while others watch.
- `/audit` shows recent prompt, queue, lock, command, authentication, permission-denied, user, group, Telegram-link, Telegram-chat, Discord-link, Discord-channel, Slack-link, Slack-channel, and web-session audit events for admins.

## Isolated Session Worktrees

- Set `NORDRELAY_SESSION_WORKSPACE_MODE=worktree` to create a dedicated Git worktree and branch for each new NordRelay-started session across WebUI, Telegram, Discord, and Slack.
- The original repository remains unchanged while the session works in its own worktree path under `NORDRELAY_SESSION_WORKTREE_ROOT`.
- Existing CLI-started sessions are treated as attached/manual sessions; NordRelay will not move a running native CLI process into a different worktree.
- Use the WebUI Sessions → Worktrees tab to fork the current session, optionally copy pending tracked/untracked changes, preview diffs, commit a session worktree, update a clean worktree from its base branch, remove it, clean stale records, or merge selected committed worktrees into a generated integration worktree.
- Integration preview shows changed files and flags files touched by multiple selected worktrees before the merge runs. Integration still requires selected worktrees from the same repository and base commit. Merge conflicts are left in the integration worktree for manual resolution.

## Peer-Routed Workflows

- Workflow steps can target `local` or a paired peer. Remote steps prepare the target session on that peer, send the prompt with a correlation ID, and poll the peer trace until the prompt completes or fails.
- Peer workflow execution uses the same peer permissions as WebUI proxy requests. A peer used as a workflow target needs `sessions.read`, `sessions.write`, and `prompt.send`, plus the required agent/workspace access.
- A peer-proxied workflow cannot target another peer, which prevents unapproved relay chaining through a trusted node.

## Adapter Architecture

- Telegram supports text, typing, streaming edits, inline buttons, files, photos, voice, forum topics, and polling/webhook transport.
- Discord supports text, typing, streaming edits, buttons, files, photos, voice/audio transcription, guild channels, threads, DMs, message commands, and slash commands.
- Slack supports text, typing/status, streaming edits, Block Kit buttons, files, images, audio transcription, channels, DMs, threads, Socket Mode, and HTTP Events mode.
- Slack startup and `/diagnostics` include readiness checks for token/transport configuration, registered channels, Slack API auth probes, channel visibility probes, file-upload readiness notes, and rate-limit counters.
- `/channels` shows available and planned messaging adapters for Telegram, Discord, Slack, WhatsApp, and Matrix.
- Codex, Pi, Hermes, OpenClaw, and Claude Code are implemented as agent adapters.
- `/agents` shows available/planned agent adapters and whether Codex, Pi, Hermes, OpenClaw, and Claude Code are enabled.
- Agent and chat adapters expose a shared conformance matrix so command coverage and feature support can be tested and surfaced consistently.
- Shared command-action renderers and a channel runtime contract keep inbound commands, outbound messages, typing, files, inline actions, and streaming-ready delivery separate from channel-specific API calls.

## Peer Federation

- Optional NordRelay-to-NordRelay pairing lets one instance operate agents on trusted Ubuntu, macOS, Windows, LAN, or remote hosts.
- Peer serving is disabled by default and uses a dedicated API port separate from the dashboard.
- Pairing requires an explicit one-time invitation code, Ed25519 node identity verification, a per-peer shared secret, request HMAC signatures, timestamp/nonce replay protection, and TLS fingerprint pinning.
- Peer scopes restrict which remote WebUI/API actions are allowed, including read, prompt, queue, file, diagnostic, log, and session permissions.
- Peer records can also restrict allowed agent ids, allowed workspace roots, and per-peer workspace aliases such as `app=/srv/app`.
- The WebUI has a Peers page plus a local/remote target selector; dashboard pages, SSE streaming, queue actions, artifact downloads, health checks, and the global session browser proxy through the selected peer when allowed.
- Telegram, Discord, and Slack expose `/peers` and `/target` so a linked user can choose whether prompts run locally or on a paired NordRelay instance.
- Remote prompts stream text, tool status, turn completion, and errors back to the originating Telegram, Discord, or Slack context.

## Codex Runtime

- Uses `@openai/codex-sdk` to start, resume, and stream Codex threads.
- Prefers the host `codex` executable on `PATH`, so Codex CLI updates are picked up automatically; the SDK-bundled CLI is used only as fallback.
- Supports model selection through `/model`, using Codex model cache when available and fallback models otherwise.
- Supports reasoning effort selection through `/reasoning` and the backward-compatible `/effort` alias: `minimal`, `low`, `medium`, `high`, `xhigh`.
- Supports launch profiles through `/launch_profiles` and `/launch`.
- Existing idle Codex threads can be reattached with a new launch profile through `/launch <profile-id> apply` or the WebUI Apply to Current action.
- Built-in launch profiles include Default, Read Only, Review, and optional Full Access.
- Custom launch profiles can be configured with `CODEX_LAUNCH_PROFILES_JSON`.
- Unsafe `danger-full-access` profiles require `ENABLE_UNSAFE_LAUNCH_PROFILES=true` and channel confirmation.
- Review or unsafe launch profiles require an inline channel approval before each prompt is executed.
- Fast mode can be toggled with `/fast` and mirrors Codex's `fast_default_opt_out` setting from `~/.codex/config.toml`.
- Active chat sessions periodically sync model, reasoning, workspace, launch metadata, and fast-mode defaults from local agent state where supported.
- Active local Codex CLI tasks are detected from rollout JSONL files so chat adapters do not race the CLI on the same thread.
- `/diagnostics` includes rollout path, activity status, stale/idle reason, line count, and last update time.
- Optional per-turn token usage footer with `SHOW_TURN_TOKEN_USAGE=true`.

## Pi Runtime

- Pi support is opt-in with `NORDRELAY_PI_ENABLED=true`.
- The default chat agent is selected with `NORDRELAY_DEFAULT_AGENT=codex`, `pi`, `hermes`, `openclaw`, or `claude-code`.
- Pi sessions are driven through official `pi --mode rpc` JSONL commands and events.
- Existing Pi sessions are discovered from `~/.pi/agent/sessions/` or `PI_SESSION_DIR`.
- `/sessions`, `/switch`, `/attach`, `/new`, `/session`, `/handback`, `/model`, `/reasoning`, `/abort`, `/stop`, `/retry`, `/queue`, files, photos, and voice input work for Pi contexts.
- Pi model selection uses `pi --list-models` and sends `set_model` through RPC for active sessions.
- Pi thinking levels use `/reasoning` and support `off`, `minimal`, `low`, `medium`, `high`, and `xhigh`.
- Pi token and context stats are read through `get_session_stats` when an RPC session is active.
- Pi launch profiles expose CLI safety modes such as default, read-only tools, no tools, offline, and safe offline.
- Pi external CLI activity is detected from Pi session JSONL files so chat/WebUI prompts queue while the same Pi session is busy.
- Pi CLI turns can be mirrored into chat adapters and the WebUI with status, tool activity, final answers, activity timelines, diagnostics, and generated artifact discovery.
- Pi provider auth checks report the environment variables expected for the selected provider.
- Codex-only subscription limit percentages remain Codex-specific; Pi reports token/context stats when available.

## Hermes Runtime

- Hermes support is opt-in with `NORDRELAY_HERMES_ENABLED=true`.
- The default chat agent can be set with `NORDRELAY_DEFAULT_AGENT=hermes`.
- Hermes turns are executed through the Hermes API Server `/v1/runs` endpoint and streamed through `/v1/runs/{run_id}/events`.
- `/abort` and `/stop` use the Hermes run stop endpoint when a NordRelay-started Hermes run is active.
- Existing Hermes sessions are discovered from `~/.hermes/state.db`, or from `HERMES_STATE_DB_PATH` when configured.
- `/sessions`, `/switch`, `/attach`, `/new`, `/session`, `/handback`, `/model`, `/reasoning`, `/abort`, `/stop`, `/retry`, `/queue`, files, photos, and voice input work for Hermes contexts.
- Hermes model selection uses `/v1/models` when the API Server is reachable and falls back to the selected/default model.
- Hermes reasoning uses `/reasoning` and supports `none`, `minimal`, `low`, `medium`, `high`, and `xhigh`.
- Hermes launch profiles include `default`, `safe`, `readonly`, and `yolo`; profiles map to run instructions and Hermes approval responses.
- Hermes external activity is detected from `state.db`, so chat/WebUI prompts queue while the same Hermes session has an unfinished CLI turn.
- Hermes CLI/API turns can be mirrored into chat adapters and the WebUI with status, tool activity, final answers, activity timelines, diagnostics, and generated artifact discovery.
- `/auth` checks that the Hermes API Server is reachable and that `HERMES_API_KEY` is usable when configured.

## OpenClaw Runtime

- OpenClaw support is opt-in with `NORDRELAY_OPENCLAW_ENABLED=true`.
- The default chat agent can be set with `NORDRELAY_DEFAULT_AGENT=openclaw`.
- OpenClaw turns are executed through the OpenClaw Gateway WebSocket RPC endpoint configured by `OPENCLAW_GATEWAY_URL`.
- `/abort` and `/stop` call the OpenClaw Gateway cancel method when a NordRelay-started OpenClaw run is active.
- Existing OpenClaw sessions are discovered from `openclaw sessions --all-agents --json`, or from the state directory configured with `OPENCLAW_HOME` or `OPENCLAW_STATE_DIR`.
- `/sessions`, `/switch`, `/attach`, `/new`, `/session`, `/handback`, `/model`, `/reasoning`, `/abort`, `/stop`, `/retry`, `/queue`, files, photos, and voice input work for OpenClaw contexts.
- OpenClaw model selection uses the Gateway `models.list` method when reachable and falls back to `openclaw models list --json`.
- OpenClaw thinking uses `/reasoning` and supports `off`, `minimal`, `low`, `medium`, `high`, and `xhigh`.
- OpenClaw launch profiles include `default`, `safe`, `readonly`, `local`, and `deliver`; profiles map to Gateway run flags and additional instructions.
- OpenClaw external activity is detected from OpenClaw session state, so chat/WebUI prompts queue while the same OpenClaw session has an unfinished CLI turn.
- OpenClaw Gateway turns can be mirrored into chat adapters and the WebUI with status, tool activity, final answers, activity timelines, diagnostics, and generated artifact discovery.
- `/auth` checks that the OpenClaw Gateway is reachable and that `OPENCLAW_GATEWAY_TOKEN` or `OPENCLAW_GATEWAY_PASSWORD` is usable when configured.

## Claude Code Runtime

- Claude Code support is opt-in with `NORDRELAY_CLAUDE_CODE_ENABLED=true`.
- The default chat agent can be set with `NORDRELAY_DEFAULT_AGENT=claude-code`.
- Claude Code turns are executed through `@anthropic-ai/claude-agent-sdk`, using the host `claude` executable when available and the SDK bundled runtime otherwise.
- Existing Claude Code sessions are discovered from `~/.claude/projects/`, or from `CLAUDE_CONFIG_DIR/projects` when configured.
- `/sessions`, `/switch`, `/attach`, `/new`, `/session`, `/handback`, `/model`, `/reasoning`, `/abort`, `/stop`, `/retry`, `/queue`, files, photos, and voice input work for Claude Code contexts.
- Claude Code model selection exposes common aliases and model ids; explicit values from existing sessions are preserved.
- Claude Code effort uses `/reasoning` and supports `off`, `low`, `medium`, `high`, and `xhigh`.
- Claude Code launch profiles include `default`, `accept-edits`, `plan`, `readonly`, `no-tools`, and optional `bypass-permissions`.
- Claude Code external activity is detected from transcript JSONL files, so chat/WebUI prompts queue while the same Claude Code session has an unfinished CLI turn.
- Claude Code SDK turns can be mirrored into chat adapters and the WebUI with status, tool activity, final answers, activity timelines, diagnostics, and generated artifact discovery.
- `/auth` checks the host Claude Code CLI auth state when `claude auth status` is available.

## Telegram Input

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

## Telegram Output

- Assistant replies stream back to Telegram with debounced message edits.
- Telegram `typing` status is sent while the selected agent is working.
- Markdown is converted to Telegram HTML where possible, with fallback to plain text.
- Long replies are split to respect Telegram message limits.
- Tool activity can be displayed as summary, full output, errors only, or hidden with `TOOL_VERBOSITY`.
- Command execution, web search, file changes, MCP tool calls, error items, and todo-list updates are surfaced.
- Todo-list updates are rendered as a live plan/status message.
- Generated artifacts from `.nordrelay/turns/<turn-id>/out/` are retained for manual retrieval with `/artifacts`.
- Workspace files detected after mirrored Codex, Pi, Hermes, OpenClaw, or Claude Code CLI/API turns are indexed as `/artifacts` entries, even when automatic artifact delivery is disabled.
- Automatic artifact summaries and file uploads are disabled by default; use `NORDRELAY_ARTIFACT_DELIVERY` plus Telegram/Discord/Slack overrides, per-user preferences, or per-channel settings to control delivery.
- Artifact delivery modes support manual-only, summary, summary with actions, auto-files, auto-zip, images-only, and off.
- Artifact quota and cleanup tools show managed storage usage, warn/over-quota status, cleanup candidates, and retention/quota removals in the WebUI and `/artifacts quota|cleanup` commands.
- The WebUI artifact preview supports text/image previews and Git diffs for workspace artifacts when Git can provide a diff.
- Workspace artifact detection sorts by modification time and supports configurable ignored directories and globs.
- Image artifacts are sent with Telegram previews; large multi-file outputs are bundled into one ZIP when possible.
- `/artifacts` lists recent generated files and can resend the latest or a specific artifact turn.
- `/artifacts` includes inline actions to resend, ZIP, or delete artifact turns.
- `/artifacts images`, `/artifacts docs`, `/artifacts search <text>`, `/artifacts delivery <mode>`, `/artifacts quota`, `/artifacts cleanup preview|run`, and `/artifacts delete <turn-id>` filter, configure, inspect, and clean up artifacts from Telegram, Discord, and Slack.
- Old artifact and inbox turn directories are pruned automatically with configurable retention.
- Optional Telegram message reactions can acknowledge work start and completion with `ENABLE_TELEGRAM_REACTIONS=true`.

## Discord Input and Output

- Enable Discord with `DISCORD_ENABLED=true` and `DISCORD_BOT_TOKEN`. If a requested chat adapter is missing its token, NordRelay disables that adapter and keeps running as long as the WebUI or another chat adapter is usable.
- Set `DISCORD_CLIENT_ID` to let NordRelay register slash commands automatically.
- `DISCORD_COMMAND_MODE=both` supports slash commands and `/command` text messages. Set it to `slash` if the bot should not read message commands.
- `DISCORD_MESSAGE_CONTENT_ENABLED=true` lets regular Discord messages become prompts. The matching privileged intent must also be enabled in the Discord Developer Portal.
- Discord DMs, guild channels, and threads get independent NordRelay contexts.
- Discord attachments are staged like Telegram uploads; images are passed as image inputs and audio files are transcribed before prompting.
- Discord buttons cover session picks, model/reasoning/launch picks, queue actions, artifact actions, update jobs, and abort where Discord component limits allow.
- Discord slash commands mirror the Telegram command surface where Discord supports it: `/agent`, `/auth`, `/login`, `/logout`, `/session`, `/sessions`, `/new`, `/switch`, `/attach`, `/handback`, `/workspaces`, `/pin`, `/unpin`, `/pinned`, `/model`, `/reasoning`, `/fast`, `/launch`, `/launch_profiles`, `/queue`, `/stop`, `/retry`, `/sync`, `/progress`, `/activity`, `/audit`, `/artifacts`, `/logs`, `/version`, `/diagnostics`, `/restart`, `/update`, `/lock`, `/unlock`, `/mirror`, `/notify`, `/voice`, `/link`, `/whoami`, and `/register_channel`.

## Slack Input and Output

- Enable Slack with `SLACK_ENABLED=true`, `SLACK_BOT_TOKEN`, and `SLACK_APP_TOKEN` for Socket Mode. If Socket Mode is disabled, set `SLACK_SIGNING_SECRET` and expose the Slack HTTP receiver.
- `SLACK_MESSAGE_CONTENT_ENABLED=true` lets regular Slack messages become prompts. Keep it disabled if you only want slash-command control.
- Slack DMs, channels, and message threads get independent NordRelay contexts.
- Slack files are staged like Telegram/Discord uploads; images are passed as image inputs and audio files are transcribed before prompting.
- Slack Block Kit buttons cover session picks, model/reasoning/launch picks, queue actions, artifact actions, update jobs, and abort where Slack component limits allow.
- Slack slash/text commands mirror the shared command surface where Slack supports it: `/agent`, `/auth`, `/login`, `/logout`, `/session`, `/sessions`, `/new`, `/switch`, `/attach`, `/handback`, `/workspaces`, `/pin`, `/unpin`, `/pinned`, `/model`, `/reasoning`, `/fast`, `/launch`, `/launch_profiles`, `/queue`, `/stop`, `/retry`, `/sync`, `/progress`, `/activity`, `/audit`, `/artifacts`, `/logs`, `/version`, `/diagnostics`, `/restart`, `/update`, `/lock`, `/unlock`, `/mirror`, `/notify`, `/voice`, `/link`, `/whoami`, and `/register_channel`.

## Authentication and Safety

- WebUI login is required for every dashboard page, API route, SSE stream, artifact download, and health endpoint.
- Access is managed through NordRelay users, groups, permissions, web sessions, linked Telegram identities, linked Discord identities, and linked Slack identities.
- Built-in groups are `Admin`, `User`, and `Read Only`; custom groups can be created in the WebUI and can restrict allowed agents, workspace roots, Telegram chats, Discord channels, and Slack channels.
- The last active admin cannot be disabled or demoted, and web sessions are revoked when passwords or group memberships change.
- Admins can review and revoke active WebUI sessions from the Users page.
- Telegram private chats require a linked active NordRelay user.
- Telegram group and forum chats must be registered before use; admins can run `/register_chat` in the chat or enable chats in the WebUI.
- Discord DMs require a linked active NordRelay user.
- Discord guild channels and threads must be registered before use; admins can run `/register_channel` in the channel or enable channels in the WebUI.
- Slack DMs require a linked active NordRelay user.
- Slack channels and threads must be registered before use; admins can run `/register_channel` in the channel or enable channels in the WebUI.
- `/whoami` shows the linked NordRelay account and groups.
- `/link <code>` links a Telegram account to a NordRelay user after a link code is created in the WebUI or with `nordrelay user link-code`.
- `/link <code>` also links a Discord or Slack account when the code was created for that channel.
- WebUI login and chat-account link attempts are rate-limited to reduce brute-force risk.
- User, group, Telegram-link, Telegram-chat, Discord-link, Discord-channel, Slack-link, Slack-channel, web-session, login, and permission-denied events are written to the audit log.
- `/auth` reports Codex authentication, Pi provider environment health, Hermes API Server reachability, OpenClaw Gateway reachability, or Claude Code CLI auth for the selected agent.
- `/login` starts Telegram-managed CLI auth for Codex, Hermes, or Claude Code when enabled.
- `/logout` signs out of CLI auth for Codex, Hermes, or Claude Code; Codex logout is disabled while `CODEX_API_KEY` is in use.
- `CODEX_API_KEY` can be used for host-side Codex authentication.
- Friendly error messages are returned for auth, network, model, rate-limit, timeout, and context-length failures.
- Outgoing Telegram messages and logs redact common token/API-key patterns, with optional custom redaction patterns.
- Workspace allow/warn roots can prevent accidental operation in the wrong project directory.

## Operations

- Plugin command/skill starts, stops, restarts, and inspects the connector process.
- Manual process commands support `start`, `stop`, `restart`, `status`, `update`, and `foreground`.
- Telegram admin commands support `/logs`, `/diagnostics`, `/support`, `/restart`, and `/update` for NordRelay and agent CLIs.
- `nordrelay peer identity`, `list`, `invite`, `add`, `test`, and `revoke` manage secure peer federation from the CLI.
- `nordrelay update`, `/update`, and the WebUI update button detect the install type: npm installs update with `npm install -g @nordbyte/nordrelay@latest`; source checkouts pull `origin/main`, install dependencies, run check, tests, and build, then restart if the connector is running.
- `/update agents`, `/update <agent>`, `/update install <agent>`, `/update jobs`, `/update log <id>`, `/update cancel <id>`, and `/update input <id> <text>` manage Codex, Pi, Hermes, OpenClaw, and Claude Code updater or installer jobs from Telegram.
- `/logs` renders redacted connector, NordRelay update, and agent update logs with local-time timestamps, levels, file path, last-modified time, and highlighted warnings/errors.
- Logs can be emitted as timestamped plain text or JSON records with `CONNECTOR_LOG_FORMAT`.
- Telegram sends/edits/documents are routed through a rate-limit queue that honors Telegram retry-after responses.
- Mirror, notification, quiet-hour, and automatic artifact-delivery defaults are configured through channel-neutral `NORDRELAY_*` settings, with WebUI, Telegram, Discord, and Slack override keys when a channel should differ.
- The WebUI Tasks page includes a unified Jobs view for active WebUI turns, external CLI turns, queued prompts, agent update/install jobs, self-updates, and diagnostics bundle exports, with log, cancel, and retry actions where supported.
- WebUI prompts, queued jobs, peer-proxied prompts, chat history, activity, audit events, and the Trace page share correlation IDs so a turn can be followed across transport, queue, agent execution, and diagnostics.
- Unified Jobs are persisted across restarts and retain recent prompt, queue, update, connector-update, and support-bundle history for WebUI inspection.
- The WebUI Metrics page reports queue state, active/completed/failed turns, job counts, average prompt duration, and Telegram/Discord/Slack rate-limit counters.
- Expensive dashboard views such as version checks, adapter health, and diagnostics use a short stale-while-refresh server cache so the UI can render recent data while fresh checks run in the background.
- Context metadata, queues, and preferences are written atomically with backup recovery.
- Context metadata, queues, preferences, audit events, and locks can use JSON files or the optional SQLite state backend with `NORDRELAY_STATE_BACKEND=sqlite`.
- Runtime config, state, and logs are written under `~/.nordrelay/`.
- `nordrelay init` creates a private runtime config, `nordrelay doctor` validates host prerequisites, and `nordrelay web` starts the connector plus a full local WebUI dashboard.
- On first WebUI startup without an admin account, NordRelay shows a setup wizard for creating the first admin; remote setup requires the one-time token printed in the server console.
- The WebUI has responsive header/sidebar/footer navigation, live chat streaming, session controls, queue/artifact/log/diagnostic views, and settings management.
- The WebUI supports light and dark themes, tabbed settings groups, paginated session browsing, and chat uploads for images, documents, and audio transcription.
- The WebUI exposes REST and SSE endpoints for chat streaming, sessions, settings, queue, artifacts, logs, health, diagnostics, peers, adapter conformance, and redacted diagnostics bundle export.
- The dashboard can bind to `127.0.0.1` or `0.0.0.0`; user login and session cookies are mandatory in both modes.
- Telegram can run with long polling or an HTTP webhook via `TELEGRAM_TRANSPORT=webhook`.
- Version freshness checks are cached with `NORDRELAY_VERSION_CACHE_TTL_MS`, and installed agent CLI version checks are cached with `NORDRELAY_CLI_VERSION_CACHE_TTL_MS`, to keep `/version` and adapter health responsive.
- CI runs Node 22/24 typecheck and Vitest on Ubuntu, Windows, and macOS first, then gates WebUI browser tests, package smoke, and npm audit behind those faster checks. The security workflow runs secret scanning before dependency audit.
- `npm run dev`, `npm run build`, `npm run check`, `npm test`, `npm run test:e2e`, `npm start`, `npm stop`, and `npm run status` are available.
- Dockerfile and `docker-compose.yml` are included for containerized operation.
- A `scripts/launchd-start.sh` helper is included for host-managed macOS startup.
