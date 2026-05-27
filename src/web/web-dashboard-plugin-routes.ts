import type { IncomingMessage, ServerResponse } from "node:http";
import type { URL } from "node:url";

import type { ConnectorConfig } from "../core/config.js";
import { RemoteRelayClient } from "../peers/peer-client.js";
import { PeerStore } from "../peers/peer-store.js";
import { PluginService, type PluginServiceOptions } from "../plugins/plugin-service.js";
import { pluginMarketplaceEntries } from "../plugins/plugin-marketplace.js";
import type { AuthenticatedUser, UserStore } from "../access/user-management.js";
import type { AuditEvent } from "../access/audit-log.js";
import type { PublicPeerRecord } from "../peers/peer-types.js";
import type { PluginInvokeResult } from "../plugins/plugin-types.js";
import type { WebActivityActor } from "./web-state.js";
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
  users: UserStore;
  activityActor: WebActivityActor;
  auditPluginAction: (action: AuditEvent["action"], description: string) => void;
}

interface PluginAggregateNode {
  id: string;
  name: string;
  platform?: string;
}

interface PluginAggregateResult {
  node: PluginAggregateNode;
  ok: boolean;
  result?: unknown;
  error?: string;
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
      collectors: [],
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

  if (req.method === "GET" && url.pathname === "/api/plugins/marketplace") {
    sendJson(res, 200, { entries: pluginMarketplaceEntries() });
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

  if (req.method === "POST" && url.pathname === `/api/plugins/${id}/aggregate-command`) {
    assertPluginsWritable(options.config);
    const body = await readJsonBody(req);
    const command = requiredString(body, "command");
    const input = objectRecord(body?.input);
    sendJson(res, 200, await invokePluginAggregateCommand(id, command, input, plugins, options));
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

  if (req.method === "POST" && url.pathname === `/api/plugins/${id}/collector`) {
    assertPluginsWritable(options.config);
    const body = await readJsonBody(req);
    const result = await plugins.invokeCollector(id, requiredString(body, "collectorId"), objectRecord(body?.input));
    sendJson(res, 200, result);
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

async function invokePluginAggregateCommand(
  pluginId: string,
  command: string,
  input: Record<string, unknown>,
  plugins: PluginService,
  options: DashboardPluginRouteOptions,
): Promise<{ command: string; generatedAt: string; results: PluginAggregateResult[] }> {
  const results: PluginAggregateResult[] = [];
  const localNode: PluginAggregateNode = {
    id: "local",
    name: "Local node",
    platform: process.platform,
  };
  try {
    const result = await plugins.invokeCommand(pluginId, command, input);
    results.push({ node: localNode, ok: result.ok !== false, result });
  } catch (error) {
    results.push({ node: localNode, ok: false, error: errorMessage(error) });
  }

  const store = new PeerStore(options.home);
  const client = new RemoteRelayClient(store, options.home);
  const peers = store.listPublic()
    .filter((peer) => peer.enabled !== false && canUsePluginAggregatePeer(peer, options));
  await Promise.all(peers.map(async (peer) => {
    const node = pluginAggregatePeerNode(peer);
    try {
      const result = await client.webProxy(peer.id, {
        method: "POST",
        path: `/api/plugins/${pluginId}/command`,
        query: {},
        body: { command, input },
        contextKey: `web:plugin-aggregate:${pluginId}`,
      }, options.activityActor, `web:plugin-aggregate:${pluginId}`, { timeoutMs: 12_000 });
      results.push({ node, ok: (result as PluginInvokeResult | undefined)?.ok !== false, result });
    } catch (error) {
      const message = errorMessage(error);
      if (!shouldSkipPluginAggregateError(message)) {
        results.push({ node, ok: false, error: message });
      }
    }
  }));

  return {
    command,
    generatedAt: new Date().toISOString(),
    results: results.sort((a, b) => String(a.node.name).localeCompare(String(b.node.name))),
  };
}

function canUsePluginAggregatePeer(peer: PublicPeerRecord, options: DashboardPluginRouteOptions): boolean {
  if (!options.users.canUsePeerStrict(options.authUser, peer.id)) {
    return false;
  }
  return Boolean(peer.url || peer.direction === "inbound");
}

function pluginAggregatePeerNode(peer: PublicPeerRecord): PluginAggregateNode {
  return {
    id: peer.id,
    name: peer.name || peer.id,
    platform: peer.remoteStatus ? `${peer.remoteStatus}${peer.remoteVersion ? ` · ${peer.remoteVersion}` : ""}` : undefined,
  };
}

function shouldSkipPluginAggregateError(message: string): boolean {
  return /plugin not found|plugins are disabled|plugin is disabled|access denied|api key permissions/i.test(message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
