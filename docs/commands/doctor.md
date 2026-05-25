# `nordrelay doctor`

Validate the local setup and optionally apply safe fixes.

## Usage

```bash
nordrelay doctor [--fix]
```

## Options

| Option | Description |
| --- | --- |
| `--fix` | Apply safe local fixes where available |
| `--home <path>` | Check a custom NordRelay home directory |

## Checks

Doctor checks include:

- Node.js version
- CLI `PATH`
- WebUI enabled state
- admin user presence
- chat adapter tokens and required IDs
- linked-user and channel access model
- agent enable flags and CLI paths
- Hermes API and OpenClaw Gateway settings
- `ffmpeg` and voice backend availability
- state backend health
- peer server and TLS readiness
- runtime entry path
- autostart/service verification:
  - service is enabled for boot/login and currently active
  - service user and main PID where the platform exposes it
  - configured and reported workspace
  - WebUI and peer ports listening after autostart

## Autostart verification

When `NORDRELAY_AUTOSTART_ENABLED=true` or `NORDRELAY_WEBUI_AUTOSTART_ENABLED=true`, Doctor checks the platform service integration instead of only checking the config flag.

| Platform | What Doctor checks |
| --- | --- |
| Linux | systemd user unit enablement, active state, main PID, process owner, start timestamp, unit path, workspace, runtime home, user lingering, WebUI port, peer port |
| macOS | LaunchAgent plist, loaded state, disabled state, `RunAtLoad`, `KeepAlive`, PID when available, user, workspace, runtime home, WebUI port, peer port |
| Windows | Scheduled task presence, logon schedule, status, run-as user, workspace, runtime home, WebUI port, peer port |

If a service is configured but not active or a required listener is missing, Doctor reports a warning and offers the safe `repair-autostart` fix where available.

## Examples

```bash
nordrelay doctor
nordrelay doctor --fix
```

## Notes

`doctor --fix` does not invent secrets or authenticate external bots. It only applies local changes that can be made safely.
