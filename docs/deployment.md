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

Docker Compose:

```bash
docker compose up -d --build
docker compose logs -f
docker compose down
```

The compose file mounts:

- `${HOME}/.codex` into the container for Codex auth and thread state.
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
