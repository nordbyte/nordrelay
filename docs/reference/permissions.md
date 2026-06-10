# Permissions

NordRelay permissions are the runtime scopes used by WebUI users, API tokens,
chat commands, peer invitations, and peer proxy calls. Admin groups can grant all
permissions, while restricted groups can grant only the rows needed for a user or
automation flow.

| Permission | Allows |
| --- | --- |
| `inspect` | Read status, health, profile, bootstrap, jobs, metrics, and basic runtime state |
| `sessions.read` | Read sessions, activity, trace, active-session state, worktrees, and chat history |
| `sessions.write` | Create, switch, attach, sync, name, hand back, and manage session/worktree state |
| `prompt.send` | Send prompts, uploads, retries, and plugin/workflow prompt actions |
| `prompt.abort` | Stop prompts and answer approval/abort controls |
| `files.read` | Read artifacts, previews, diffs, downloads, and chat attachments |
| `files.write` | Delete, clean up, bulk-update, zip, or plugin-process artifacts |
| `settings.read` | Read settings, models, control options, and launch settings |
| `settings.write` | Change settings, models, reasoning, fast mode, launch profile, mirror, or wizard values |
| `auth.manage` | Manage login, logout, MFA, passkeys, recovery codes, linked identities, and API tokens |
| `diagnostics.read` | Read diagnostics, doctor output, voice diagnostics, and support bundles |
| `logs.read` | Read runtime and update logs |
| `logs.clear` | Clear runtime and update logs |
| `queue.read` | Read active prompt queues |
| `queue.write` | Enqueue, reorder, pause, resume, cancel, or run queued prompts |
| `queue.plan.read` | Read planned queue items and Kanban-style prompt drafts |
| `queue.plan.write` | Create, edit, move, or delete planned queue items |
| `queue.plan.approve` | Approve planned prompts into the real runtime queue |
| `projects.read` | Read projects, linked sessions, summaries, plans, and project jobs |
| `projects.write` | Create, edit, delete, link sessions, and save project summary or plan text |
| `projects.run` | Start or cancel Project summary and planning analysis jobs |
| `workflows.read` | Read templates, workflows, versions, dry-runs, triggers, and run reports |
| `workflows.write` | Create, edit, import, export, rollback, delete, and manage workflow/template versions |
| `workflows.run` | Run workflows, templates, plugin commands, and workflow-trigger actions |
| `plugins.read` | Read installed plugins, catalog, marketplace, logs, panels, events, diagnostics, and jobs |
| `plugins.install` | Install, remove, validate, scaffold, update, roll back, and start plugin jobs |
| `plugins.enable` | Enable or disable installed plugins |
| `plugins.settings.write` | Change plugin settings |
| `updates.run` | Run NordRelay and agent updates and control update jobs |
| `system.restart` | Restart NordRelay from WebUI or chat |
| `users.read` | Read users, groups, linked chat contexts, channels, and permission metadata |
| `users.write` | Create or update users, groups, linked identities, and registered chat contexts |
| `audit.read` | Read audit events |
| `peers.read` | Read peer configuration, topology, relay state, and peer snapshots |
| `peers.write` | Pair, sync, edit, repair, rotate, revoke, invite, or restore peers |
| `peers.connect` | Probe peers, proxy remote WebUI calls, read peer diagnostics, and receive peer events |

Peer invitations also store allowed agents, workspace roots, workspace aliases,
and optional peer allow-lists. Empty allow-lists mean "all" for that scope.
