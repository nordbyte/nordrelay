# Paths and state

NordRelay stores runtime data outside the repository.

## Default home

```text
~/.nordrelay/
```

## Common files

| Path | Purpose |
| --- | --- |
| `~/.nordrelay/nordrelay.env` | Runtime configuration |
| `~/.nordrelay/nordrelay.log` | Connector log |
| `~/.nordrelay/webui.log` | WebUI process log when managed separately |
| `~/.nordrelay/update.log` | NordRelay update log |
| `~/.nordrelay/agent-updates/` | Agent update job logs |
| `~/.nordrelay/workspaces/<workspace-id>/turns/` | Workspace-scoped generated artifacts and turn output |
| `~/.nordrelay/workspaces/<workspace-id>/inbox/` | Workspace-scoped uploaded files and staged input |
| `~/.nordrelay/workspaces/index.json` | Mapping from workspace IDs to workspace paths |
| `~/.nordrelay/diagnostics/` | Diagnostics bundle output |
| `~/.nordrelay/peers/` | Peer identity and trust state |

State, queues, logs, preferences, workflows, uploaded files, and generated artifact metadata stay below this global home directory. Workspace-specific uploads and turn output are grouped by a stable workspace ID under `~/.nordrelay/workspaces/`.

## Custom home

Most CLI commands accept:

```bash
nordrelay <command> --home /path/to/nordrelay-home
```

Use this for isolated test instances or service deployments.

## Build output

From source, `npm run build` writes compiled runtime files to:

```text
dist/
```

The WebUI static assets are built and minified as part of the same build.
