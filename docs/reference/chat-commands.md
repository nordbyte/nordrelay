# Chat commands

Telegram, Discord, Slack, and Matrix share the same core command behavior where their platform APIs allow it.

## Session commands

| Command | Purpose |
| --- | --- |
| `/help` | Show command help |
| `/nodes` | Select local node or a trusted peer node |
| `/target` | Set the local or peer target directly |
| `/session` | Show the selected session |
| `/sessions` | Browse and switch sessions on the selected node |
| `/agent` | Select an agent |
| `/model` | Select a model when supported |
| `/reasoning` | Select reasoning or effort when supported |
| `/fast` | Toggle fast mode when supported |
| `/launch` | Select launch profile when supported |
| `/mirror` | Configure CLI mirror mode |
| `/last` | Resend the last agent message |
| `/stop` | Stop or abort active work |

## Queue and workflow commands

| Command | Purpose |
| --- | --- |
| `/queue` | Inspect, reorder, pause, resume, run, or cancel queued prompts |
| `/workflows` | List or run workflows and templates |
| `/tasks` | Show task and queue state |
| `/activity` | Show recent activity |

## Files, artifacts, diagnostics

| Command | Purpose |
| --- | --- |
| `/artifacts` | List and send generated artifacts according to delivery rules |
| `/logs` | Show logs where supported |
| `/version` | Show NordRelay and agent versions |
| `/diagnostics` | Show diagnostics |
| `/support` | Export a redacted diagnostics bundle where supported |

## Access commands

Some adapters expose limited unauthenticated link or registration commands, such as channel registration or link-code flows. Normal commands require a linked NordRelay user and registered channel context.

## Node selection

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

## Matrix prefix

Matrix text commands use the configured prefix:

```dotenv
MATRIX_COMMAND_PREFIX=!nr
```

For example:

```text
!nr session
```
