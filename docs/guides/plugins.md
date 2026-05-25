# Plugins

NordRelay plugins are explicit local or GitHub installs that can add workflow actions, WebUI panels, commands, adapters, artifact handlers, and diagnostics metadata.

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
  "permissions": [],
  "capabilities": {
    "workflowActions": [
      {
        "id": "example.echo",
        "title": "Echo"
      }
    ]
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
- scaffold a new plugin directory

The Plugins page always acts on the local node.

## Workflow actions

Enabled plugins can expose workflow actions. A workflow step with `type: "plugin"` calls the plugin entry with JSON on stdin and reads JSON or text from stdout.

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
  "sessionMode": "current",
  "target": "local",
  "requiresApproval": false,
  "continueOnError": false
}
```

String values in `pluginInput` can use workflow variables such as `{{message}}`.

## Security

Plugins are disabled until an admin enables them. Enabling a plugin approves the permissions declared in the manifest. Keep `NORDRELAY_PLUGIN_ALLOW_BUILD_SCRIPTS=false` unless you explicitly trust the plugin source.

