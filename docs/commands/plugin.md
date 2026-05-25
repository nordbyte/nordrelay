# `nordrelay plugin`

Manage local and GitHub plugins for NordRelay.

## Usage

```bash
nordrelay plugin <command> [options]
```

## Commands

| Command | Description |
| --- | --- |
| `list` | Show installed plugins |
| `install <source>` | Install from a local path, `github:owner/repo`, or a GitHub URL |
| `create <dir> --id <id>` | Scaffold a plugin directory |
| `validate <path>` | Validate a local plugin manifest |
| `enable <id>` | Enable a plugin and approve its declared permissions |
| `disable <id>` | Disable a plugin |
| `remove <id>` | Remove an installed plugin |
| `reload <id>` | Reload manifest metadata from the installed plugin |
| `settings <id> [--set K=V]` | Show or update plugin settings |
| `catalog` | Print enabled extension points as JSON |
| `log <id>` | Show the plugin log |

## Install options

| Option | Description |
| --- | --- |
| `--ref <ref>` | Git branch, tag, or commit for GitHub installs |
| `--enable` | Enable after install |
| `--approve` | Approve declared permissions after install |
| `--force` | Reinstall the same version |

## Examples

```bash
nordrelay plugin create ./my-plugin --id my-plugin --name "My Plugin"
nordrelay plugin validate ./my-plugin
nordrelay plugin install ./my-plugin --enable --approve
nordrelay plugin install github:owner/nordrelay-plugin --ref main
nordrelay plugin settings my-plugin --set prefix=prod
nordrelay plugin log my-plugin
```

## Requirements

Plugins live under `~/.nordrelay/plugins`. GitHub installs require `git` on `PATH` and are disabled when `NORDRELAY_PLUGIN_GITHUB_INSTALL_ENABLED=false`.

Plugin management is permission-gated in the WebUI and API:

| Permission | Allows |
| --- | --- |
| `plugins.read` | View installed plugins, logs, and extension catalog |
| `plugins.install` | Install, remove, scaffold, validate, and reload plugins |
| `plugins.enable` | Enable or disable plugins |
| `plugins.settings.write` | Update plugin settings |

