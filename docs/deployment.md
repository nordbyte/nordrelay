# Deployment

Foreground debugging:

```bash
npm run foreground
```

Background process:

```bash
npm start
npm run status
npm stop
```

OS user service:

```bash
nordrelay service install
nordrelay service status
nordrelay service uninstall
```

`nordrelay service install` creates the matching host integration for the current OS:

- Linux: `~/.config/systemd/user/nordrelay.service`
- macOS: `~/Library/LaunchAgents/io.nordbyte.nordrelay.plist`
- Windows: a Task Scheduler task named `NordRelay`

The service runs `nordrelay service-run`, which starts the connector and WebUI together. Use `--no-start` to only write/register the service without starting it immediately. Use `--host` and `--port` during install when the WebUI should bind to a non-default endpoint.

Docker Compose:

```bash
docker compose up -d --build
docker compose logs -f
docker compose down
```

The compose file mounts:

- `${HOME}/.nordrelay` into the container for NordRelay runtime state.
- Agent-specific auth/state directories, such as `${HOME}/.codex`, when those agents are enabled.
- `./workspace` as `/workspace` for container workspaces.

launchd helper:

```bash
NORDRELAY_SOURCE_ROOT=~/projects/nordrelay scripts/launchd-start.sh
```

Linux systemd example:

```ini
[Unit]
Description=NordRelay
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/nordrelay
Environment=NORDRELAY_SOURCE_ROOT=/opt/nordrelay
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Build before starting a service:

```bash
npm install
npm run build
```
