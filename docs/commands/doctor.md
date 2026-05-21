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

## Examples

```bash
nordrelay doctor
nordrelay doctor --fix
```

## Notes

`doctor --fix` does not invent secrets or authenticate external bots. It only applies local changes that can be made safely.
