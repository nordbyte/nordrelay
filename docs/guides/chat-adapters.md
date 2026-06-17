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

## Local and peer nodes

Use `/nodes` to choose where this chat context should operate:

- `Local node`: sessions and prompts run on the NordRelay instance that received the chat message
- peer node: sessions and prompts are forwarded to a trusted NordRelay peer with the required peer scopes

After selecting a node, `/sessions` lists only sessions for that node and the current agent. The `/sessions` response includes the selected node and agent in the heading.

Use `/target local` or `/target <peer-id>` when you want to switch directly without opening the picker.

## Mirroring

Mirror mode controls whether activity from the selected session is sent into chat:

- `off`: do not send activity from this session into the chat
- `on`: send the prompt, live assistant text updates, and the final assistant answer, matching the WebUI chat behavior

On Telegram, sending only `/mirror` opens inline buttons for `off` and `on`.

Mirroring can run in multiple channels at once, for example a CLI prompt mirrored to Telegram and Discord.
