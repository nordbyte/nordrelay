---
description: Start, stop, restart, inspect, or troubleshoot the local NordRelay process.
---

# /nordrelay:remote

Manage the local NordRelay process.

This command is a process-manager shortcut. NordRelay provides full session control through its
login-protected WebUI and enabled Telegram, Discord, Slack, and Matrix adapters, including trusted
peer-node routing. This Codex command starts, stops, restarts, inspects, or troubleshoots the local
runtime; it does not replace those control surfaces.

Codex plugin commands are namespaced by the plugin id in current plugin-aware command surfaces. The unnamespaced `/remote` command is not available in current Codex TUI builds.

## Arguments

- empty: start the connector in the background
- `status`: show connector status
- `stop`: stop the connector
- `restart`: restart the connector
- `foreground`: run the connector in the foreground for debugging

## Workflow

1. Locate the plugin root containing `.codex-plugin/plugin.json` with `"name": "nordrelay"`. In a source checkout this is usually `<repo>/plugins/nordrelay`.
2. Check that the NordRelay env file exists and that the credentials required by the enabled
   control surfaces are configured. `TELEGRAM_BOT_TOKEN` is required only when Telegram is enabled.
   A NordRelay admin user is required before the WebUI or chat adapters can control sessions.
3. Run the connector command from the plugin root:

```bash
node scripts/nordrelay.mjs ${ARGUMENTS:-start}
```

4. If `${ARGUMENTS}` is empty, use `start`.
5. After `start` or `restart`, run `node scripts/nordrelay.mjs status` and report the PID, selected thread id if visible, and log file.
6. If startup fails because dependencies are missing, run `npm install` and `npm run build` in the repository root.
