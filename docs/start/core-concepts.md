# Core concepts

## Agent adapters

Agent adapters connect NordRelay to coding agents. Current adapters are:

- Codex
- Pi
- Hermes
- OpenClaw
- Claude Code

Each adapter exposes the capabilities it can support: sessions, prompts, streaming, approvals, artifacts, models, reasoning, launch profiles, updates, diagnostics, or active-session discovery.

## Chat adapters

Chat adapters connect users and channels to NordRelay:

- Telegram
- Discord
- Slack
- Matrix

They share the same command core where possible. Access is still checked per user, group, linked external identity, and registered channel or room.

## WebUI

The WebUI is a login-protected dashboard for chat, sessions, queue planning, workflows, artifacts, users, settings, logs, metrics, diagnostics, versions, and peers.

It is enabled with:

```dotenv
NORDRELAY_WEBUI_ENABLED=true
```

## Sessions

A session represents a conversation or run context for an agent. NordRelay can:

- start new sessions
- attach to known sessions
- discover active CLI sessions
- queue prompts while a session is busy
- mirror CLI output into the WebUI or chat
- route prompts to local or paired peer nodes

## Launch profiles

Launch profiles define agent permissions and behavior for new or reattached sessions. For Codex, this includes sandbox and approval policy. Unsafe profiles are hidden unless explicitly enabled.

## Queues and planners

When a session is already active, NordRelay can queue prompts instead of interrupting the running turn. The WebUI queue planner can store draft prompts, approve them, and move them into the runtime queue.

## Worktrees

Session workspace mode controls how Git workspaces are handled:

- `shared`: use the current workspace directly
- `worktree`: create isolated Git worktrees per session
- `attached`: keep externally started CLI sessions attached to their existing workspace

Worktrees are useful when multiple sessions work on the same repository without seeing each other's incomplete edits.

## Peers

Peer federation connects trusted NordRelay instances. Pairing is explicit and authenticated, with TLS fingerprints, scoped agents, scoped workspaces, and optional outbound relay mode for machines without inbound port forwarding.
