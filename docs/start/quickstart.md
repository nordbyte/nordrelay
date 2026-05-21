# Quickstart

This path creates a local WebUI setup with one admin user and Codex enabled. You can enable other agents and chat adapters later.

## Initialize

```bash
nordrelay init
```

The wizard asks whether the WebUI, autostart, chat adapters, and agents should be enabled. It writes:

```text
~/.nordrelay/nordrelay.env
```

It also creates the first admin user if no user store exists.

## Validate

```bash
nordrelay doctor
```

Review warnings before starting. Common warnings are missing optional agents, missing chat tokens, missing `ffmpeg`, or package-manager `PATH` issues.

## Start the WebUI

```bash
nordrelay web
```

`nordrelay web` starts the connector and the dashboard in the background. It prints the dashboard URL, usually:

```text
http://127.0.0.1:31878/
```

The WebUI is login-protected. Sign in with the admin user created during initialization.

## Start only the connector

```bash
nordrelay start
```

Use this when you want chat adapters or peers without opening the browser dashboard immediately.

## Connect a chat adapter

Open the WebUI, then go to **Settings** and use **Setup wizard** for Telegram, Discord, Slack, or Matrix. The wizard saves only changed values and explains where to find external IDs and tokens.

After linking a user and registering a channel or room, try:

```text
/help
/nodes
/session
/sessions
```

Use `/nodes` when this chat should control a trusted peer node instead of the local NordRelay instance. After selecting a node, `/sessions` shows sessions for that node and the currently selected agent.

## Stop

```bash
nordrelay stop
```

Stopping NordRelay stops the connector and WebUI processes managed by NordRelay. External agent CLIs that you started yourself continue under their own process lifecycle.
