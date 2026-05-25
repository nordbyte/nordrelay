# WebUI

The WebUI is the primary browser interface for NordRelay. It is always login-protected when enabled.

## Start

```bash
nordrelay web
```

To bind to another interface:

```bash
nordrelay web --host 0.0.0.0 --port 31878
```

Only expose the dashboard to trusted networks. Use a reverse proxy with HTTPS for internet-facing setups.

## Pages

| Page | Purpose |
| --- | --- |
| Overview | Health, current session metrics, active sessions, adapters |
| Chat | Send prompts, mirror sessions, attach files, use templates, abort active work |
| Workflows | Templates, workflow builder, versions, history, runs |
| Sessions | Browse sessions, inspect metadata, manage worktrees |
| Queue | Runtime queue and planning kanban |
| Monitor | Activity, tasks, traces, artifacts |
| Adapters | Agent and chat adapter health and conformance |
| Version | NordRelay and agent versions, updates, update jobs |
| Logs | Connector logs and agent update logs |
| Metrics | Runtime, sessions, queues, peers, adapters, pollers, caches, SSE, and peer roundtrips |
| Diagnostics | Doctor checks, support bundle, voice backend checks |
| Users | Users, groups, channel links, locks, audit events |
| Settings | Runtime settings and setup wizards |
| Peers | Pairing, health, topology, discovery, global sessions |

## Authentication

The WebUI requires a NordRelay user session for every page, API route, SSE stream, artifact download, and health endpoint. First-run setup creates the initial admin user.

## Profile

Use the profile menu to change your password, save your preferred theme, and log out. Admins can manage other users under **Users**.

## Local HTTP and HTTPS

By default, the dashboard is served over local HTTP. Browsers treat `http://127.0.0.1` as a secure context for microphone access, but LAN access may require HTTPS through a reverse proxy if browser APIs or network policy require it.
