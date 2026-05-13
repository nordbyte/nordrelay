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

Do not include real Telegram bot tokens, OpenAI API keys, Codex credentials, local rollout files, or private source code in reports.

## Security Defaults

NordRelay is designed to fail closed:

- A fresh install requires a NordRelay admin user before Telegram or WebUI control can be used.
- WebUI login is required for every dashboard page, API route, SSE stream, artifact download, and health endpoint.
- Telegram private chats require a linked active NordRelay user.
- Telegram group and forum chats are disabled until an admin enables the chat.
- Authorization is enforced through user groups, granular permissions, and optional group scopes for agents, workspace roots, and Telegram chats.
- Unknown commands, callback actions, and API routes are denied by default.
- The last active admin user cannot be disabled or demoted.
- WebUI login and Telegram account-link attempts are rate-limited.
- Password changes and group membership changes revoke existing WebUI sessions.
- User, group, Telegram-link, Telegram-chat, session-revocation, login, and permission-denied events are audited.
- Uploaded files are staged inside the selected workspace.
- Secrets are redacted from logs and Telegram diagnostics where possible.

Treat enabling `danger-full-access`, broad write permissions, or Telegram group chat access as equivalent to granting remote shell-adjacent control over the host.
