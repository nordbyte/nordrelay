# `nordrelay init`

Create local runtime config and the first admin user.

## Usage

```bash
nordrelay init [options]
```

## Important options

| Option | Description |
| --- | --- |
| `--home <path>` | Write config and user state under a custom home directory |
| `--disable-webui` | Initialize with `NORDRELAY_WEBUI_ENABLED=false` |
| `--disable-autostart` | Disable connector autostart |
| `--disable-webui-autostart` | Disable WebUI autostart |
| `--token-file <path>` | Read Telegram bot token from a file |
| `--disable-telegram` | Disable Telegram during initialization |
| `--enable-discord` | Enable Discord during initialization |
| `--discord-token-file <path>` | Read Discord bot token from a file |
| `--discord-client-id <id>` | Set Discord application/client ID |
| `--enable-slack` | Enable Slack during initialization |
| `--slack-bot-token-file <path>` | Read Slack bot token from a file |
| `--slack-app-token-file <path>` | Read Slack Socket Mode app token from a file |
| `--slack-signing-secret-file <path>` | Read Slack signing secret from a file |
| `--enable-matrix` | Enable Matrix during initialization |
| `--matrix-homeserver-url <url>` | Set Matrix homeserver URL |
| `--matrix-access-token-file <path>` | Read Matrix access token from a file |
| `--matrix-user-id <id>` | Set Matrix bot user ID |
| `--matrix-device-id <id>` | Set optional Matrix device ID |
| `--admin-email <email>` | Create the first admin with this email |
| `--admin-name <name>` | Set admin display name |
| `--admin-password-file <path>` | Read admin password from a file |
| `--telegram-user-id <id>` | Link the first admin to a Telegram user ID |
| `--discord-user-id <id>` | Link the first admin to a Discord user ID |
| `--slack-user-id <id>` | Link the first admin to a Slack user ID |
| `--slack-team-id <id>` | Link the first admin to a Slack team/workspace |
| `--matrix-user-id-link <id>` | Link the first admin to a Matrix user ID |
| `--matrix-homeserver <url>` | Store the linked Matrix homeserver |
| `--state-backend json|sqlite` | Select the state backend |
| `--enable-pi` | Enable Pi |
| `--enable-hermes` | Enable Hermes |
| `--enable-openclaw` | Enable OpenClaw |
| `--enable-claude-code` | Enable Claude Code |
| `--disable-codex` | Disable Codex |

Inline token flags exist for automation, but file-based options are safer for secrets.

## Examples

Interactive setup:

```bash
nordrelay init
```

Browser-only setup:

```bash
nordrelay init --disable-telegram
```

Use a custom state directory:

```bash
nordrelay init --home /srv/nordrelay
```

## Notes

The default config path is `~/.nordrelay/nordrelay.env`. If no chat adapter is enabled, the WebUI can be the only access surface as long as `NORDRELAY_WEBUI_ENABLED=true`.
