# Security Policy

## Supported Versions

Security fixes are currently provided for the latest release on `main`.

## Reporting a Vulnerability

Please do not disclose vulnerabilities publicly before they have been reviewed.

Preferred reporting path:

1. Use GitHub Security Advisories for this repository when available.
2. If advisories are not enabled, open a minimal GitHub issue that does not include secrets, exploit payloads, bot tokens, chat ids, logs with credentials, or private workspace contents.

Include:

- A short description of the issue.
- Affected version or commit.
- Reproduction steps using placeholder credentials.
- Expected and actual impact.
- Any suggested mitigation.

Do not include real Telegram or Discord bot tokens, OpenAI API keys, Codex credentials, local rollout files, or private source code in reports.

## Security Defaults

NordRelay is designed to fail closed:

- A fresh install requires a NordRelay admin user before chat adapters or WebUI control can be used.
- If the WebUI first-run setup wizard is used remotely, creating the first admin requires the one-time setup token printed in the server console.
- WebUI login is required for every dashboard page, API route, SSE stream, artifact download, and health endpoint.
- Telegram private chats require a linked active NordRelay user.
- Telegram group and forum chats are disabled until an admin enables the chat.
- Discord DMs require a linked active NordRelay user.
- Discord guild channels and threads are disabled until an admin enables the channel.
- Authorization is enforced through user groups, granular permissions, and optional group scopes for agents, workspace roots, Telegram chats, and Discord channels.
- NordRelay peer federation is disabled by default and uses a dedicated API port separate from the WebUI.
- Peer pairing requires an explicit one-time invitation code, Ed25519 node identity verification, request HMAC signatures, timestamp and nonce replay protection, and TLS fingerprint pinning.
- Peer permissions are scoped with `peers.read`, `peers.write`, and `peers.connect`, plus per-peer remote scopes, allowed agent ids, allowed workspace roots, and optional workspace aliases.
- Peer invitations are one-time use and capped to a maximum lifetime of 24 hours.
- Plaintext peer serving is refused on non-loopback hosts when TLS is required.
- Unknown commands, callback actions, and API routes are denied by default.
- The last active admin user cannot be disabled or demoted.
- WebUI login and chat account-link attempts are rate-limited.
- Password changes and group membership changes revoke existing WebUI sessions.
- User, group, Telegram-link, Telegram-chat, Discord-link, Discord-channel, session-revocation, login, and permission-denied events are audited.
- Uploaded files are staged inside the selected workspace.
- Secrets are redacted from logs, channel diagnostics, and diagnostics support bundles where possible.

Treat enabling `danger-full-access`, broad write permissions, Telegram group chat access, Discord guild-channel access, or peer access with prompt/write scopes as equivalent to granting remote shell-adjacent control over the host.
