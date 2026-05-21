# Architecture

NordRelay is organized around a small runtime core with adapter-specific modules around it.

## Runtime

| Area | Source |
| --- | --- |
| Runtime orchestration | `src/runtime/` |
| Prompt queues and queue planner | `src/runtime/`, `src/state/queue-plan-store.ts` |
| Workflows | `src/runtime/relay-workflow-service.ts`, `src/state/workflow-store.ts` |
| Worktrees | `src/worktrees/` |
| Metrics | `src/runtime/metrics.ts`, `src/state/metrics-history-store.ts` |
| State persistence | `src/state/` |

## Agents

Agent adapters live under:

```text
src/agents/
```

Each adapter owns its CLI/API discovery, launch defaults, session parsing, state extraction, auth checks, and capability mapping. Shared contracts live in `src/agents/shared/`.

## Channels

Chat adapters live under:

```text
src/channels/
```

Telegram, Discord, Slack, and Matrix share command core, rendering helpers, queue handling, artifacts, mirror controllers, rate limiting, and prompt execution services where possible.

## WebUI

The WebUI server and API routes live under:

```text
src/web/
```

Client modules are under:

```text
src/web/ui/client/
```

Static assets are built, minified, and precompressed by `scripts/build-web-assets.mjs`.

## Access control

User, group, channel, lock, and audit logic lives under:

```text
src/access/
```

The same user system is used by the WebUI and all chat adapters.

## Peers

Peer federation lives under:

```text
src/peers/
```

It provides identity, TLS pinning, pairing, scoped RPC, topology, health history, discovery, and outbound relay mode.

## Support and diagnostics

Operational helpers live under:

```text
src/support/
```

This includes `doctor`, autostart integration, support bundles, and zip writing.
