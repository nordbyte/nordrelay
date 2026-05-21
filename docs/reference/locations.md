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
| `~/.nordrelay/artifacts/` | Managed generated artifacts |
| `~/.nordrelay/uploads/` | Uploaded files and inbox data |
| `~/.nordrelay/diagnostics/` | Diagnostics bundle output |
| `~/.nordrelay/peers/` | Peer identity and trust state |

Exact state filenames depend on the selected state backend.

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
