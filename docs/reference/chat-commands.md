# Chat commands

Telegram, Discord, Slack, and Matrix share the same core command catalog where their platform APIs allow it. Normal commands require a linked NordRelay user and a registered channel context.

## Access and setup

| Command | Purpose |
| --- | --- |
| `/start` | Show the welcome and current context |
| `/help` | Show command help |
| `/link` | Link the current chat identity to a NordRelay user |
| `/whoami` | Show the linked NordRelay user |
| `/register_chat` | Admin: enable the current Telegram group chat |
| `/register_channel` | Enable the current Discord, Slack, or Matrix channel |
| `/channels` | Show messaging adapter status |

Some adapters expose limited unauthenticated link or registration commands. All normal session, queue, file, workflow, and admin commands require an authenticated NordRelay user with the matching group permissions.

## Node and agent selection

| Command | Purpose |
| --- | --- |
| `/peers` | Show paired NordRelay instances |
| `/nodes` | Select the local node or a trusted peer node |
| `/target` | Set the local or peer target directly |
| `/agents` | Show agent adapter status |
| `/agent` | Select or show the active agent |
| `/auth` | Show selected agent authentication status |
| `/login` | Start selected agent login |
| `/logout` | Sign out of the selected agent |
| `/workspaces` | List allowed workspaces |

Use `/nodes` when the chat context should switch between the local NordRelay node and a trusted peer node. NordRelay shows the local node plus selectable peers as buttons where the adapter supports interactive actions.

```text
/nodes
```

After a node is selected, `/sessions` lists sessions for that node and the currently selected agent. The response header includes the node name and agent so it is clear whether you are browsing local or peer sessions.

Use `/target` for direct selection when you already know the peer name, peer ID, or node ID:

```text
/target local
/target <peer-id>
```

Selecting a peer requires the chat user to have peer access permissions and the peer to expose the needed scopes, including session read/write and prompt access.

## Sessions

| Command | Purpose |
| --- | --- |
| `/new` | Start a new thread |
| `/session` | Show current thread details |
| `/sessions` | Browse and switch threads on the selected node |
| `/switch` | Switch to a thread by ID |
| `/attach` | Bind a session to this topic or channel context |
| `/handback` | Hand the active session back to the native CLI |
| `/sync` | Sync active session metadata from local agent state |
| `/pinned` | Show pinned threads |
| `/pin` | Pin the current or given thread |
| `/unpin` | Unpin the current or given thread |

## Prompt and turn control

| Command | Purpose |
| --- | --- |
| `/prompt` | Send a prompt to the selected agent |
| `/retry` | Resend the last prompt |
| `/last` | Resend the last agent reply |
| `/abort` | Cancel the current operation |
| `/stop` | Cancel the current operation |
| `/model` | View and change model when supported |
| `/reasoning` | Set reasoning effort when supported |
| `/effort` | Set reasoning effort when supported |
| `/fast` | Toggle fast mode when supported |
| `/launch` | Select or apply launch profile when supported |
| `/launch_profiles` | Select or apply launch profile when supported |
| `/mirror` | Control CLI mirroring; Telegram opens an inline mode picker when no mode is provided |
| `/notify` | Control completion notifications |
| `/voice` | Show or change voice transcription settings |

## Queue and workflows

| Command | Purpose |
| --- | --- |
| `/queue` | Inspect, reorder, pause, resume, run, or cancel queued prompts |
| `/cancel` | Cancel a queued prompt |
| `/clearqueue` | Clear queued prompts |
| `/templates` | List prompt templates |
| `/template` | Run a prompt template |
| `/workflows` | List workflows |
| `/workflow` | Run a workflow |

## Monitoring and diagnostics

| Command | Purpose |
| --- | --- |
| `/tasks` | Show recent task and queue state |
| `/progress` | Show current turn progress |
| `/activity` | Show recent thread activity |
| `/audit` | Admin: show recent audit events |
| `/artifacts` | List or resend generated files according to delivery rules |
| `/status` | Show connector runtime status |
| `/health` | Show connector health report |
| `/version` | Show NordRelay and agent versions |
| `/logs` | Admin: show connector logs |
| `/diagnostics` | Admin: show connector diagnostics |
| `/support` | Admin: export a redacted diagnostics bundle where supported |

## Locks and administration

| Command | Purpose |
| --- | --- |
| `/lock` | Lock session writes to the current user |
| `/unlock` | Release the session write lock |
| `/locks` | List session write locks |
| `/restart` | Admin: restart NordRelay |
| `/update` | Admin: update NordRelay or agents |

## Matrix prefix

Matrix text commands use the configured prefix:

```dotenv
MATRIX_COMMAND_PREFIX=!nr
```

For example:

```text
!nr session
```
