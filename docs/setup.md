# Setup and Running

## First Run Setup

Recommended npm setup:

```bash
npm install -g @nordbyte/nordrelay
nordrelay init
nordrelay user list
nordrelay doctor
nordrelay start
```

npm is the fastest install path and is the recommended default for normal use. The same package is available through pnpm and Yarn because both install from the npm registry:

```bash
pnpm dlx @nordbyte/nordrelay init
pnpm add -g @nordbyte/nordrelay
yarn dlx @nordbyte/nordrelay init
```

`nordrelay init` writes the private runtime config to `~/.nordrelay/nordrelay.env`.
If you start `nordrelay web` before creating an admin, the dashboard opens a first-run setup wizard. Remote setup requires the one-time setup token printed in the NordRelay console.

If `nordrelay init` returns `command not found`, check the postinstall warning printed by npm or pnpm. It reports the package-manager global bin directory and the shell profile line needed to add it to `PATH`, for example `export PATH="/opt/homebrew/bin:$PATH"` on macOS/Homebrew installs. `nordrelay doctor` also checks whether the CLI and npm global bin directory are currently visible on `PATH`. Run `nordrelay doctor --fix` to apply safe local fixes such as enabling the WebUI in the env file, adding the npm global bin directory to the shell profile, or rebuilding a source checkout runtime.

Non-interactive setup is also supported:

```bash
nordrelay init \
  --token 123456789:replace-me \
  --enable-discord \
  --discord-token "discord-bot-token" \
  --discord-client-id "discord-client-id" \
  --admin-email you@example.com \
  --admin-name "Your Name" \
  --admin-password "replace-with-a-long-password" \
  --telegram-user-id 123456789
```

`--telegram-user-id` is optional, but linking the first admin during setup is the fastest way to use Telegram immediately.
Use `--discord-user-id <id>` with `nordrelay user create-admin` or `nordrelay user link-discord` to link Discord directly.

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

Create the Discord bot:

1. Open the Discord Developer Portal and create an application.
2. Add a bot user and copy the bot token into `DISCORD_BOT_TOKEN`.
3. Copy the application client ID into `DISCORD_CLIENT_ID`.
4. Enable the Message Content intent if you want regular Discord messages to become prompts.
5. Invite the bot with application-command, message-send, message-read, attachment, and thread permissions.
6. Link Discord from the WebUI, with `nordrelay user link-discord`, or by creating a Discord link code and sending `/link <code>` to the bot.
7. In guild channels, run `/register_channel` once from an admin-linked Discord account.

Create the Slack app:

1. Open Slack API Apps and create a new app for your workspace.
2. Add a bot user and copy the bot token into `SLACK_BOT_TOKEN`.
3. Enable Socket Mode and create an app-level token with `connections:write`; copy it into `SLACK_APP_TOKEN`.
4. Add bot scopes for messages, files, channels, groups, IMs, MPIMs, commands, and chat write access.
5. Create the slash command configured in `SLACK_COMMAND` (default `/nordrelay`) and install the app to your workspace.
6. Link Slack from the WebUI, with `nordrelay user link-slack`, or by creating a Slack link code and sending `/link <code>` to the app.
7. In Slack channels, run `/register_channel` once from an admin-linked Slack account.

Minimal private-bot `~/.nordrelay/nordrelay.env`:

```dotenv
TELEGRAM_BOT_TOKEN=123456789:replace-me
DISCORD_ENABLED=false
DISCORD_BOT_TOKEN=
DISCORD_CLIENT_ID=
SLACK_ENABLED=false
SLACK_BOT_TOKEN=
SLACK_APP_TOKEN=
NORDRELAY_CODEX_ENABLED=true
NORDRELAY_PI_ENABLED=false
NORDRELAY_HERMES_ENABLED=false
NORDRELAY_OPENCLAW_ENABLED=false
NORDRELAY_CLAUDE_CODE_ENABLED=false
NORDRELAY_DEFAULT_AGENT=codex
CODEX_SANDBOX_MODE=workspace-write
CODEX_APPROVAL_POLICY=never
```

User and chat access management:

- `nordrelay init` creates the first admin user and writes `~/.nordrelay/users.json`.
- `nordrelay user create-admin --email you@example.com --name "Your Name"` creates another admin.
- `nordrelay user create --email dev@example.com --name "Dev" --group user` creates a normal user.
- `nordrelay user link-telegram --email you@example.com --telegram-user-id 123456789` links a Telegram account directly.
- `nordrelay user link-discord --email you@example.com --discord-user-id <your-discord-user-id>` links a Discord account directly.
- `nordrelay user link-slack --email you@example.com --slack-user-id U123 --slack-team-id T123` links a Slack account directly.
- `nordrelay user link-code --email you@example.com` creates a short-lived Telegram code that the user sends as `/link <code>` to the Telegram bot.
- `nordrelay user discord-link-code --email you@example.com` creates a short-lived Discord code that the user sends as `/link <code>` to the Discord bot.
- `nordrelay user slack-link-code --email you@example.com` creates a short-lived Slack code that the user sends as `/link <code>` to the Slack app.
- Telegram group chats are disabled until an admin enables them from the WebUI or runs `/register_chat` inside the group.
- Discord guild channels are disabled until an admin enables them from the WebUI or runs `/register_channel` inside the channel.
- Slack channels are disabled until an admin enables them from the WebUI or runs `/register_channel` inside the channel.

Peer setup:

1. On each host that should accept peer connections, set `NORDRELAY_PEER_ENABLED=true` in `~/.nordrelay/nordrelay.env`.
2. Keep `NORDRELAY_PEER_TLS_ENABLED=true` and `NORDRELAY_PEER_REQUIRE_TLS=true` for LAN or internet use.
3. Use `NORDRELAY_PEER_HOST=127.0.0.1` for local-only testing, a LAN/interface IP for trusted local networks, or keep the peer API behind a TLS reverse proxy/VPN for internet access.
4. Set `NORDRELAY_PEER_PUBLIC_URL=https://host.example:31979` when other hosts cannot reach the bind address directly.
5. Restart NordRelay on the accepting host and create an invitation:

```bash
nordrelay peer invite --name workstation --scopes inspect,sessions.read,sessions.write,prompt.send,prompt.abort,queue.read,queue.write,files.read,files.write,diagnostics.read,logs.read,workflows.read,workflows.run
```

6. On the controlling host, run the printed command:

```bash
nordrelay peer add https://workstation.example:31979 --code one-time-code
```

If the controlling host should also be reachable by the remote peer, enable its peer server and set
`NORDRELAY_PEER_PUBLIC_URL` before running `peer add`, or pass it explicitly:

```bash
nordrelay peer add https://workstation.example:31979 --code one-time-code --public-url https://controller.example:31979
```

NordRelay validates the advertised public URL against the peer identity endpoint during pairing and stores the current TLS certificate fingerprint for later reachability probes.

7. Confirm the connection:

```bash
nordrelay peer list
nordrelay peer test <peer-id>
```

Use `--workspace-aliases app=/srv/app,demo=/home/me/demo` on invites when a controller should be able to start remote sessions with short workspace names. Use the WebUI Peers page for the same invite, pair, enable/disable, test, alias, global-session, and revoke workflow. Use `/peers` from Telegram, Discord, or Slack to inspect paired nodes and `/target <peer-id>` or `/target local` to choose where subsequent prompts run. Workflow steps can also target paired peers from the WebUI workflow builder when the peer has `sessions.read`, `sessions.write`, and `prompt.send`.

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

Optional X/Twitter workflow for OpenClaw:

- Use [TweetClaw](https://github.com/Xquik-dev/tweetclaw) when NordRelay is driving an OpenClaw agent that needs to scrape tweets, search tweet replies, post tweets or replies, run follower exports, look up users, upload or download media, send direct messages, manage monitors, deliver webhooks, or run giveaway draws.
- Install the official [`@xquik/tweetclaw`](https://www.npmjs.com/package/@xquik/tweetclaw) package in the same OpenClaw host:

```bash
openclaw plugins install @xquik/tweetclaw
openclaw config set tools.alsoAllow '["tweetclaw"]'
```

- Keep Xquik credentials in OpenClaw local config. Do not send those credentials through Telegram, Discord, Slack, WebUI, or peer prompts.
- Use NordRelay approvals and locks for the chat control plane, then review OpenClaw approvals before write-like actions such as posting, replying, following, direct messages, monitors, webhooks, profile changes, or deletes.

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
nordrelay doctor --fix
nordrelay start
nordrelay status
nordrelay update
nordrelay restart
nordrelay stop
nordrelay foreground
nordrelay web
nordrelay peer list
nordrelay peer invite
nordrelay peer add https://peer.example:31979 --code one-time-code
```

Source checkout process commands:

```bash
node plugins/nordrelay/scripts/nordrelay.mjs start
node plugins/nordrelay/scripts/nordrelay.mjs status
node plugins/nordrelay/scripts/nordrelay.mjs update
node plugins/nordrelay/scripts/nordrelay.mjs restart
node plugins/nordrelay/scripts/nordrelay.mjs stop
node plugins/nordrelay/scripts/nordrelay.mjs foreground
node plugins/nordrelay/scripts/nordrelay.mjs user list
node plugins/nordrelay/scripts/nordrelay.mjs doctor
node plugins/nordrelay/scripts/nordrelay.mjs web
node plugins/nordrelay/scripts/nordrelay.mjs peer list
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
- `NORDRELAY_WEBUI_ENABLED=true` allows a WebUI-only setup without Telegram, Discord, or Slack.


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
- Start a new session from a modal with agent, workspace, workspace mode, model, reasoning/thinking, fast mode, and launch-profile choices.
- Switch or attach existing sessions, and copy thread IDs from the session list.
- Manage isolated session worktrees from the Sessions page, including fork current, diff preview, update from base, commit, remove, cleanup, and preview/integrate selected worktree branches.
- Send prompts and receive streamed text/tool/plan updates through Server-Sent Events.
- Mirror native CLI-started turns into the WebUI chat with `off`, `status`, `final`, and `full` modes from the toolbar or `/mirror [mode]`.
- Upload images, documents, and audio files from the chat composer. Images are passed as image inputs, documents are staged for the agent, and audio is transcribed through the configured voice backend.
- Keep a persistent per-thread WebUI chat history across page reloads.
- Control the active session model, reasoning/thinking, fast mode, and launch profile directly from the chat view.
- Abort turns, hand sessions back to the native CLI, and inspect the active session.
- Manage queued prompts with pause/resume, run, cancel, reorder buttons, and drag-and-drop prioritization.
- Inspect unified jobs across queued prompts, active turns, mirrored CLI work, agent updates, self-updates, and support-bundle exports.
- Browse, preview, download, ZIP, and delete artifacts.
- Inspect the activity timeline for WebUI and mirrored CLI turns.
- Edit all supported runtime settings from tabbed Settings groups with option selects, validation feedback, and restart actions.
- View filtered connector/update/agent-update logs, structured diagnostics, enabled channels, and agent adapters.
- Inspect a per-agent capability matrix showing model, reasoning, launch, fast mode, attachments, activity, usage, auth, login/logout, and handback support.
- Check NordRelay and agent CLI versions, then start Codex, Pi, Hermes, OpenClaw, or Claude Code updates from outdated rows or installs from not-installed rows with live output, cancel, delete-log, and stdin response controls.
- Build minified and precompressed dashboard CSS and client JavaScript from modular source assets through esbuild, then serve them as authenticated static assets instead of inline HTML.
- Pair, test, enable/disable, and revoke NordRelay peers, then switch the dashboard target between the local instance and paired remote instances.

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
