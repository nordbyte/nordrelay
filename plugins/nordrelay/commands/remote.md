---
description: Start, stop, or inspect the NordRelay bot process.
---

# /nordrelay:remote

Start the NordRelay bot process.

This command is now only a process-manager shortcut. The Telegram bot itself provides the full remote controls: `/start`, `/new`, `/session`, `/sessions`, `/sync`, `/pinned`, `/pin`, `/unpin`, `/attach`, `/handback`, `/model`, `/reasoning`, `/fast`, `/launch_profiles`, `/retry`, `/queue`, `/cancel`, `/clearqueue`, `/artifacts`, `/abort`, `/stop`, `/tasks`, `/progress`, `/status`, `/health`, `/version`, `/logs`, `/diagnostics`, `/restart`, `/update`, voice messages, photos, documents, media groups, artifacts, and login.

Codex plugin commands are namespaced by the plugin id in current plugin-aware command surfaces. The unnamespaced `/remote` command is not available in current Codex TUI builds.

## Arguments

- empty: start the connector in the background
- `status`: show connector status
- `stop`: stop the connector
- `restart`: restart the connector
- `foreground`: run the connector in the foreground for debugging

## Workflow

1. Locate the plugin root containing `.codex-plugin/plugin.json` with `"name": "nordrelay"`. In a source checkout this is usually `<repo>/plugins/nordrelay`.
2. Check whether `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ADMIN_USER_IDS` are available from the environment or from the NordRelay env file.
3. Run the connector command from the plugin root:

```bash
node scripts/nordrelay.mjs ${ARGUMENTS:-start}
```

4. If `${ARGUMENTS}` is empty, use `start`.
5. After `start` or `restart`, run `node scripts/nordrelay.mjs status` and report the PID, selected thread id if visible, and log file.
6. If startup fails because dependencies are missing, run `npm install` and `npm run build` in the repository root.
