# `nordrelay user`

Manage users and chat identity links.

## Usage

```bash
nordrelay user <subcommand> [options]
```

## Subcommands

| Subcommand | Purpose |
| --- | --- |
| `list` | List configured users |
| `create-admin` | Create an admin user |
| `create` | Create a normal user |
| `reset-password` | Set a new password |
| `link-telegram` | Link a Telegram user ID |
| `link-discord` | Link a Discord user ID |
| `link-slack` | Link a Slack user ID and optional team ID |
| `link-matrix` | Link a Matrix user ID and optional homeserver |
| `link-code` | Create a Telegram link code |
| `telegram-link-code` | Create a Telegram link code |
| `discord-link-code` | Create a Discord link code |
| `slack-link-code` | Create a Slack link code |
| `matrix-link-code` | Create a Matrix link code |

## Options

| Option | Description |
| --- | --- |
| `--email <email>` | Target user email |
| `--name <name>` | Display name for new users |
| `--password <password>` | Password for automation; prefer interactive input or secret files where possible |
| `--group <ids>` / `--groups <ids>` | Comma-separated group IDs for `create` |
| `--telegram-user-id <id>` | Telegram account ID |
| `--discord-user-id <id>` | Discord account ID |
| `--slack-user-id <id>` | Slack account ID |
| `--slack-team-id <id>` | Slack workspace/team ID |
| `--matrix-user-id <id>` | Matrix user ID |
| `--matrix-homeserver <url>` | Matrix homeserver URL |

## Examples

```bash
nordrelay user list
nordrelay user create-admin --email admin@example.com --name Admin
nordrelay user create --email user@example.com --name User --groups user
nordrelay user reset-password --email user@example.com
nordrelay user link-telegram --email user@example.com --telegram-user-id <id>
nordrelay user discord-link-code --email user@example.com
```

## Notes

The WebUI **Users** page provides the same core management flow with additional audit, group, channel, and lock views.
