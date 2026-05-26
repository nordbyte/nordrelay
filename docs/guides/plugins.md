# Plugins

NordRelay plugins are explicit local or GitHub installs that can add workflow actions, WebUI panels, commands, adapter metadata, artifact handlers, and diagnostics.

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
- run plugin commands, panels, artifact handlers, and diagnostics from the catalog
- check for updates, reinstall from the original source/ref, and roll back to a previously installed version
- view invocation metrics, failures, durations, and logs
- scaffold a new plugin directory

The Plugins page always acts on the local node. Remote peers do not execute local plugins unless the same plugin is installed and enabled on that peer and the request is sent to that peer explicitly through a peer API.

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
