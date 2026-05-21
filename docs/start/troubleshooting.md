# Troubleshooting

Start with:

```bash
nordrelay status
nordrelay doctor
```

## Command not found

The global package-manager bin directory is missing from `PATH`.

```bash
npm bin -g
```

Add the printed directory to your shell profile and open a new terminal.

## WebUI login fails

Check that the process can write to `~/.nordrelay` and that you are not starting NordRelay from inside a read-only package directory:

```bash
nordrelay doctor
nordrelay status
```

User data and audit events must be stored below `~/.nordrelay`.

## Chat adapter is enabled but not responding

Check:

- the adapter is enabled in `~/.nordrelay/nordrelay.env`
- required token values are configured
- the external bot or app was invited to the channel or room
- the NordRelay user is linked to the external account
- the channel, room, guild, team, or topic is registered or allowed

Run:

```bash
nordrelay doctor
```

## Agent not found

Install the agent CLI, authenticate it, and confirm the executable is on `PATH`. You can also set an explicit path in `~/.nordrelay/nordrelay.env`, for example `CODEX_CLI_PATH` or `PI_CLI_PATH`.

## SQLite errors

If `NORDRELAY_STATE_BACKEND=sqlite`, the state directory must exist and `better-sqlite3` must be available. `doctor` reports backend problems; use JSON state if you do not need SQLite.

## Peer fingerprint mismatch

Peer TLS fingerprints are pinned after pairing. If a peer certificate changes, use the trust or rotation workflow instead of ignoring the warning:

```bash
nordrelay peer trust <peer-id>
nordrelay peer rotate <peer-id>
```

## More diagnostics

Use the WebUI **Diagnostics** page or export a support bundle. Bundles redact sensitive values and include health, versions, paths, recent logs, audit events, update jobs, state backend, and OS/runtime metadata.
