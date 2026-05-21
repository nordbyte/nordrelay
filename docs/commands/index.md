# CLI command reference

```bash
nordrelay <command> [options]
```

## Commands

| Command | Purpose |
| --- | --- |
| [`init`](/commands/init) | Create local config and the first admin user |
| [`user`](/commands/user) | Manage users, groups, and chat identity links |
| [`peer`](/commands/peer) | Manage secure NordRelay peer federation |
| [`service`](/commands/service) | Install, remove, or inspect OS service integration |
| [`doctor`](/commands/doctor) | Validate the local setup and apply safe fixes |
| [`web`](/commands/web) | Start the WebUI and connector in the background |
| [`start`](/commands/start) | Start the connector in the background |
| [`stop`](/commands/stop) | Stop the connector and WebUI |
| [`restart`](/commands/restart) | Restart the connector |
| [`status`](/commands/status) | Show connector and WebUI status |
| [`update`](/commands/update) | Update NordRelay |
| [`foreground`](/commands/foreground) | Run the connector in the current terminal |
| [`version`](/commands/version) | Print the installed version |

## Global options

| Option | Description |
| --- | --- |
| `--home <path>` | Use a custom NordRelay home directory instead of `~/.nordrelay` |
| `--host <host>` | WebUI bind host for commands that start the dashboard |
| `--port <port>` | WebUI bind port for commands that start the dashboard |
| `--build` | Build the project before starting or restarting when running from source |
| `--help`, `-h` | Show top-level help |
| `--version`, `-v` | Print the installed version |

Prefer `--*-file <path>` options for secrets when a command accepts them.
