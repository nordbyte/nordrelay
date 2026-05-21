# Security and login

NordRelay uses one user system for the WebUI and all chat adapters.

## Login is required

When the WebUI is enabled, every dashboard page, API route, SSE stream, artifact download, health endpoint, and state-changing action requires an authenticated NordRelay user.

## Users and groups

Admins can manage:

- users
- groups
- linked Telegram, Discord, Slack, and Matrix identities
- registered channels and rooms
- account locks
- audit events

The first admin is created by `nordrelay init` or:

```bash
nordrelay user create-admin --email <email> --name <name>
```

## Chat access

Chat adapters require both a linked user and an allowed or registered channel context. This prevents random bot users or unregistered rooms from receiving typing indicators, command output, or agent responses.

## Peers

Peer federation is disabled by default. When enabled, pairing uses explicit invitation codes, node identity fingerprints, TLS fingerprints, scoped access, and optional workspace allow-lists.

## Secrets

Keep secrets out of the repository. Prefer:

- `~/.nordrelay/nordrelay.env`
- `--*-file` CLI options where supported
- deployment secret management

Support bundles and diagnostics redact sensitive values.
