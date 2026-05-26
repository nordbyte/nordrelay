# Plugins

NordRelay plugins are explicit local or GitHub installs that can add workflow actions, WebUI panels, commands, adapter metadata, artifact handlers, diagnostics, and scheduled collectors.

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
- install local or GitHub plugins
- enable or disable plugins
- edit plugin settings
- view plugin logs
- inspect the extension catalog
- run plugin commands, panels, artifact handlers, collectors, and diagnostics from the catalog
- check for updates, reinstall from the original source/ref, and roll back to a previously installed version
- view invocation metrics, failures, durations, and logs
- scaffold a new plugin directory

The Plugins page follows the selected node in the WebUI header. Select a peer before installing, enabling, configuring, or invoking plugins on that peer. The install form can also install the same GitHub plugin on all enabled peers. Remote plugin actions require the corresponding peer scopes such as `plugins.read`, `plugins.install`, `plugins.enable`, `plugins.settings.write`, `workflows.run`, and `diagnostics.read`.

## Collectors

Enabled plugins can expose collectors for periodic local work, such as sampling system metrics. NordRelay schedules collectors for each node where the plugin is installed and enabled, invokes the plugin entry with `type: "collector"`, and leaves all collection/storage logic to the plugin.

Collector results are recorded in plugin invocation metrics. If a collector fails, NordRelay applies a bounded backoff before trying again.

## Workflow actions

Enabled plugins can expose workflow actions. A workflow step with `type: "plugin"` calls the plugin entry with JSON on stdin and reads JSON or text from stdout. If the action defines `inputSchema`, the workflow builder shows a form instead of forcing raw JSON. `outputVariables` can map result paths into workflow variables for later steps.

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

For WebUI panels, return an HTML fragment in `html`. NordRelay wraps the
fragment in an isolated iframe, injects the current light/dark theme, and
provides shared WebUI classes for panels, section headers, tabs, tables, badges,
chips, metrics, progress bars, buttons, inputs, empty/loading/error states,
code/log blocks, diffs, and media previews. Use the SDK `ui` helpers where
possible:

```js
import { ok, runWebPanel, ui } from "@nordbyte/nordrelay-plugin-sdk";

runWebPanel(async () => {
  return ok(undefined, {
    html: ui.panel(
      "Status",
      ui.metric("Health", "ok") +
        ui.table([{ key: "name", label: "Name" }], [{ name: "Local node" }])
    )
  });
});
```

Panel scripts can call `window.NordRelayPanel.toast(message)`,
`window.NordRelayPanel.copyText(value, label)`, and
`window.NordRelayPanel.resize()` from inside the iframe.

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

## System Monitor example

The first full plugin is available at:

```sh
nordrelay plugin install github:nordbyte/nordrelay-plugin-system-monitor --enable --approve
```

Install it on every peer where metrics should be collected. Peers without the plugin are shown as unavailable in the plugin dashboard instead of returning metrics.
