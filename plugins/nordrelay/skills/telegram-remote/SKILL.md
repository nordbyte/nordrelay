---
name: telegram-remote
description: Use when the user wants to start, inspect, stop, or troubleshoot the NordRelay bot process, including prompts like "remote", "/remote", "Telegram Remote", "NordRelay", or Telegram remote control.
---

# Telegram Remote

After the bot process is running, Telegram provides the actual controls (`/agent`, `/new`, `/sessions`, `/sync`, `/pinned`, `/pin`, `/unpin`, `/attach`, `/handback`, `/model`, `/reasoning`, `/fast`, `/launch_profiles`, `/retry`, `/queue`, `/cancel`, `/clearqueue`, `/artifacts`, `/abort`, `/stop`, `/tasks`, `/progress`, `/status`, `/health`, `/version`, `/logs`, `/diagnostics`, `/restart`, `/update`, voice, photos, documents, media groups, artifacts, login). The Codex-side command is only a process manager.

Use the local connector script in the plugin root. In a source checkout, the plugin root is usually:

```text
<repo>/plugins/nordrelay
```

Run commands from that directory:

```bash
node scripts/nordrelay.mjs start
node scripts/nordrelay.mjs status
node scripts/nordrelay.mjs stop
```

The bridge needs `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ADMIN_USER_IDS` by default. Optional non-admin operators can be added with `TELEGRAM_ALLOWED_USER_IDS` or trusted group/topic access can be added with `TELEGRAM_ALLOWED_CHAT_IDS`.

Prefer `start` for normal use. Use `foreground` only when debugging connection problems, because it keeps the current command running. If the runtime is missing, run `npm install` and `npm run build` in the repository root.
