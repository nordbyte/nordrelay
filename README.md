# NordRelay
![NordRelay Banner](https://raw.githubusercontent.com/nordbyte/nordrelay/main/docs/assets/nordrelay.png) [![Latest release](https://img.shields.io/github/v/release/nordbyte/nordrelay?style=flat-square)](https://github.com/nordbyte/nordrelay/releases/latest) [![CI](https://img.shields.io/github/actions/workflow/status/nordbyte/nordrelay/ci.yml?branch=main&style=flat-square)](https://github.com/nordbyte/nordrelay/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-ffd60a?style=flat-square)](LICENSE) [![npm](https://img.shields.io/npm/v/@nordbyte/nordrelay?logo=npm&logoColor=white&style=flat-square)](https://www.npmjs.com/package/@nordbyte/nordrelay) [![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22-339933?logo=node.js&logoColor=white&style=flat-square)](package.json) [![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6?logo=typescript&logoColor=white&style=flat-square)](tsconfig.json)

NordRelay is a secure remote control plane for coding agents. It connects Codex, Pi, Hermes, OpenClaw, and Claude Code sessions to Telegram, Discord, Slack, Matrix, the WebUI, and trusted peer nodes, with streaming replies, file/photo/voice input, queues, artifacts, user permissions, and multi-host control.

Use the README for the first install and quick start. Full documentation is available at [nordrelay.io](https://nordrelay.io/) and in [docs/](docs/).

## Quick Start

Requirements:

- Node.js 22 or newer.
- At least one supported coding agent installed and authenticated, for example Codex CLI.
- A Telegram, Discord, Slack, or Matrix bot/app token if you want chat access.

Install NordRelay globally:

```bash
npm install -g @nordbyte/nordrelay
nordrelay init
nordrelay doctor
nordrelay start
```

NordRelay is published to the npm registry, so pnpm and Yarn can install the same package:

```bash
pnpm dlx @nordbyte/nordrelay init
pnpm add -g @nordbyte/nordrelay
yarn dlx @nordbyte/nordrelay init
```

If `nordrelay` is not found after a global npm or pnpm install, the package-manager global bin directory is not in your shell `PATH`. New installs run a postinstall check and print the exact command to add the bin directory to your shell profile.

Open the dashboard:

```bash
nordrelay web
```

The dashboard is available at the URL printed by the command, usually:

```text
http://127.0.0.1:31878/
```

On first WebUI startup, create the first admin user. After that, every dashboard page and chat adapter action is controlled by NordRelay users, groups, linked Telegram/Discord/Slack/Matrix accounts, and registered channels or rooms.

## Minimal Setup

The recommended setup path is interactive:

```bash
nordrelay init
nordrelay user list
nordrelay doctor
nordrelay doctor --fix
nordrelay start
```

`nordrelay init` writes private runtime config to:

```text
~/.nordrelay/nordrelay.env
```

NordRelay keeps runtime state, queues, uploads, logs, and workspace-scoped artifacts under `~/.nordrelay`.

A minimal Telegram + Codex configuration looks like this:

```dotenv
NORDRELAY_WEBUI_ENABLED=true
TELEGRAM_ENABLED=true
TELEGRAM_BOT_TOKEN=<bot-token>
DISCORD_ENABLED=false
SLACK_ENABLED=false
MATRIX_ENABLED=false
NORDRELAY_CODEX_ENABLED=true
NORDRELAY_DEFAULT_AGENT=codex
CODEX_SANDBOX_MODE=workspace-write
CODEX_APPROVAL_POLICY=never
```

For a browser-only setup, keep `NORDRELAY_WEBUI_ENABLED=true` and set all chat adapters to `false`.

For guided setup in the browser, open the WebUI, go to **Settings**, then use **Setup wizard** for Telegram, Discord, Slack, or Matrix.

## Common Commands

CLI:

```bash
nordrelay status
nordrelay doctor
nordrelay doctor --fix
nordrelay web
nordrelay restart
nordrelay update
nordrelay service install
nordrelay service status
```

Chat adapters share the core command set:

```text
/help
/nodes
/session
/sessions
/agent
/model
/reasoning
/queue
/artifacts
/mirror
/stop
/diagnostics
```

See [Chat commands](docs/reference/chat-commands.md) and the [CLI reference](docs/commands/index.md) for the complete command reference.

## What NordRelay Provides

- Independent sessions per Telegram chat/topic, Discord DM/channel/thread, Slack DM/channel/thread, Matrix DM/room/thread, WebUI, and peer target.
- Optional isolated Git worktree sessions so multiple agent sessions can work on the same repository without seeing each other's unfinished changes.
- Worktree diff/integration previews, base-branch updates, cleanup, and peer-routed workflow steps for multi-host automation.
- Streaming replies, typing/status indicators, tool activity, queue handling, retry, abort/stop, and CLI handback.
- File, photo, voice/audio, and generated artifact workflows.
- Prompt templates and multi-step workflows with variable preview, run history, and unified job tracking.
- Per-user and per-group access control for WebUI, chat adapters, workspaces, agents, and peer nodes.
- Optional peer federation for controlling agents on other trusted NordRelay hosts.
- WebUI dashboard for chat, sessions, settings, logs, diagnostics, updates, artifacts, peers, metrics, and users.
- Agent adapters for Codex, Pi, Hermes, OpenClaw, and Claude Code.
- Chat adapters for Telegram, Discord, Slack, and Matrix.

## Documentation

| Topic | Link |
| --- | --- |
| Full documentation site | [nordrelay.io](https://nordrelay.io/) |
| Installation and quickstart | [docs/start/install.md](docs/start/install.md) |
| WebUI | [docs/start/webui.md](docs/start/webui.md) |
| Agents | [docs/guides/agents.md](docs/guides/agents.md) |
| Chat adapters | [docs/guides/chat-adapters.md](docs/guides/chat-adapters.md) |
| Workflows | [docs/guides/workflows.md](docs/guides/workflows.md) |
| Configuration and settings | [docs/reference/configuration.md](docs/reference/configuration.md) |
| CLI command reference | [docs/commands/index.md](docs/commands/index.md) |
| Architecture | [docs/internals/architecture.md](docs/internals/architecture.md) |
| Public security policy | [SECURITY.md](SECURITY.md) |
| Contribution guide | [CONTRIBUTING.md](CONTRIBUTING.md) |

## Development

From a source checkout:

```bash
npm install
npm run build
npm run check
npm test
npm run test:e2e
```

WebUI CSS and JavaScript are minified and precompressed by default during
`npm run build`. Set `NORDRELAY_WEBUI_MINIFY=false` for readable local asset
builds while debugging.

Useful runtime scripts:

```bash
npm run foreground
npm start
npm run status
npm stop
```

## Security Defaults

- The dashboard requires login.
- User accounts support authenticator MFA, recovery codes, passkeys, scoped API tokens, and session revocation.
- Chat adapter access requires linked NordRelay users and registered/allowed channels.
- Peer serving is disabled by default and requires explicit pairing.
- Unsafe launch profiles are hidden unless explicitly enabled.
- Secrets belong in `~/.nordrelay/nordrelay.env` or host secret management, not in the repository.

## License

MIT. See [LICENSE](LICENSE).
