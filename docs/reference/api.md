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
| `/api/workflows` | Workflow and template management |
| `/api/workflow-triggers/:token/run` | Token-authenticated workflow trigger webhook |
| `/api/peers` | Peer management and proxying |

Use the generated route and type files in `src/web/` when integrating with the internal WebUI contract.
