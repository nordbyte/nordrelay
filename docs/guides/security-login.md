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

Groups define permissions and optional scopes for agents, workspace roots, chat contexts, and peers. Leave a scope empty to allow all entries of that type; select one or more peers to limit that group to those peer nodes only.

The first admin is created by `nordrelay init` or:

```bash
nordrelay user create-admin --email <email> --name <name>
```

## Chat access

Chat adapters require both a linked user and an allowed or registered channel context. This prevents random bot users or unregistered rooms from receiving typing indicators, command output, or agent responses.

## Peers

Peer federation is disabled by default. When enabled, pairing uses explicit invitation codes, node identity fingerprints, TLS fingerprints, scoped access, and optional workspace allow-lists.

Peer access has two layers:

- group peer scope controls which paired nodes a NordRelay user may see or use
- each paired peer still enforces its own remote scopes, allowed agents, allowed workspace roots, and workspace aliases

This means a user must be allowed by both the local group scope and the peer's own trust configuration before sessions, prompts, workflows, proxy calls, or mirroring can use that peer.

## Secrets

Keep secrets out of the repository. Prefer:

- `~/.nordrelay/nordrelay.env`
- `--*-file` CLI options where supported
- deployment secret management

Support bundles and diagnostics redact sensitive values.
