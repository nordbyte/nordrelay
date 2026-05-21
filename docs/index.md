---
layout: home
hero:
  name: NordRelay
  text: Remote control for coding agents.
  tagline: Operate Codex, Pi, Hermes, OpenClaw, and Claude Code sessions through a login-protected WebUI, chat adapters, and trusted peer nodes.
  image:
    src: /nordrelay-logo.png
    alt: NordRelay logo
  actions:
    - theme: brand
      text: Quickstart
      link: /start/quickstart
    - theme: alt
      text: CLI reference
      link: /commands/
    - theme: alt
      text: GitHub
      link: https://github.com/nordbyte/nordrelay
features:
  - title: One control plane
    details: Use the same session controls from the WebUI, Telegram, Discord, Slack, Matrix, and paired NordRelay nodes.
  - title: Multi-agent by design
    details: Route prompts to Codex, Pi, Hermes, OpenClaw, or Claude Code without changing the user and permission model.
  - title: Secure by default
    details: WebUI login, user groups, linked chat identities, registered channels, scoped peers, and redacted diagnostics are built in.
---

<img class="nordrelay-home-image" src="/nordrelay-hero.png" alt="NordRelay control plane hero image">

## What NordRelay is

NordRelay is a local-first bridge for coding-agent sessions. It keeps private runtime state in `~/.nordrelay`, exposes a login-protected WebUI, and can connect approved users to selected chat channels and trusted peer nodes.

It is useful when you want to keep a coding agent running on a workstation or server, monitor active sessions, queue prompts, approve actions, stream results, transfer artifacts, or control agents across machines without opening broad unauthenticated access.

## Fast path

```bash
npm install -g @nordbyte/nordrelay
nordrelay init
nordrelay doctor
nordrelay web
```

Open the URL printed by `nordrelay web`. The first WebUI run creates the initial admin user. After that, every dashboard page, API route, chat command, artifact download, and event stream requires an authenticated NordRelay user.

## Main surfaces

<div class="nordrelay-grid">
  <div class="nordrelay-card">
    <h3>WebUI</h3>
    <p>Chat, sessions, queue planning, workflows, users, settings, peers, logs, diagnostics, metrics, versions, and artifacts.</p>
  </div>
  <div class="nordrelay-card">
    <h3>Chat adapters</h3>
    <p>Telegram, Discord, Slack, and Matrix share the same command core, linked-user access checks, queue behavior, mirroring, and artifacts.</p>
  </div>
  <div class="nordrelay-card">
    <h3>Peer federation</h3>
    <p>Pair NordRelay instances with explicit codes, TLS fingerprints, scopes, workspace allow-lists, and optional outbound relay mode.</p>
  </div>
  <div class="nordrelay-card">
    <h3>Agent adapters</h3>
    <p>Codex, Pi, Hermes, OpenClaw, and Claude Code adapters expose sessions, launch profiles, model controls, approvals, updates, and diagnostics where supported.</p>
  </div>
</div>

## Next steps

- Install and initialize NordRelay in [Installation](/start/install).
- Create the first admin and run checks in [Quickstart](/start/quickstart).
- Learn the runtime model in [Core concepts](/start/core-concepts).
- Configure adapters in [Chat adapters](/guides/chat-adapters) and [Agents](/guides/agents).
- Use the CLI reference in [Commands](/commands/).
