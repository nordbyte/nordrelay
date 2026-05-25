# OpenClaw + TweetClaw

This guide shows how to run [TweetClaw](https://github.com/Xquik-dev/tweetclaw) from NordRelay-controlled OpenClaw sessions. Use it when approved users need X/Twitter reads, follower exports, media workflows, monitor setup, or reviewed posting through the WebUI or chat adapters.

TweetClaw is an OpenClaw plugin published as [`@xquik/tweetclaw`](https://www.npmjs.com/package/@xquik/tweetclaw). It registers a free `explore` catalog tool and an optional `tweetclaw` live endpoint tool for structured Xquik API calls.

## Control-plane split

Keep the two configuration layers separate:

| Layer | Stores | Keep out of |
| --- | --- | --- |
| NordRelay | OpenClaw Gateway URL, agent selection, launch profile defaults, chat users, peer scopes | TweetClaw API keys and payment signing keys |
| OpenClaw + TweetClaw | TweetClaw plugin install, `tools.alsoAllow`, Xquik API key, optional MPP signing key | NordRelay prompts, chat messages, issue reports, logs, screenshots |

NordRelay only needs to reach the OpenClaw Gateway. TweetClaw credentials should stay in OpenClaw plugin config on the host running OpenClaw.

## Prepare OpenClaw

Install TweetClaw on the OpenClaw host:

```bash
openclaw plugins install @xquik/tweetclaw
```

Allow the optional tools without replacing the normal coding profile:

```bash
openclaw config set tools.alsoAllow '["explore", "tweetclaw"]'
```

Verify runtime loading:

```bash
openclaw plugins inspect tweetclaw --runtime
openclaw skills info tweetclaw
```

Expected result:

- `tweetclaw` plugin loads.
- `explore` is available for free endpoint discovery.
- `tweetclaw` is available when the current tool profile allows optional plugin tools.
- The TweetClaw skill is visible to the OpenClaw agent.

## Store credentials on the OpenClaw host

Use environment variables from a local secret store, then write only the configured value into OpenClaw plugin config. Do not paste raw keys into NordRelay chat, WebUI prompts, workflow variables, peer prompts, or troubleshooting output.

Account-backed automation:

```bash
openclaw config set plugins.entries.tweetclaw.config.apiKey "$XQUIK_API_KEY"
```

Optional MPP read-only mode:

```bash
openclaw config set plugins.entries.tweetclaw.config.tempoSigningKey "$MPP_SIGNING_KEY"
```

MPP mode is read-only. It is useful for eligible public reads, but it cannot post, reply, upload media, send DMs, create monitors, manage webhooks, run extraction jobs, or run giveaway draws.

## Enable OpenClaw in NordRelay

Set NordRelay to expose OpenClaw sessions and point it at the Gateway:

```dotenv
NORDRELAY_OPENCLAW_ENABLED=true
NORDRELAY_DEFAULT_AGENT=openclaw
OPENCLAW_GATEWAY_URL=ws://127.0.0.1:18789
OPENCLAW_GATEWAY_TOKEN=
OPENCLAW_GATEWAY_PASSWORD=
OPENCLAW_AGENT_ID=main
OPENCLAW_DEFAULT_PROFILE=safe
```

Run checks before opening access to other users:

```bash
nordrelay doctor
nordrelay web
```

In chat, confirm the selected target and agent:

```text
/nodes
/agent
/sessions
/launch
```

Use the `safe` or `readonly` OpenClaw launch profile for discovery, audits, and public reads. Switch to `deliver` only when the user expects a final action and the OpenClaw Gateway is configured for that mode.

## Useful chat prompts

Start with catalog discovery:

```text
/prompt Use TweetClaw explore to list tweet search endpoints. Do not make a live request.
```

Run a narrow public read:

```text
/prompt Search public tweets about "openclaw agents", limit 10. Summarize tweet ids, authors, and URLs.
```

Prepare a reviewed post:

```text
/prompt Draft a reply to this tweet: https://x.com/example/status/123. Show the exact final text and wait for approval before posting.
```

Set up a monitor only after the user chooses the target and event types:

```text
/prompt Create a monitor for @example that tracks new tweets only. Explain the target and recurring behavior before calling TweetClaw.
```

## Workflow pattern

For repeatable TweetClaw work, build a NordRelay workflow with these steps:

1. `explore` the relevant endpoint category.
2. Read or estimate the requested scope with a narrow default limit.
3. Insert a manual approval step before any paid, private, recurring, or state-changing action.
4. Call `tweetclaw` only after approval.
5. Summarize the result and include stable ids or URLs when available.

This works well for weekly trend reviews, follower exports, giveaway draw preparation, monitor audits, and reviewed post drafts. Keep workflow variables explicit: target account, query, limit, event types, selected X account, and stop condition.

## Approval checks

NordRelay mirrors OpenClaw approval requests from the Gateway. Before choosing Proceed, review:

- selected X account
- target tweet, user, list, community, keyword, or webhook destination
- `path`, `method`, `query`, and `body` for the `tweetclaw` call
- final post or reply text
- media URLs or uploaded file references
- result limit, recurring monitor scope, or extraction scope

Deny the request if the tool call expands the target, uses a different account, adds unrequested mentions or links, reads private data without permission, or attempts a write when only MPP read-only mode is configured.

## Peer nodes

When a chat context targets a peer node, configure OpenClaw and TweetClaw on that peer host. Do not send keys through `/prompt`, workflow variables, peer messages, or channel files. The peer should already have:

- OpenClaw Gateway reachable from that NordRelay instance
- TweetClaw installed and inspected
- `tools.alsoAllow` configured for `explore` and `tweetclaw`
- local plugin config containing the required Xquik API key or MPP signing key

Use peer workspace allow-lists and user groups to keep social workflows scoped to the repositories and operators that need them.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `/agent` does not show OpenClaw | Set `NORDRELAY_OPENCLAW_ENABLED=true`, restart NordRelay, and run `nordrelay doctor`. |
| OpenClaw is listed but unhealthy | Check `OPENCLAW_GATEWAY_URL`, token or password, and Gateway health. |
| TweetClaw skill is visible but tools are unavailable | Run `openclaw config set tools.alsoAllow '["explore", "tweetclaw"]'` and inspect the runtime. |
| Live calls return setup guidance | Configure `apiKey` or `tempoSigningKey` in OpenClaw plugin config on the OpenClaw host. |
| MPP calls cannot post or create monitors | Expected. MPP mode is read-only and covers only eligible read endpoints. |
| Monitor prompts feel too broad | Ask for one target, event types, delivery expectation, and stop condition before approving. |

For current TweetClaw setup details, use the [TweetClaw README](https://github.com/Xquik-dev/tweetclaw#readme). For account setup and current Xquik billing details, use the [Xquik docs](https://docs.xquik.com/guides/billing).
