# Commands

## Telegram Commands

- `/start` shows welcome text and the selected launch profile.
- `/help` shows the grouped command reference.
- `/channels` shows available and planned messaging adapters.
- `/agents` shows available and planned coding-agent adapters.
- `/agent` selects the active agent for this Telegram context.
- `/peers` shows configured NordRelay peer instances.
- `/target local|<peer-id>` selects whether prompts for this chat run locally or on a paired peer.
- `/link <code>` links the Telegram account to a NordRelay user.
- `/whoami` shows the linked NordRelay user, groups, and permissions.
- `/register_chat` enables the current Telegram group or forum chat for NordRelay when the linked user has user-management permission.
- `/new` starts a new thread. If the selected agent knows multiple workspaces, Telegram shows a workspace picker.
- `/session` shows current thread details.
- `/sessions` opens a paginated recent-session picker.
- `/sessions <query>` searches recent sessions.
- `/sync` syncs the active session from local CLI state when supported.
- `/pinned` opens a pinned-thread picker.
- `/pin [thread-id]` pins a thread for this Telegram context; defaults to the active thread.
- `/unpin [thread-id]` unpins a thread for this Telegram context; defaults to the active thread.
- `/switch <session-id>` switches directly to a known session.
- `/attach <session-id>` binds a known session to the current chat or forum topic.
- `/handback` detaches the active session and prints the native CLI resume command.
- `/retry` resends the last prompt for this Telegram context.
- `/last [count]` resends the last agent reply for the active thread. `count` can resend up to 5 recent agent replies.
- `/templates` lists saved prompt templates.
- `/template <template-id> [{"variable":"value"}]` renders a saved prompt template and sends it to the active session.
- `/workflows` lists saved multi-step workflows.
- `/workflow <workflow-id> [{"variable":"value"}]` runs a saved workflow. Remaining steps are queued behind the first prompt for the chat context.
- `/queue` shows queued prompts for this Telegram context with inline run/top/up/down/cancel buttons.
- `/queue pause` pauses automatic queued prompt execution.
- `/queue resume` resumes automatic queued prompt execution.
- `/queue later <minutes> <prompt>` schedules a prompt for later execution.
- `/queue inspect <queue-id>` shows one queued prompt with created time, schedule time, attempts, and last error.
- `/queue move <queue-id> top|up|down` changes queued prompt priority.
- `/queue run <queue-id>` resumes the queue and runs that prompt next when the session is idle.
- Queued prompt replies include a cancel button while the prompt is still waiting.
- `/cancel <queue-id>` removes one queued prompt; the queue id is the short code shown in messages such as `Queued prompt 332kmt`.
- `/clearqueue` clears queued prompts for this Telegram context.
- `/activity [all|tools|errors|user|agent|tasks] [limit] [since 1h] [export]` shows or exports rollout activity for the active thread.
- `/audit [limit]` shows recent audit events. Requires `audit.read`.
- `/lock` locks writes for this Telegram session to the current user.
- `/unlock` releases the current session write lock.
- `/locks` lists active write locks.
- `/artifacts [latest|zip latest|turn-id|images|docs|search <text>|delete <turn-id>]` lists, filters, resends, zips, searches, or deletes generated artifacts for the current workspace.
- `/workspaces` lists workspaces known to the selected agent and allowed by the workspace policy.
- `/abort` cancels the current operation.
- `/stop` is an alias for `/abort`.
- `/launch_profiles` or `/launch` opens the launch profile picker. `/launch <profile-id> apply` applies a launch profile to the current idle thread; unsafe profiles require `confirm apply`.
- `/fast [on|off]` toggles Codex fast mode. Without an argument it flips the current state.
- `/model` opens the model picker.
- `/reasoning` opens the selected agent's reasoning or thinking picker.
- `/effort` is a backward-compatible alias for `/reasoning`.
- `/mirror [off|status|final|full]` controls local CLI mirroring for this chat context.
- `/notify [off|minimal|all]` controls Telegram notifications.
- `/notify quiet HH-HH` sets quiet hours; `/notify quiet off` disables them.
- `/auth` reports Codex authentication status, Pi provider environment health, Hermes API Server reachability, OpenClaw Gateway reachability, or Claude Code CLI auth for the selected agent.
- `/login` starts Telegram-initiated CLI login for Codex, Hermes, or Claude Code when one of those agents is selected.
- `/logout` signs out from CLI auth for Codex, Hermes, or Claude Code when one of those agents is selected; Codex logout is disabled while `CODEX_API_KEY` is active.
- `/voice` reports voice transcription backends and current voice preferences.
- `/voice backend auto|parakeet|faster-whisper|openai` selects backend preference.
- `/voice language auto|<code>` selects transcription language.
- `/voice transcribe_only on|off` controls whether voice is only transcribed or also sent to the selected agent.
- `/tasks` or `/progress` reports the current turn and queue progress.
- `/status` reports connector runtime status.
- `/health` reports runtime health, auth, PIDs, Codex CLI, Pi CLI, Hermes CLI, OpenClaw CLI, Claude Code CLI, and state DB.
- `/version` reports connector, Codex CLI, Pi CLI, Hermes CLI, OpenClaw CLI, and Claude Code CLI paths plus installed/latest NordRelay, Codex, Pi, Hermes, OpenClaw, and Claude Code versions with status icons.
- `/logs [lines]` shows a redacted, timestamped connector log tail. Requires `logs.read`.
- `/logs update [lines]` shows the self-update log. Requires `logs.read`.
- `/logs agent [lines]` shows the aggregate agent updater log. Requires `logs.read`.
- `/logs all [lines]` shows connector, self-update, and agent update logs together. Requires `logs.read`.
- `/diagnostics` shows redacted connector diagnostics. Requires `diagnostics.read`.
- `/support` exports a redacted diagnostics ZIP. Requires `diagnostics.read`.
- `/restart` restarts the connector process. Requires `system.restart`.
- `/update` updates through npm or git depending on the detected install type, then restarts only on success. Requires `updates.run`.
- `/update agents`, `/update <agent>`, `/update install <agent>`, `/update jobs`, `/update log <id>`, `/update cancel <id>`, and `/update input <id> <text>` manage agent CLI update and install jobs. Requires `updates.run`.


## Discord Commands

Discord supports slash commands and `/command` text messages for the shared command set. The primary differences from Telegram are:

- `/register_channel` replaces `/register_chat` for guild channels and threads.
- `/prompt <text>` is available for slash-command-only deployments where regular message content is disabled.
- `/link <code>` consumes Discord link codes created in the WebUI or with `nordrelay user discord-link-code`.
- `/queue`, `/sessions`, `/agent`, `/model`, `/reasoning`, `/launch`, `/artifacts`, `/update`, and `/stop` use Discord buttons where component limits allow.
- `/last [count]` resends the last agent reply for the active thread.
- `/templates`, `/template <id> [{"variable":"value"}]`, `/workflows`, and `/workflow <id> [{"variable":"value"}]` use the shared prompt-template and workflow store.
- `/peers` and `/target local|<peer-id>` use the same paired-instance target selection as Telegram.
- `/artifacts latest`, `/artifacts zip latest`, `/artifacts images`, `/artifacts docs`, `/artifacts search <text>`, and `/artifacts delete <turn-id>` are available in Discord.
- Unsafe launch profiles require explicit confirmation with `/launch <profile-id> confirm`; add `apply` to reattach the current idle thread immediately.
- Discord does not support Telegram reactions or Telegram webhook transport; typing, message edits, attachments, files, DMs, guild channels, and threads are supported.


## Slack Commands

Slack supports the configured slash command and `/command` text messages for the shared command set. The primary differences from Telegram are:

- `/register_channel` enables the current Slack channel or thread for NordRelay when the linked user has user-management permission.
- `/prompt <text>` is available through the configured slash command when regular message content is disabled.
- `/link <code>` consumes Slack link codes created in the WebUI or with `nordrelay user slack-link-code`.
- `/queue`, `/sessions`, `/agent`, `/model`, `/reasoning`, `/launch`, `/artifacts`, `/update`, and `/stop` use Slack buttons where Block Kit limits allow.
- `/last [count]` resends the last agent reply for the active thread.
- `/templates`, `/template <id> [{"variable":"value"}]`, `/workflows`, and `/workflow <id> [{"variable":"value"}]` use the shared prompt-template and workflow store.
- `/peers` and `/target local|<peer-id>` use the same paired-instance target selection as Telegram and Discord.
- `/artifacts latest`, `/artifacts zip latest`, `/artifacts images`, `/artifacts docs`, `/artifacts search <text>`, and `/artifacts delete <turn-id>` are available in Slack.
- Unsafe launch profiles require explicit confirmation with `/launch <profile-id> confirm`; add `apply` to reattach the current idle thread immediately.
- Slack does not support Telegram reactions or Telegram webhook transport; typing/status, message edits, attachments, files, DMs, channels, and threads are supported.


## Command Examples

Switching to an existing thread:

```text
/sessions
```

Tap a listed thread/session. The connector imports workspace, model, reasoning/thinking, and provider-specific metadata from the selected agent.

Direct session switch:

```text
/switch 019e178a-f275-7d01-95d6-c244ff3e30ed
```

Attach an existing CLI session to the current Telegram topic:

```text
/attach 019e178a-f275-7d01-95d6-c244ff3e30ed
```

Hand a session back to the native CLI:

```text
/handback
```

The bot replies with a command like:

```bash
cd ~/projects/my-workspace && codex resume 019e178a-f275-7d01-95d6-c244ff3e30ed
```

For Pi sessions the command looks like:

```bash
cd ~/projects/my-workspace && pi --session ~/.pi/agent/sessions/.../session.jsonl
```

For Hermes sessions the command looks like:

```bash
cd ~/projects/my-workspace && hermes --resume 20260512_181422_ab12cd34
```

For OpenClaw sessions the command looks like:

```bash
cd ~/projects/my-workspace && openclaw agent --agent main --session-id nordrelay-openclaw-a1b2c3d4e5f6 --message '<your next message>'
```

For Claude Code sessions the command looks like:

```bash
cd ~/projects/my-workspace && claude --resume 019e178a-f275-7d01-95d6-c244ff3e30ed
```

Change model:

```text
/model
```

Tap the model to use for new or reattached threads.

Change reasoning effort:

```text
/reasoning
```

For Codex choose one of `minimal`, `low`, `medium`, `high`, or `xhigh`. For Pi choose one of `off`, `minimal`, `low`, `medium`, `high`, or `xhigh`. For Hermes choose one of `none`, `minimal`, `low`, `medium`, `high`, or `xhigh`. For OpenClaw choose one of `off`, `minimal`, `low`, `medium`, `high`, or `xhigh`. For Claude Code choose one of `off`, `low`, `medium`, `high`, or `xhigh`.

Toggle fast mode:

```text
/fast
/fast on
/fast off
```

Fast mode maps to launch profiles: `on` selects an approval policy of `never`, while `off` selects an approval-requesting profile such as Review. If a thread is idle, `/fast` reattaches the current thread with the selected launch behavior immediately.

Choose launch profile:

```text
/launch_profiles
/launch readonly apply
/launch full-access confirm apply
```

Tap the profile to select it for new or reattached threads. Use `apply` when you want an idle active Codex thread to be reattached immediately with the selected launch behavior.
