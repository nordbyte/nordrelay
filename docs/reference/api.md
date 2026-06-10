# Web API

The WebUI uses internal HTTP and SSE endpoints. They are part of the local dashboard contract and require authentication unless explicitly used during first-run setup or login.

## Authentication and profile

| Endpoint group | Purpose |
| --- | --- |
| `/api/auth/me` | Current authenticated user |
| `/api/dashboard/logout` | Logout |
| `/api/profile` | Profile data and preferences |
| `/api/profile/password` | Change password |
| `/api/profile/logout-other-sessions` | Revoke other sessions |
| `/api/profile/mfa/totp/*` | Setup, enable, disable, and recover authenticator MFA |
| `/api/profile/webauthn/*` | Register or remove passkeys |
| `/api/profile/api-tokens` | Create and revoke scoped API tokens |
| `/api/profile/sessions/:id` | Revoke an own web session |

Browser sessions use the `nr_session` cookie plus CSRF tokens for mutations. Automation can use scoped Bearer API tokens created from the profile menu; token calls still go through the normal permission and scope checks.

## Dashboard and runtime

| Endpoint group | Purpose |
| --- | --- |
| `/api/bootstrap` | Initial WebUI bootstrap data |
| `/api/health` | Connector health |
| `/api/snapshot` | Dashboard snapshot |
| `/api/active-sessions` | Active local and peer sessions |
| `/api/tasks` | Queue and task data |
| `/api/progress` | Runtime progress stream/data |
| `/api/metrics` | Current metrics |
| `/api/metrics/history` | Metrics history |
| `/api/metrics/observability` | Poller, cache, peer roundtrip, and SSE diagnostics |
| `/api/jobs` | Unified jobs |
| `/api/trace` | Trace timeline |

## Sessions and prompts

| Endpoint group | Purpose |
| --- | --- |
| `/api/sessions` | Session listing and details |
| `/api/prompt` | Submit prompts |
| `/api/prompt/upload` | Upload attachments |
| `/api/abort` | Abort active work |
| `/api/stop` | Stop active work |
| `/api/retry` | Retry prompt/message |
| `/api/sync` | Sync selected session state |
| `/api/chat/history` | WebUI chat history |
| `/api/chat/mirror` | Mirror settings |

## Administration

| Endpoint group | Purpose |
| --- | --- |
| `/api/users` | User management |
| `/api/groups` | Group management |
| `/api/telegram-chats` | Registered Telegram chats |
| `/api/discord-channels` | Registered Discord channels |
| `/api/slack-channels` | Registered Slack channels |
| `/api/matrix-rooms` | Registered Matrix rooms |
| `/api/audit` | Audit events |
| `/api/locks` | User lock state |
| `/api/settings` | Runtime settings |
| `/api/doctor` | Doctor checks |
| `/api/diagnostics` | Diagnostics and support bundles |

## Operations

| Endpoint group | Purpose |
| --- | --- |
| `/api/version` | NordRelay and agent versions |
| `/api/update` | NordRelay update |
| `/api/agent-updates` | Agent update jobs |
| `/api/adapters/health` | Adapter health |
| `/api/adapters/conformance` | Adapter conformance |
| `/api/logs` | Logs |
| `/api/artifacts` | Artifact listing and actions |
| `/api/projects` | Project records, linked sessions, summaries, plans, and analysis jobs |
| `/api/workflows` | Workflow and template management |
| `/api/workflow-triggers/:token/run` | Token-authenticated workflow trigger webhook |
| `/api/peers` | Peer management and proxying |

## Runtime contract coverage

The docs check verifies that every namespace below exists in the generated WebUI
route contract:

| Namespace | Area |
| --- | --- |
| `/api/abort/*` | Prompt abort alias |
| `/api/active-sessions/*` | Active local and peer sessions |
| `/api/activity/*` | Session activity |
| `/api/adapters/*` | Adapter health and conformance |
| `/api/agent/*` | Selected agent |
| `/api/agent-update/*` | Agent update job detail |
| `/api/agent-updates/*` | Agent update jobs |
| `/api/approvals/*` | Runtime approval responses |
| `/api/artifacts/*` | Artifact management |
| `/api/audit/*` | Audit events |
| `/api/auth/*` | Authentication |
| `/api/bootstrap/*` | WebUI bootstrap |
| `/api/chat/*` | WebUI chat state |
| `/api/control-options/*` | Control dropdown data |
| `/api/dashboard/*` | Dashboard session lifecycle |
| `/api/diagnostics/*` | Diagnostics and support bundles |
| `/api/discord-channels/*` | Discord channel access |
| `/api/doctor/*` | Doctor checks and fixes |
| `/api/groups/*` | User groups |
| `/api/handback/*` | Session handback |
| `/api/health/*` | Health |
| `/api/jobs/*` | Unified jobs |
| `/api/locks/*` | Locks |
| `/api/logs/*` | Logs |
| `/api/matrix-rooms/*` | Matrix room access |
| `/api/metrics/*` | Metrics and observability |
| `/api/models/*` | Agent model choices |
| `/api/peers/*` | Peer management, proxying, relay, and debugging |
| `/api/permissions/*` | Permission metadata |
| `/api/plugins/*` | Plugins, marketplace, panels, jobs, and commands |
| `/api/profile/*` | Profile, MFA, passkeys, tokens, and sessions |
| `/api/progress/*` | Runtime progress |
| `/api/projects/*` | Projects, linked sessions, summaries, plans, and analysis jobs |
| `/api/prompt/*` | Prompt submission and uploads |
| `/api/queue/*` | Runtime and planned queues |
| `/api/retry/*` | Prompt retry |
| `/api/runtime/*` | Runtime control |
| `/api/session/*` | Session settings |
| `/api/sessions/*` | Session listing, details, names, attach, and worktrees |
| `/api/settings/*` | Settings and setup wizard |
| `/api/slack-channels/*` | Slack channel access |
| `/api/snapshot/*` | Dashboard snapshot |
| `/api/stop/*` | Prompt stop alias |
| `/api/sync/*` | Session sync |
| `/api/tasks/*` | Tasks |
| `/api/telegram-chats/*` | Telegram chat access |
| `/api/templates/*` | Workflow templates |
| `/api/trace/*` | Trace timeline |
| `/api/update/*` | NordRelay update |
| `/api/users/*` | Users and linked identities |
| `/api/version/*` | Version checks |
| `/api/workflow-runs/*` | Workflow run lifecycle |
| `/api/workflow-triggers/*` | Token-authenticated workflow triggers |
| `/api/workflows/*` | Workflows, versions, triggers, and runs |

Use the generated route and type files in `src/web/` when integrating with the internal WebUI contract.
