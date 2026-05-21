# Chat adapters

Chat adapters let approved users control sessions outside the browser.

## Supported adapters

| Adapter | Enable key | Setup |
| --- | --- | --- |
| Telegram | `TELEGRAM_ENABLED` | BotFather token, linked Telegram user, registered chat/topic |
| Discord | `DISCORD_ENABLED` | Discord bot token, client ID, slash commands, linked user, registered channel |
| Slack | `SLACK_ENABLED` | Slack bot token, Socket Mode app token or signing secret, linked user, registered channel |
| Matrix | `MATRIX_ENABLED` | Homeserver URL, bot user token, bot user ID, optional device ID, registered room |

## Setup wizard

Open **Settings**, then **Setup wizard**. Choose Telegram, Discord, Slack, or Matrix. The wizard explains where each external value comes from and saves only changed settings.

## Access checks

A chat message is accepted only when all relevant checks pass:

1. the adapter is enabled and healthy
2. the external user is linked to a NordRelay user
3. that user is active and has the required group permissions
4. the channel, topic, guild, team, or room is registered or allowed

Unauthenticated linking commands are intentionally limited. Normal commands and typing/status indicators must not leak to unregistered users.

## Common command set

Most chat adapters support the same commands:

```text
/help
/nodes
/session
/sessions
/agent
/model
/reasoning
/fast
/launch
/mirror
/queue
/artifacts
/workflows
/last
/stop
/diagnostics
```

See [Chat commands](/reference/chat-commands) for the current shared command list.

## Mirroring

Mirror mode controls how activity from an external CLI session is sent into chat:

- `off`: no CLI mirroring
- `status`: status and completion summaries
- `final`: user prompt and final answer
- `full`: streaming output, tool/status events, and final answer

Mirroring can run in multiple channels at once, for example a CLI prompt mirrored to Telegram and Discord.
