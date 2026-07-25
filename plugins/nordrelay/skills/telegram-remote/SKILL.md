---
name: telegram-remote
description: Use when the user wants to start, inspect, stop, restart, or troubleshoot the local NordRelay runtime, including prompts like "remote", "/remote", "NordRelay Remote", "NordRelay", or coding-agent remote control.
---

# NordRelay Remote

This Codex-side skill manages the local NordRelay process. After the runtime starts, full session
control is available through the login-protected WebUI and enabled Telegram, Discord, Slack, and
Matrix adapters, including trusted peer-node routing.

Use the local connector script in the plugin root. In a source checkout, the plugin root is usually:

```text
<repo>/plugins/nordrelay
```

Run commands from that directory:

```bash
node scripts/nordrelay.mjs start
node scripts/nordrelay.mjs status
node scripts/nordrelay.mjs stop
node scripts/nordrelay.mjs restart
```

Only enabled control surfaces need credentials. `TELEGRAM_BOT_TOKEN` is required only when
Telegram is enabled; a WebUI-only installation does not need it. At least one NordRelay admin user
is required before the WebUI or chat adapters can control sessions. External chat identities and
channels must also be linked or enabled according to NordRelay access-control rules.

Prefer `start` for normal use. Use `foreground` only when debugging connection problems, because it keeps the current command running. If the runtime is missing, run `npm install` and `npm run build` in the repository root.
