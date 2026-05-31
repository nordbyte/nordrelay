# Plugins

NordRelay plugins are explicit local, GitHub, or npm installs that can add workflow actions, WebUI panels, commands, adapter metadata, artifact handlers, diagnostics, and scheduled collectors.

## Storage

Plugins are stored in the NordRelay home directory:

```text
~/.nordrelay/plugins/
  installed/<plugin-id>/<version>/
  plugins.json
  logs/<plugin-id>.log
  data/<plugin-id>/
```

## Manifest

Each plugin must contain `nordrelay.plugin.json`:

```json
{
  "id": "example-plugin",
  "name": "Example Plugin",
  "version": "0.1.0",
  "entry": "index.js",
  "permissions": ["runtime.read"],
  "capabilities": {
    "workflowActions": [
      {
        "id": "example.echo",
        "title": "Echo",
        "inputSchema": {
          "type": "object",
          "properties": {
            "text": { "type": "string", "title": "Text" }
          }
        },
        "outputVariables": {
          "echoedText": "input.text"
        }
      }
    ],
    "commands": [
      { "name": "example", "title": "Example command" }
    ],
    "webPanels": [
      { "id": "status", "title": "Status panel" }
    ],
    "artifactHandlers": [
      { "id": "artifact.inspect", "title": "Inspect artifact" }
    ],
    "collectors": [
      {
        "id": "metrics.sample",
        "title": "Collect metrics",
        "intervalMs": 5000,
        "runOnStart": true
      }
    ],
    "diagnostics": true
  },
  "settings": []
}
```

Plugin ids must be lowercase and may contain letters, numbers, dots, underscores, and dashes.

## WebUI

Open **Plugins** in the Administration section to:

- inspect installed plugins
- install official or approved plugins from the Marketplace tab
- install local or GitHub plugins
- enable or disable plugins
- edit plugin settings
- view plugin logs
- inspect the extension catalog
- run plugin commands, artifact handlers, collectors, and diagnostics from the catalog
- check for updates, reinstall from the original source/ref, and roll back to a previously installed version
- view invocation metrics, failures, durations, and logs
- scaffold a new plugin directory

The Plugins page follows the selected node in the WebUI header. Select a peer before installing, enabling, configuring, or invoking plugins on that peer. The Marketplace and Install tabs can also install the same GitHub plugin on all enabled peers. Remote plugin actions require the corresponding peer scopes such as `plugins.read`, `plugins.install`, `plugins.enable`, `plugins.settings.write`, `workflows.run`, and `diagnostics.read`.

Marketplace entries are curated by NordRelay. Official approved entries install with their declared permissions approved and enabled by default. Manual local/GitHub installs remain available in the Install tab for custom or private plugins.

## Supply-chain safety

New plugin installs write an integrity lock to
`~/.nordrelay/plugins/plugins.lock.json`. The lock records the source, resolved
Git commit or npm package version, manifest hash, package hash, trust level,
signature status, and approved permission snapshot. Updates compare the new
manifest against the locked installation and require explicit approval when a
plugin adds permissions, trusted client-side panel scripts, or other capability
changes.

Marketplace plugins show trust badges such as `official`, `verified`,
`community`, `local`, or `untrusted`. Optional Ed25519 manifest signatures can be
verified when a trusted public key is configured for the install source. The CLI
supports `--require-signature`, `--signature-public-key-file`, and expected
manifest/package hashes for pinned installs.

Enabled plugins that expose WebUI panels appear as direct entries in the
**Plugins** navigation category. Opening one of those entries loads the panel as
its own WebUI page instead of embedding it inside the plugin administration
screen.

## Collectors

Enabled plugins can expose collectors for periodic local work, such as sampling system metrics. NordRelay schedules collectors for each node where the plugin is installed and enabled, invokes the plugin entry with `type: "collector"`, and leaves all collection/storage logic to the plugin.

Collector results are recorded in plugin invocation metrics. If a collector fails, NordRelay applies a bounded backoff before trying again.

## Workflow actions

Enabled plugins can expose workflow actions. A workflow step with `type: "plugin"` calls the plugin entry with JSON on stdin and reads JSON or text from stdout. If the action defines `inputSchema`, the workflow builder shows a form instead of forcing raw JSON. `outputVariables` can map result paths into workflow variables for later steps.

## Jobs and panel events

Long-running plugin commands can run as tracked jobs. Jobs expose status, logs,
progress metadata, and final results through the plugin API so panels can start
work without blocking the page request. Plugin panels can subscribe to the
plugin event stream to update job or collector state live.

Example step:

```json
{
  "name": "Run custom action",
  "type": "plugin",
  "pluginId": "example-plugin",
  "pluginActionId": "example.echo",
  "pluginInput": {
    "text": "{{message}}"
  },
  "pluginOutputVariables": {
    "echoedText": "input.text"
  },
  "sessionMode": "current",
  "target": "local",
  "requiresApproval": false,
  "continueOnError": false
}
```

String values in `pluginInput` can use workflow variables such as `{{message}}`.

## SDK

The standalone SDK lives in a separate local repository during development:

```text
/home/clawdy/projects/nordrelay-plugin-sdk
```

It provides dependency-free helpers for reading the request, checking permissions, accessing filtered host context, and writing results:

```js
import { runPlugin, ok } from "@nordbyte/nordrelay-plugin-sdk";

runPlugin(async ({ input, host }) => {
  host.requirePermission("runtime.read");
  return ok({ input, node: host.getContext("runtime")?.nodeName });
});
```

For WebUI panels, return an HTML fragment in `panel.html`. NordRelay mounts the
fragment directly into the WebUI and provides shared WebUI classes for panels,
section headers, tabs, tables, badges, chips, metrics, progress bars, buttons,
inputs, empty/loading/error states, code/log blocks, diffs, and media previews.
Use the SDK `ui` helpers where possible:

```js
import { ok, runWebPanel, ui } from "@nordbyte/nordrelay-plugin-sdk";

runWebPanel(async () => {
  return ok(undefined, {
    panel: {
      html: ui.panel(
        "Status",
        ui.metric("Health", "ok") +
          ui.table([{ key: "name", label: "Name" }], [{ name: "Local node" }])
      )
    }
  });
});
```

Interactive panels can return `panel.script` when the web panel manifest sets
`allowClientScript: true`. The script is mounted directly in the WebUI and gets
an `api` object with `api.root`, `api.reload(input)`,
`api.invokeCommand(command, input)`, `api.jobs.list()`,
`api.jobs.start(command, input)`, `api.jobs.cancel(jobId)`,
`api.events.subscribe(eventName, listener)`, `api.toast(message)`,
`api.copyText(value, label)`, `api.setInterval(fn, ms)`, and
`api.onCleanup(fn)`.

## Runtime request

NordRelay invokes the configured `entry` with a sanitized environment, the plugin data directory as working directory, and one JSON request on stdin:

```json
{
  "protocolVersion": 1,
  "type": "workflow-action",
  "pluginId": "example-plugin",
  "actionId": "example.echo",
  "input": {},
  "settings": {},
  "dataDir": "~/.nordrelay/plugins/data/example-plugin",
  "permissions": ["runtime.read"],
  "context": {}
}
```

For collector invocations, `type` is `collector` and `collectorId` contains the collector id.

Return one JSON result on stdout:

```json
{
  "ok": true,
  "output": {},
  "variables": {
    "nextStepValue": "ready"
  }
}
```

## Security

`NORDRELAY_PLUGINS_ENABLED=false` is a hard gate for the extension catalog and all plugin execution paths. Plugins are disabled until an admin enables them. Enabling a plugin approves the permissions declared in the manifest. Host context is filtered by approved plugin permissions, and plugin processes do not inherit the full NordRelay environment. Plugin execution is also bounded by a working directory, output limits, and timeouts; use operating-system isolation for untrusted third-party code. Keep `NORDRELAY_PLUGIN_ALLOW_BUILD_SCRIPTS=false` unless you explicitly trust the plugin source.

## Official plugins

Install System Monitor for peer metrics:

```sh
nordrelay plugin install github:nordbyte/nordrelay-plugin-system-monitor --enable --approve
```

Install it on every peer where metrics should be collected. Peers without the plugin are shown as unavailable in the plugin dashboard instead of returning metrics.

The System Monitor plugin keeps its own SQLite database under
`~/.nordrelay/plugins/data/system-monitor/metrics.sqlite`. It owns collection,
retention cleanup, range summaries, and downsampled chart data; NordRelay only
hosts the panel and routes plugin invocations to peers.

Install Auto Updater for OS and npm update visibility plus explicit admin-run
update actions:

```sh
nordrelay plugin install github:nordbyte/nordrelay-plugin-auto-updater --enable --approve
```

Auto Updater checks Linux/macOS package-manager updates and global npm package
versions on each node where the plugin is installed. It stores its own SQLite
database under `~/.nordrelay/plugins/data/auto-updater/updates.sqlite`.
Required permissions are `runtime.read`, `peers.read`, `system.packages.read`,
`system.packages.write`, `system.updates.read`, `system.updates.write`, and
`network`. Admins can explicitly start OS update, global npm update, npm
auto-install, and npm uninstall actions from the plugin panel. Those actions run
as the same operating-system user that runs NordRelay and still require the
plugin permissions to be approved.

Install RepoVista for repository scans and report browsing:

```sh
nordrelay plugin install npm:@nordbyte/nordrelay-repovista --enable --approve
```

RepoVista runs scans on the node where the plugin is installed, reads completed
report runs from the configured repository output directory, and shows reports,
findings, compare/review output, and live `status.json` progress when the
installed RepoVista version supports it. It requires `runtime.read`,
`peers.read`, `files.read`, `files.write`, and `network`. Use the plugin
settings to restrict allowed repository roots and to decide whether write
actions such as triage, baseline changes, fixes, CI workflow creation, or GitHub
publishing are available from the panel.
