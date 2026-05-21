# Chat commands

Telegram, Discord, Slack, and Matrix share the same core command behavior where their platform APIs allow it.

## Session commands

| Command | Purpose |
| --- | --- |
| `/help` | Show command help |
| `/session` | Show the selected session |
| `/sessions` | Browse and switch sessions |
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

## Matrix prefix

Matrix text commands use the configured prefix:

```dotenv
MATRIX_COMMAND_PREFIX=!nr
```

For example:

```text
!nr session
```
