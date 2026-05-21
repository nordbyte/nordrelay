# Agents

NordRelay supports multiple coding agents behind one WebUI, one user model, and one chat command core.

## Supported adapters

| Adapter | Enable key | Notes |
| --- | --- | --- |
| Codex | `NORDRELAY_CODEX_ENABLED` | Codex SDK/CLI sessions, launch profiles, approvals, active CLI discovery |
| Pi | `NORDRELAY_PI_ENABLED` | Pi CLI sessions, thinking/profile defaults, active discovery where available |
| Hermes | `NORDRELAY_HERMES_ENABLED` | Uses the Hermes API Server for streaming runs and session continuity |
| OpenClaw | `NORDRELAY_OPENCLAW_ENABLED` | Uses the OpenClaw Gateway WebSocket RPC endpoint |
| Claude Code | `NORDRELAY_CLAUDE_CODE_ENABLED` | Uses the Claude Agent SDK and host `claude` CLI when available |

## Select the default agent

```dotenv
NORDRELAY_DEFAULT_AGENT=codex
```

Valid values are `codex`, `pi`, `hermes`, `openclaw`, and `claude-code`.

## Explicit CLI paths

Use explicit paths when an agent is not on `PATH`:

```dotenv
CODEX_CLI_PATH=/absolute/path/to/codex
PI_CLI_PATH=/absolute/path/to/pi
HERMES_CLI_PATH=/absolute/path/to/hermes
OPENCLAW_CLI_PATH=/absolute/path/to/openclaw
CLAUDE_CODE_CLI_PATH=/absolute/path/to/claude
```

## Launch profiles and permissions

Each adapter maps its own permissions into NordRelay launch profiles. The WebUI and chat adapters show the current launch profile and allow switching where the agent supports it.

For Codex, launch settings include:

- sandbox mode: `read-only`, `workspace-write`, or `danger-full-access`
- approval policy: `never`, `on-request`, `on-failure`, or `untrusted`
- optional unsafe profiles behind `ENABLE_UNSAFE_LAUNCH_PROFILES=true`

## Agent updates

The WebUI **Version** page can check and start updates for NordRelay and installed agent CLIs. Update jobs write separate logs and refresh version status when they finish.

The CLI can update NordRelay itself:

```bash
nordrelay update
```
