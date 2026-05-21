# Configuration

NordRelay reads runtime configuration from:

```text
~/.nordrelay/nordrelay.env
```

You can override the home directory with `--home <path>` or point the wrapper at an explicit env file with `NORDRELAY_ENV_FILE`.

## Minimal WebUI-only config

```dotenv
NORDRELAY_WEBUI_ENABLED=true
TELEGRAM_ENABLED=false
DISCORD_ENABLED=false
SLACK_ENABLED=false
MATRIX_ENABLED=false
NORDRELAY_CODEX_ENABLED=true
NORDRELAY_DEFAULT_AGENT=codex
```

## Minimal Telegram plus Codex config

```dotenv
NORDRELAY_WEBUI_ENABLED=true
TELEGRAM_ENABLED=true
TELEGRAM_BOT_TOKEN=<bot-token>
NORDRELAY_CODEX_ENABLED=true
NORDRELAY_DEFAULT_AGENT=codex
```

The token value belongs only in local config or secret management.

## State backend

```dotenv
NORDRELAY_STATE_BACKEND=json
```

Use `json` for simple local installs. Use `sqlite` when you need a SQLite-backed state store and have the optional native dependency available.

## Dashboard bind address

```dotenv
NORDRELAY_DASHBOARD_HOST=127.0.0.1
NORDRELAY_DASHBOARD_PORT=31878
```

Bind to `0.0.0.0` only on trusted networks or behind HTTPS/reverse proxy controls.

## Autostart

```dotenv
NORDRELAY_AUTOSTART_ENABLED=true
NORDRELAY_WEBUI_AUTOSTART_ENABLED=true
```

The Settings page can install or remove user-level autostart entries for Linux, macOS, and Windows.

## Reference source

The generated `.env.example` in the repository is the source of truth for currently supported keys and allowed values.
