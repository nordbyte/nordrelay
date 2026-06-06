# Security and login

NordRelay uses one user system for the WebUI and all chat adapters.

## Login is required

When the WebUI is enabled, every dashboard page, API route, SSE stream, artifact download, health endpoint, and state-changing action requires an authenticated NordRelay user.

## Account security

Each user can manage additional security controls from the WebUI profile menu:

- authenticator-app MFA using standard six-digit TOTP codes
- single-use recovery codes for account recovery
- passkeys using WebAuthn when the browser and dashboard origin support it
- active web sessions with device, IP, last-seen time, and revoke controls

Password login is rate-limited per client socket IP. After five failed password attempts within 30 minutes, further login attempts from that IP are temporarily rejected. The limit is keyed by the direct connection IP so untrusted `X-Forwarded-For` headers cannot bypass it.

Passkeys are enabled by default with dynamic relying-party values derived from the WebUI request. For reverse proxies or public domains, set `NORDRELAY_WEBAUTHN_RP_ID` and `NORDRELAY_WEBAUTHN_ORIGIN` so browsers verify the expected domain consistently.

Recovery codes are shown only when created or regenerated. Store them outside the repository and outside `~/.nordrelay`.

## API tokens

Users with `auth.manage` can create scoped API tokens from the profile menu. Tokens are shown once, stored only as hashes, and can be limited by:

- permissions
- agent IDs
- workspace roots
- peer IDs
- expiration time

Use API tokens for automations such as workflow runs. Send them as a Bearer token:

```bash
curl -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"variables":{}}' \
  http://127.0.0.1:31878/api/workflows/<workflow-id>/run
```

API tokens do not bypass permissions or scopes. They only replace the browser cookie session for API calls.

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
