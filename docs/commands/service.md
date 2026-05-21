# `nordrelay service`

Install, remove, or inspect OS service integration.

## Usage

```bash
nordrelay service <subcommand> [options]
```

## Subcommands

| Subcommand | Purpose |
| --- | --- |
| `install` | Install a user-level service or scheduled task |
| `uninstall` | Remove the service |
| `remove` | Alias for `uninstall` |
| `status` | Inspect service status |

## Options

| Option | Description |
| --- | --- |
| `--dry-run` | Print generated service files and commands without installing |
| `--platform linux|darwin|win32` | Override detected platform |
| `--no-start` | Install without starting immediately |
| `--name <name>` | Linux/Windows service or task name |
| `--label <label>` | macOS launchd label |

## Examples

```bash
nordrelay service install --dry-run
nordrelay service install
nordrelay service status
nordrelay service uninstall
```

## Platform behavior

| Platform | Integration |
| --- | --- |
| Linux | systemd user service |
| macOS | launchd LaunchAgent |
| Windows | scheduled task |

Autostart can also be managed from Settings with `NORDRELAY_AUTOSTART_ENABLED` and `NORDRELAY_WEBUI_AUTOSTART_ENABLED`.
