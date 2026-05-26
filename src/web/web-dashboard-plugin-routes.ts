import type { IncomingMessage, ServerResponse } from "node:http";
import type { URL } from "node:url";

import type { ConnectorConfig } from "../core/config.js";
import { PluginService, type PluginServiceOptions } from "../plugins/plugin-service.js";
import type { AuthenticatedUser } from "../access/user-management.js";
import type { AuditEvent } from "../access/audit-log.js";
import {
  objectRecord,
  optionalBooleanField,
  optionalStringField,
  readJsonBody,
  sendJson,
} from "./web-dashboard-http.js";

interface DashboardPluginRouteOptions {
  config: ConnectorConfig;
  home: string;
  authUser: AuthenticatedUser;
  auditPluginAction: (action: AuditEvent["action"], description: string) => void;
}

export async function handleDashboardPluginRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  options: DashboardPluginRouteOptions,
): Promise<boolean> {
  if (!url.pathname.startsWith("/api/plugins")) {
    return false;
  }

  const plugins = createPluginService(options.home, options.config);

  if (req.method === "GET" && url.pathname === "/api/plugins") {
    const catalog = options.config.pluginsEnabled ? await plugins.catalog() : {
      workflowActions: [],
      webPanels: [],
      commands: [],
      agentAdapters: [],
      chatAdapters: [],
      artifactHandlers: [],
      diagnostics: [],
    };
    sendJson(res, 200, {
      enabled: options.config.pluginsEnabled,
      plugins: await plugins.list(),
      catalog,
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/plugins/catalog") {
    assertPluginsWritable(options.config);
    sendJson(res, 200, await plugins.catalog());
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/plugins/validate") {
    const body = await readJsonBody(req);
    sendJson(res, 200, await plugins.validate(requiredString(body, "source")));
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/plugins/scaffold") {
    assertPluginsWritable(options.config);
    const body = await readJsonBody(req);
    const created = await plugins.scaffold({
      targetDir: requiredString(body, "targetDir"),
      id: requiredString(body, "id"),
      name: optionalStringField(body, "name"),
      description: optionalStringField(body, "description"),
    });
    options.auditPluginAction("plugin_scaffold_created", `Created plugin scaffold ${created}`);
    sendJson(res, 200, { path: created });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/plugins") {
    assertPluginsWritable(options.config);
    const body = await readJsonBody(req);
    const source = requiredString(body, "source");
    if (!options.config.pluginGithubInstallEnabled && isGitHubSource(source)) {
      throw new Error("GitHub plugin installation is disabled by NORDRELAY_PLUGIN_GITHUB_INSTALL_ENABLED=false.");
    }
    const plugin = await plugins.install({
      source,
      ref: optionalStringField(body, "ref"),
      enable: optionalBooleanField(body, "enable") ?? false,
      approvePermissions: optionalBooleanField(body, "approvePermissions") ?? false,
      force: optionalBooleanField(body, "force") ?? false,
    });
    options.auditPluginAction("plugin_installed", `Installed plugin ${plugin.id} ${plugin.version}`);
    sendJson(res, 201, plugin);
    return true;
  }

  const id = pluginIdFromPath(url.pathname);
  if (!id) {
    return false;
  }

  if (req.method === "GET" && url.pathname === `/api/plugins/${id}`) {
    const plugin = await plugins.get(id);
    if (!plugin) {
      sendJson(res, 404, { error: "Plugin not found." });
      return true;
    }
    sendJson(res, 200, plugin);
    return true;
  }

  if (req.method === "DELETE" && url.pathname === `/api/plugins/${id}`) {
    assertPluginsWritable(options.config);
    await plugins.remove(id);
    options.auditPluginAction("plugin_removed", `Removed plugin ${id}`);
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (req.method === "POST" && url.pathname === `/api/plugins/${id}/enable`) {
    assertPluginsWritable(options.config);
    const plugin = await plugins.enable(id);
    options.auditPluginAction("plugin_enabled", `Enabled plugin ${id}`);
    sendJson(res, 200, plugin);
    return true;
  }

  if (req.method === "POST" && url.pathname === `/api/plugins/${id}/disable`) {
    assertPluginsWritable(options.config);
    const plugin = await plugins.disable(id);
    options.auditPluginAction("plugin_disabled", `Disabled plugin ${id}`);
    sendJson(res, 200, plugin);
    return true;
  }

  if (req.method === "PATCH" && url.pathname === `/api/plugins/${id}/settings`) {
    assertPluginsWritable(options.config);
    const body = await readJsonBody(req);
    const plugin = await plugins.updateSettings(id, objectRecord(body?.settings));
    options.auditPluginAction("plugin_updated", `Updated plugin settings for ${id}`);
    sendJson(res, 200, plugin);
    return true;
  }

  if (req.method === "POST" && url.pathname === `/api/plugins/${id}/manifest`) {
    assertPluginsWritable(options.config);
    const plugin = await plugins.updateManifest(id);
    options.auditPluginAction("plugin_updated", `Reloaded plugin manifest for ${id}`);
    sendJson(res, 200, plugin);
    return true;
  }

  if (req.method === "GET" && url.pathname === `/api/plugins/${id}/log`) {
    const maxBytes = Number.parseInt(url.searchParams.get("maxBytes") ?? "20000", 10);
    sendJson(res, 200, { id, log: await plugins.readLog(id, Number.isFinite(maxBytes) ? maxBytes : 20000) });
    return true;
  }

  if (req.method === "GET" && url.pathname === `/api/plugins/${id}/update-check`) {
    assertPluginsWritable(options.config);
    sendJson(res, 200, await plugins.checkUpdate(id));
    return true;
  }

  if (req.method === "POST" && url.pathname === `/api/plugins/${id}/update`) {
    assertPluginsWritable(options.config);
    const plugin = await plugins.update(id);
    options.auditPluginAction("plugin_updated", `Updated plugin ${id}`);
    sendJson(res, 200, plugin);
    return true;
  }

  if (req.method === "POST" && url.pathname === `/api/plugins/${id}/rollback`) {
    assertPluginsWritable(options.config);
    const body = await readJsonBody(req);
    const plugin = await plugins.rollback(id, optionalStringField(body, "version"));
    options.auditPluginAction("plugin_updated", `Rolled back plugin ${id}`);
    sendJson(res, 200, plugin);
    return true;
  }

  if (req.method === "POST" && url.pathname === `/api/plugins/${id}/invoke`) {
    assertPluginsWritable(options.config);
    const body = await readJsonBody(req);
    const result = await plugins.invokeWorkflowAction(id, requiredString(body, "actionId"), objectRecord(body?.input));
    sendJson(res, 200, result);
    return true;
  }

  if (req.method === "POST" && url.pathname === `/api/plugins/${id}/command`) {
    assertPluginsWritable(options.config);
    const body = await readJsonBody(req);
    const result = await plugins.invokeCommand(id, requiredString(body, "command"), objectRecord(body?.input));
    sendJson(res, 200, result);
    return true;
  }

  if (req.method === "POST" && url.pathname === `/api/plugins/${id}/panel`) {
    assertPluginsWritable(options.config);
    const body = await readJsonBody(req);
    const result = await plugins.invokeWebPanel(id, requiredString(body, "panelId"), objectRecord(body?.input));
    sendJson(res, 200, result);
    return true;
  }

  if (req.method === "POST" && url.pathname === `/api/plugins/${id}/artifact-handler`) {
    assertPluginsWritable(options.config);
    const body = await readJsonBody(req);
    const result = await plugins.invokeArtifactHandler(id, requiredString(body, "handlerId"), objectRecord(body?.input));
    sendJson(res, 200, result);
    return true;
  }

  if (req.method === "GET" && url.pathname === `/api/plugins/${id}/diagnostics`) {
    assertPluginsWritable(options.config);
    sendJson(res, 200, await plugins.invokeDiagnostics(id));
    return true;
  }

  return false;
}

function createPluginService(home: string, config: ConnectorConfig): PluginService {
  const serviceOptions: PluginServiceOptions = {
    enabled: config.pluginsEnabled,
    nodeName: config.peerName,
    platform: process.platform,
    workspace: config.workspace,
    hostContext: () => ({
      runtime: {
        nodeName: config.peerName,
        platform: process.platform,
        workspace: config.workspace,
      },
      settings: {
        workspace: config.workspace,
        stateBackend: config.stateBackend,
        agents: {
          codex: config.codexEnabled,
          pi: config.piEnabled,
          hermes: config.hermesEnabled,
          openclaw: config.openClawEnabled,
          claudeCode: config.claudeCodeEnabled,
        },
      },
    }),
  };
  return new PluginService(home, serviceOptions);
}

function assertPluginsWritable(config: ConnectorConfig): void {
  if (!config.pluginsEnabled) {
    throw new Error("Plugins are disabled by NORDRELAY_PLUGINS_ENABLED=false.");
  }
}

function pluginIdFromPath(pathname: string): string | null {
  const match = /^\/api\/plugins\/([^/]+)(?:\/.*)?$/.exec(pathname);
  return match ? decodeURIComponent(match[1]) : null;
}

function requiredString(body: unknown, key: string): string {
  const value = optionalStringField(objectRecord(body), key);
  if (!value) {
    throw new Error(`${key} is required.`);
  }
  return value;
}

function isGitHubSource(source: string): boolean {
  return source.startsWith("github:") || /^https:\/\/github\.com\//i.test(source);
}
