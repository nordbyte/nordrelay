import { readFileSync } from "node:fs";

import { enabledAgents } from "../agents/shared/agent-factory.js";
import { listAgentAdapterDescriptors } from "../agents/shared/agent-adapter.js";
import { buildAdapterConformanceMatrix } from "../agents/shared/adapter-conformance.js";
import { isAgentId, type AgentApprovalChoice, type AgentId, type AgentSessionInfo, type AgentThreadRecord } from "../agents/shared/agent.js";
import { permissionForWebRequest, type Permission } from "../access/access-control.js";
import { listChannelDescriptors } from "../channels/shared/channel-adapter.js";
import type { ConnectorConfig } from "../core/config.js";
import type { ChannelContextKey } from "../channels/shared/context-key.js";
import { getPackageVersion } from "../support/operations.js";
import { checkPeerEndpoint, RemoteRelayClient } from "./peer-client.js";
import { loadOrCreatePeerIdentity } from "./peer-identity.js";
import { buildPeerReadiness } from "./peer-readiness.js";
import { matchPeerWebRoute, type MatchedPeerWebRoute } from "./peer-runtime-routes.js";
import { publicPeer, type PeerRecord, type PeerRpcRequest, type PeerWebProxyPayload } from "./peer-types.js";
import { PeerStore } from "./peer-store.js";
import type { RelayRuntime } from "../runtime/relay-runtime.js";
import type { ActiveSessionsDto, QueuePlanDto, QueuePlannerSnapshotDto, RelayEvent, RelaySnapshot, SessionPageDto, TraceDetailDto, UnifiedJobDto, UnifiedJobsDto, WebDiagnosticsDto, WebTasksDto } from "../runtime/relay-runtime-types.js";
import type { QueuePlanInput } from "../runtime/relay-runtime-queue-planner.js";
import { QUEUE_PLAN_STATUSES, type QueuePlanStatus } from "../state/queue-plan-store.js";
import type { PromptTemplate, Workflow, WorkflowRun, WorkflowStep } from "../state/workflow-store.js";
import type { WorktreeConflictResolution } from "../worktrees/worktree-types.js";
import type { WebActivityActor } from "../web/web-state.js";
import type { WebHttpMethod } from "../web/web-api-contract.js";

interface PeerWebRouteContext {
  peer: PeerRecord;
  runtime: RelayRuntime;
  method: WebHttpMethod;
  path: string;
  query: Record<string, unknown>;
  body: Record<string, unknown>;
  remoteActor: WebActivityActor;
}

export class PeerRuntimeService {
  constructor(
    private readonly config: ConnectorConfig,
    private readonly runtime: RelayRuntime,
    private readonly options: {
      home?: string;
      runtimeForContext?: (peer: PeerRecord, sourceContextKey?: ChannelContextKey) => RelayRuntime;
    } = {},
  ) {}

  async handle(peer: PeerRecord, request: PeerRpcRequest): Promise<unknown> {
    if (!peer.enabled) {
      throw new Error("Peer is disabled.");
    }
    if (request.type === "web.proxy") {
      return this.handleWebProxy(peer, request.payload as PeerWebProxyPayload, request.actor);
    }
    if (request.type === "peer.ping") {
      this.assertScope(peer, "inspect");
      return { ok: true, status: "online", version: await getPackageVersion(), at: new Date().toISOString() };
    }
    if (request.type === "peer.probe") {
      this.assertScope(peer, "inspect");
      return await this.handlePeerProbe(peer, request.payload);
    }
    throw new Error(`Unsupported peer RPC type: ${request.type}`);
  }

  subscribe(peer: PeerRecord, sourceContextKey: ChannelContextKey | undefined, send: (event: RelayEvent) => void): () => void {
    this.assertScope(peer, "sessions.read");
    const runtime = this.runtimeFor(peer, sourceContextKey);
    return runtime.subscribe((event) => {
      void this.scopeRelayEvent(peer, runtime, event)
        .then((scoped) => {
          if (scoped) send(scoped);
        })
        .catch(() => {
          // If a scope check fails for an event, drop that event for this peer.
        });
    });
  }

  private async handleWebProxy(peer: PeerRecord, payload: PeerWebProxyPayload, actor?: WebActivityActor): Promise<unknown> {
    const runtime = this.runtimeFor(peer, stringValue(payload?.contextKey) || undefined);
    const method = normalizeMethod(payload?.method);
    const path = normalizePath(payload?.path);
    const query = objectRecord(payload?.query);
    const body = objectRecord(payload?.body);
    const permission = permissionForWebRequest(method, path);
    if (!permission) {
      throw new Error(`Remote endpoint is not allowed: ${method} ${path}`);
    }
    this.assertScope(peer, permission);
    const remoteActor = peerActor(peer, actor);

    const route = matchPeerWebRoute(method, path);
    if (!route) {
      throw new Error(`Remote endpoint is not implemented: ${method} ${path}`);
    }
    return this.handleMatchedWebRoute(route, { peer, runtime, method, path, query, body, remoteActor });
  }

  private async handleMatchedWebRoute(route: MatchedPeerWebRoute, context: PeerWebRouteContext): Promise<unknown> {
    switch (route.definition.group) {
      case "core": return this.handleCoreWebRoute(context);
      case "peers": return this.handlePeerWebRoute(context, route.params);
      case "agentUpdates": return this.handleAgentUpdateWebRoute(context, route.params);
      case "jobs": return this.handleJobsWebRoute(context, route.params);
      case "workflows": return this.handleWorkflowWebRoute(context, route.params);
      case "sessions": return this.handleSessionWebRoute(context, route.params);
      case "queue": return this.handleQueueWebRoute(context, route.params);
      case "chat": return this.handleChatWebRoute(context);
      case "activity": return this.handleActivityWebRoute(context);
      case "artifacts": return this.handleArtifactWebRoute(context);
      case "plugins": return this.handlePluginWebRoute(context, route.params);
      case "operations": return this.handleOperationsWebRoute(context);
    }
  }

  private async handlePeerWebRoute(context: PeerWebRouteContext, params: string[]): Promise<unknown> {
    const { peer, method, path, body, remoteActor } = context;
    const store = new PeerStore(this.options.home);
    const identity = loadOrCreatePeerIdentity(this.options.home, this.config.peerName);
    if (method === "GET" && path === "/api/peers") {
      this.assertScope(peer, "peers.read");
      const readiness = await buildPeerReadiness(this.config, this.options.home);
      return store.snapshot(identity.public, {
        enabled: this.config.peerEnabled,
        listenUrl: readiness.listenUrl,
        requireTls: this.config.peerRequireTls,
        readiness,
      });
    }
    const peerId = params[0];
    if (method === "POST" && peerId && path.endsWith("/rotate")) {
      this.assertScope(peer, "peers.write");
      const readiness = await buildPeerReadiness(this.config, this.options.home);
      const created = store.createRotationInvitation(peerId, {
        expiresInMs: numberValue(body.expiresMinutes, 10) * 60 * 1000,
      });
      return {
        peer: created.peer,
        invitation: created.invitation,
        code: created.code,
        command: `nordrelay peer add ${readiness.listenUrl} --code ${created.code}`,
        readiness,
        warnings: readiness.warnings,
      };
    }
    if (method === "POST" && peerId && path.endsWith("/sync-invite")) {
      this.assertScope(peer, "peers.write");
      this.assertScope(peer, "peers.connect");
      const sourcePeer = store.get(peerId);
      if (!sourcePeer) {
        throw new Error("Peer not found.");
      }
      if (!sourcePeer.url) {
        throw new Error("Peer sync requires the selected peer to expose a direct URL.");
      }
      const created = objectRecord(await new RemoteRelayClient(store, this.options.home).webProxy(sourcePeer.id, {
        method: "POST",
        path: `/api/peers/${encodeURIComponent(sourcePeer.id)}/rotate`,
        body: { expiresMinutes: numberValue(body.expiresMinutes, 10) },
        contextKey: stringValue(body.contextKey) || "web:peer-sync",
      }, remoteActor, "web:peer-sync", { timeoutMs: 12_000 }));
      return { ...created, peer: publicPeer(sourcePeer), remotePeer: created.peer };
    }
    throw unsupportedPeerRoute(method, path);
  }

  private async handlePluginWebRoute(context: PeerWebRouteContext, params: string[]): Promise<unknown> {
    const { peer, runtime, method, path, body, query } = context;
    const plugins = runtime.pluginService;
    if (method === "GET" && path === "/api/plugins") {
      this.assertScope(peer, "plugins.read");
      const catalog = this.config.pluginsEnabled ? await plugins.catalog() : {
        workflowActions: [],
        webPanels: [],
        commands: [],
        agentAdapters: [],
        chatAdapters: [],
        artifactHandlers: [],
        diagnostics: [],
        collectors: [],
      };
      return { enabled: this.config.pluginsEnabled, plugins: await plugins.list(), catalog };
    }
    if (method === "POST" && path === "/api/plugins") {
      this.assertScope(peer, "plugins.install");
      const source = requiredString(body.source, "source");
      if (!this.config.pluginGithubInstallEnabled && isGitHubSource(source)) {
        throw new Error("GitHub plugin installation is disabled by NORDRELAY_PLUGIN_GITHUB_INSTALL_ENABLED=false.");
      }
      return await plugins.install({
        source,
        ref: stringValue(body.ref) || undefined,
        enable: Boolean(body.enable),
        approvePermissions: Boolean(body.approvePermissions),
        force: Boolean(body.force),
      });
    }
    if (method === "GET" && path === "/api/plugins/catalog") {
      this.assertScope(peer, "plugins.read");
      return await plugins.catalog();
    }
    if (method === "POST" && path === "/api/plugins/validate") {
      this.assertScope(peer, "plugins.install");
      return await plugins.validate(requiredString(body.source, "source"));
    }
    if (method === "POST" && path === "/api/plugins/scaffold") {
      this.assertScope(peer, "plugins.install");
      return {
        path: await plugins.scaffold({
          targetDir: requiredString(body.targetDir, "targetDir"),
          id: requiredString(body.id, "id"),
          name: stringValue(body.name) || undefined,
          description: stringValue(body.description) || undefined,
        }),
      };
    }
    const id = params[0];
    const action = params[1] || "";
    if (!id) {
      throw unsupportedPeerRoute(method, path);
    }
    if (method === "GET" && !action) {
      this.assertScope(peer, "plugins.read");
      const plugin = await plugins.get(id);
      if (!plugin) throw new Error("Plugin not found.");
      return plugin;
    }
    if (method === "DELETE" && !action) {
      this.assertScope(peer, "plugins.install");
      await plugins.remove(id);
      return { ok: true };
    }
    if (method === "POST" && action === "enable") {
      this.assertScope(peer, "plugins.enable");
      return await plugins.enable(id);
    }
    if (method === "POST" && action === "disable") {
      this.assertScope(peer, "plugins.enable");
      return await plugins.disable(id);
    }
    if (method === "PATCH" && action === "settings") {
      this.assertScope(peer, "plugins.settings.write");
      return await plugins.updateSettings(id, objectRecord(body.settings));
    }
    if (method === "GET" && action === "log") {
      this.assertScope(peer, "plugins.read");
      return { id, log: await plugins.readLog(id, numberValue(query.maxBytes, 20000)) };
    }
    if (method === "POST" && action === "manifest") {
      this.assertScope(peer, "plugins.install");
      return await plugins.updateManifest(id);
    }
    if (method === "GET" && action === "update-check") {
      this.assertScope(peer, "plugins.install");
      return await plugins.checkUpdate(id);
    }
    if (method === "POST" && action === "update") {
      this.assertScope(peer, "plugins.install");
      return await plugins.update(id);
    }
    if (method === "POST" && action === "rollback") {
      this.assertScope(peer, "plugins.install");
      return await plugins.rollback(id, stringValue(body.version) || undefined);
    }
    if (method === "POST" && action === "invoke") {
      this.assertScope(peer, "workflows.run");
      return await plugins.invokeWorkflowAction(id, requiredString(body.actionId, "actionId"), objectRecord(body.input));
    }
    if (method === "POST" && action === "command") {
      this.assertScope(peer, "workflows.run");
      return await plugins.invokeCommand(id, requiredString(body.command, "command"), objectRecord(body.input));
    }
    if (method === "POST" && action === "panel") {
      this.assertScope(peer, "plugins.read");
      return await plugins.invokeWebPanel(id, requiredString(body.panelId, "panelId"), objectRecord(body.input));
    }
    if (method === "POST" && action === "artifact-handler") {
      this.assertScope(peer, "files.write");
      return await plugins.invokeArtifactHandler(id, requiredString(body.handlerId, "handlerId"), objectRecord(body.input));
    }
    if (method === "GET" && action === "diagnostics") {
      this.assertScope(peer, "diagnostics.read");
      return await plugins.invokeDiagnostics(id);
    }
    if (method === "POST" && action === "collector") {
      this.assertScope(peer, "plugins.install");
      return await plugins.invokeCollector(id, requiredString(body.collectorId, "collectorId"), objectRecord(body.input));
    }
    throw unsupportedPeerRoute(method, path);
  }

  private async handleCoreWebRoute(context: PeerWebRouteContext): Promise<unknown> {
    const { peer, runtime, method, path, query, body, remoteActor } = context;
    if (method === "GET" && path === "/api/bootstrap") {
      const agentId = parseAgentId(query.agent);
      this.assertAgentScope(peer, agentId);
      const status = this.scopedBootstrapStatus(peer, await runtime.bootstrapStatus());
      return {
        auth: {
          user: { id: `peer:${peer.id}`, email: `${peer.name}@peer.local`, displayName: peer.name, active: true },
          groups: [],
          permissions: peer.scopes,
        },
        channels: listChannelDescriptors(this.config),
        agentAdapters: listAgentAdapterDescriptors().filter((adapter) => this.canUseAgent(peer, adapter.id)),
        enabledAgents: enabledAgents(this.config).filter((agentId) => this.canUseAgent(peer, agentId)),
        controls: this.scopedControlOptions(peer, await runtime.controlOptions(agentId)),
        status,
      };
    }
    if (method === "GET" && path === "/api/health") return runtime.status();
    if (method === "GET" && path === "/api/snapshot") return this.scopedSnapshot(peer, await runtime.snapshot());
    if (method === "GET" && path === "/api/version") return runtime.version();
    if (method === "POST" && path === "/api/update") return runtime.updateConnector(remoteActor);
    if (method === "GET" && path === "/api/tasks") return this.scopedTasks(peer, await runtime.tasks());
    if (method === "GET" && path === "/api/progress") return this.scopedTasks(peer, await runtime.tasks());
    if (method === "GET" && path === "/api/trace") {
      this.assertScope(peer, "sessions.read");
      return this.scopedTrace(peer, await runtime.trace(requiredString(query.correlationId, "correlationId")));
    }
    if (method === "GET" && path === "/api/metrics") return runtime.metrics();
    if (method === "GET" && path === "/api/metrics/history") return { samples: runtime.metricsHistory(numberValue(query.limit, 240)) };
    if (method === "GET" && path === "/api/active-sessions") return this.scopedActiveSessions(peer, await runtime.activeSessions());
    if (method === "GET" && path === "/api/adapters/health") {
      return { adapters: (await runtime.adapterHealth()).filter((adapter) => this.canUseAgent(peer, adapter.id)) };
    }
    if (method === "GET" && path === "/api/adapters/conformance") {
      return buildAdapterConformanceMatrix({
        agents: listAgentAdapterDescriptors().filter((adapter) => this.canUseAgent(peer, adapter.id)),
        channels: listChannelDescriptors(this.config),
      });
    }
    if (method === "GET" && path === "/api/diagnostics") return this.scopedDiagnostics(peer, await runtime.diagnostics());
    if (method === "POST" && path === "/api/diagnostics/voice/refresh") {
      await this.assertCurrentSessionScope(peer, runtime);
      return runtime.refreshVoiceDiagnostics();
    }
    if (method === "GET" && path === "/api/diagnostics/bundle") {
      await this.assertCurrentSessionScope(peer, runtime);
      const bundle = await runtime.supportBundle(remoteActor);
      return {
        ...bundle,
        mimeType: "application/zip",
        dataBase64: readFileSync(bundle.path).toString("base64"),
      };
    }
    if (method === "GET" && path === "/api/control-options") {
      const agentId = parseAgentId(query.agent);
      this.assertAgentScope(peer, agentId);
      return this.scopedControlOptions(peer, await runtime.controlOptions(agentId));
    }
    if (method === "GET" && path === "/api/locks") return { locks: runtime.locks() };
    if (method === "POST" && path === "/api/locks") {
      return { lock: runtime.lockWebSession(stringValue(body.ownerName) || `Peer ${peer.name}`, remoteActor), locks: runtime.locks() };
    }
    if (method === "DELETE" && path === "/api/locks") return runtime.unlockWebSession(remoteActor);
    if (method === "GET" && path === "/api/auth/status") {
      const agentId = parseAgentId(query.agent);
      this.assertAgentScope(peer, agentId);
      return runtime.authStatus(agentId);
    }
    if (method === "POST" && path === "/api/auth/login") {
      const agentId = parseAgentId(body.agentId);
      this.assertAgentScope(peer, agentId);
      return runtime.login(agentId, remoteActor);
    }
    if (method === "POST" && path === "/api/auth/logout") {
      const agentId = parseAgentId(body.agentId);
      this.assertAgentScope(peer, agentId);
      return runtime.logout(agentId, remoteActor);
    }
    throw unsupportedPeerRoute(method, path);
  }

  private handleAgentUpdateWebRoute(context: PeerWebRouteContext, params: string[]): unknown {
    const { peer, runtime, method, path, query, body, remoteActor } = context;
    if (method === "GET" && path === "/api/agent-updates") {
      return { jobs: runtime.agentUpdateJobs().filter((job) => this.canUseAgent(peer, job.agentId)) };
    }
    if (method === "POST" && path === "/api/agent-update") {
      const agentId = parseRequiredAgentId(body.agentId);
      this.assertAgentScope(peer, agentId);
      return { job: runtime.startAgentUpdate(agentId, parseAgentUpdateOperation(stringValue(body.operation)), remoteActor) };
    }
    const id = params[0];
    if (id && method === "GET" && path.endsWith("/log")) {
      this.assertAgentUpdateJobScope(peer, runtime, id);
      return runtime.agentUpdateLog(id);
    }
    if (id && method === "DELETE" && path.endsWith("/log")) {
      this.assertAgentUpdateJobScope(peer, runtime, id);
      return { deletedId: id, job: runtime.deleteAgentUpdateLog(id, remoteActor) };
    }
    if (id && method === "POST" && path.endsWith("/input")) {
      this.assertAgentUpdateJobScope(peer, runtime, id);
      return { job: runtime.sendAgentUpdateInput(id, requiredString(body.input, "input"), remoteActor) };
    }
    if (id && method === "POST" && path.endsWith("/cancel")) {
      this.assertAgentUpdateJobScope(peer, runtime, id);
      return { job: runtime.cancelAgentUpdate(id, remoteActor) };
    }
    throw unsupportedPeerRoute(method, path);
  }

  private async handleJobsWebRoute(context: PeerWebRouteContext, params: string[]): Promise<unknown> {
    const { peer, runtime, method, path, body, remoteActor } = context;
    if (method === "GET" && path === "/api/jobs") return this.scopedJobs(peer, await runtime.jobs());
    const id = params[0];
    if (id && method === "GET" && path.endsWith("/log")) {
      const data = await runtime.jobLog(id);
      if (data.job && !this.canUseJob(peer, data.job)) {
        throw new Error("Peer is not allowed to read this job.");
      }
      return data;
    }
    if (id && method === "POST" && path.endsWith("/action")) {
      const action = requiredString(body.action, "action");
      if (action !== "cancel" && action !== "retry") {
        throw new Error("Unsupported job action.");
      }
      this.assertScope(peer, permissionForJobAction(id, action));
      return this.scopedJobs(peer, await runtime.jobAction(id, action, remoteActor));
    }
    throw unsupportedPeerRoute(method, path);
  }

  private async handleWorkflowWebRoute(context: PeerWebRouteContext, params: string[]): Promise<unknown> {
    const { peer, runtime, method, path, query, body, remoteActor } = context;
    if (method === "GET" && path === "/api/templates") {
      return { templates: runtime.workflowService.list().templates.filter((template) => this.canUseTemplate(peer, template)) };
    }
    if (method === "POST" && path === "/api/templates") {
      const input = parseTemplateInput(body);
      this.assertTemplateInputScope(peer, input);
      return { template: runtime.workflowService.saveTemplate(input, remoteActor) };
    }
    if (method === "POST" && path === "/api/templates/import") {
      const template = runtime.workflowService.importTemplate(body.bundle ?? body, remoteActor);
      this.assertTemplateScope(peer, runtime, template.id);
      return { template };
    }
    if (path.startsWith("/api/templates/")) {
      const id = params[0];
      const version = positiveInteger(params[1]);
      const action = params[2] ?? (path.endsWith("/versions") ? "versions" : path.endsWith("/diff") ? "diff" : path.endsWith("/export") ? "export" : params[1]);
      this.assertTemplateScope(peer, runtime, id);
      if (method === "GET" && action === "versions") return { versions: runtime.workflowService.listTemplateVersions(id) };
      if (method === "GET" && action === "diff") return runtime.workflowService.diffTemplateVersions(id, positiveInteger(query.from), positiveInteger(query.to));
      if (method === "GET" && action === "export") return runtime.workflowService.exportTemplate(id, positiveInteger(query.version) ?? version);
      if (version && method === "POST" && action === "rollback") return { template: runtime.workflowService.restoreTemplateVersion(id, version, remoteActor) };
      if (version && method === "POST" && action === "preview") return runtime.workflowService.previewTemplateVersion(id, version, variableRecord(body.variables));
      if (version && method === "POST" && action === "run") {
        await this.assertCurrentSessionScope(peer, runtime);
        return { run: await runtime.workflowService.runTemplateVersion(id, version, variableRecord(body.variables), remoteActor) };
      }
      if (method === "PUT" && !action) {
        const input = { ...parseTemplateInput(body), id };
        this.assertTemplateInputScope(peer, input);
        return { template: runtime.workflowService.saveTemplate(input, remoteActor) };
      }
      if (method === "DELETE" && !action) return runtime.workflowService.deleteTemplate(id, remoteActor);
      if (method === "POST" && action === "preview") return runtime.workflowService.previewTemplate(id, variableRecord(body.variables));
      if (method === "POST" && action === "run") {
        await this.assertCurrentSessionScope(peer, runtime);
        return { run: await runtime.workflowService.runTemplate(id, variableRecord(body.variables), remoteActor) };
      }
    }
    if (method === "GET" && path === "/api/workflows") {
      const list = runtime.workflowService.list();
      return {
        workflows: list.workflows.filter((workflow) => this.canUseWorkflow(peer, workflow)),
        runs: list.runs.filter((run) => this.canUseWorkflowRun(peer, runtime, run)),
      };
    }
    if (method === "POST" && path === "/api/workflows") {
      const input = parseWorkflowInput(body);
      this.assertWorkflowInputScope(peer, input);
      return { workflow: runtime.workflowService.saveWorkflow(input, remoteActor) };
    }
    if (method === "POST" && path === "/api/workflows/import") {
      const workflow = runtime.workflowService.importWorkflow(body.bundle ?? body, remoteActor);
      this.assertWorkflowScope(peer, runtime, workflow.id);
      return { workflow };
    }
    if (path.startsWith("/api/workflow-runs/")) {
      const id = params[0];
      const action = params[1];
      this.assertWorkflowRunScope(peer, runtime, id);
      if (method === "GET" && !action) return { run: runtime.workflowStore.getRun(id) };
      if (method === "GET" && action === "report") return runtime.workflowService.runReport(id);
      if (method === "POST" && action === "cancel") return { run: await runtime.workflowService.cancelRun(id, remoteActor) };
      if (method === "POST" && action === "rerun-failed") return { run: runtime.workflowService.rerunFromFailedStep(id, remoteActor) };
    }
    if (path.startsWith("/api/workflows/")) {
      const id = params[0];
      const directAction = params[1];
      const directId = params[2];
      this.assertWorkflowScope(peer, runtime, id);
      if (method === "POST" && directAction === "dry-run") {
        return runtime.workflowService.dryRunWorkflow(id, variableRecord(body.variables), positiveInteger(body.version));
      }
      if (directAction === "triggers") {
        if (method === "GET" && !directId) return { triggers: runtime.workflowService.listWorkflowTriggers(id) };
        if (method === "POST" && !directId) {
          return runtime.workflowService.createWorkflowTrigger(id, {
            kind: stringValue(body.kind) === "webhook" ? "webhook" : "api",
            name: stringValue(body.name) || undefined,
            enabled: body.enabled !== false,
          }, remoteActor);
        }
        if (method === "DELETE" && directId) return runtime.workflowService.deleteWorkflowTrigger(id, directId, remoteActor);
      }
      const version = positiveInteger(params[1]);
      const action = params[2] ?? (path.endsWith("/versions") ? "versions" : path.endsWith("/diff") ? "diff" : path.endsWith("/export") ? "export" : params[1]);
      if (method === "GET" && action === "versions") return { versions: runtime.workflowService.listWorkflowVersions(id) };
      if (method === "GET" && action === "diff") return runtime.workflowService.diffWorkflowVersions(id, positiveInteger(query.from), positiveInteger(query.to));
      if (method === "GET" && action === "export") return runtime.workflowService.exportWorkflow(id, positiveInteger(query.version) ?? version);
      if (version && method === "POST" && action === "rollback") return { workflow: runtime.workflowService.restoreWorkflowVersion(id, version, remoteActor) };
      if (version && method === "POST" && action === "preview") return runtime.workflowService.previewWorkflowVersion(id, version, variableRecord(body.variables));
      if (version && method === "POST" && action === "run") {
        await this.assertCurrentSessionScope(peer, runtime);
        return { run: runtime.workflowService.runWorkflowVersion(id, version, variableRecord(body.variables), remoteActor) };
      }
      if (method === "PUT" && !action) {
        const input = { ...parseWorkflowInput(body), id };
        this.assertWorkflowInputScope(peer, input);
        return { workflow: runtime.workflowService.saveWorkflow(input, remoteActor) };
      }
      if (method === "DELETE" && !action) return runtime.workflowService.deleteWorkflow(id, remoteActor);
      if (method === "POST" && action === "preview") return runtime.workflowService.previewWorkflow(id, variableRecord(body.variables));
      if (method === "POST" && action === "run") {
        await this.assertCurrentSessionScope(peer, runtime);
        return { run: runtime.workflowService.runWorkflow(id, variableRecord(body.variables), remoteActor) };
      }
    }
    if (path.startsWith("/api/workflow-triggers/") && method === "POST") {
      return { run: await runtime.workflowService.runWorkflowTriggerToken(params[0] ?? "", variableRecord(body.variables)) };
    }
    throw unsupportedPeerRoute(method, path);
  }

  private async handleSessionWebRoute(context: PeerWebRouteContext, params: string[]): Promise<unknown> {
    const { peer, runtime, method, path, query, body, remoteActor } = context;
    if (method === "GET" && path === "/api/sessions") {
      const agentId = parseAgentId(query.agent);
      this.assertAgentScope(peer, agentId);
      return this.scopedSessionPage(peer, await runtime.listSessionsPage(numberValue(query.page, 1), numberValue(query.limit, 50), stringValue(query.query), agentId));
    }
    if (method === "GET" && path === "/api/sessions/detail") {
      const agentId = parseAgentId(query.agent);
      this.assertAgentScope(peer, agentId);
      const detail = await runtime.sessionDetail(requiredString(query.threadId, "threadId"), agentId);
      this.assertSessionDetailScope(peer, detail);
      return detail;
    }
    if (method === "POST" && path === "/api/sessions/name") {
      const agentId = parseAgentId(body.agentId);
      this.assertAgentScope(peer, agentId);
      const threadId = requiredString(body.threadId, "threadId");
      const detail = await runtime.sessionDetail(threadId, agentId);
      this.assertSessionDetailScope(peer, detail);
      const updated = await runtime.setSessionName(threadId, typeof body.name === "string" ? body.name : "", agentId, remoteActor);
      this.assertSessionDetailScope(peer, updated);
      return updated;
    }
    if (method === "POST" && path === "/api/agent") {
      const agentId = parseRequiredAgentId(body.agentId);
      this.assertAgentScope(peer, agentId);
      return { session: await runtime.setAgent(agentId, remoteActor) };
    }
    if (method === "POST" && path === "/api/sessions/new") {
      const agentId = parseAgentId(body.agentId);
      const workspace = this.resolveWorkspaceAlias(peer, stringValue(body.workspace) || undefined);
      this.assertAgentScope(peer, agentId);
      this.assertWorkspaceScope(peer, workspace);
      return {
        session: await runtime.newSession({
          agentId,
          workspace,
          workspaceMode: stringValue(body.workspaceMode) as never || undefined,
          model: stringValue(body.model) || undefined,
          reasoningEffort: stringValue(body.reasoningEffort) || undefined,
          launchProfileId: stringValue(body.launchProfileId) || undefined,
          fastMode: typeof body.fastMode === "boolean" ? body.fastMode : undefined,
        }, remoteActor),
      };
    }
    if (path.startsWith("/api/sessions/worktrees")) {
      return await this.handleSessionWorktreeWebRoute(context, params);
    }
    if (method === "POST" && path === "/api/sessions/switch") {
      const threadId = requiredString(body.threadId, "threadId");
      this.assertSessionDetailScope(peer, await runtime.sessionDetail(threadId));
      const session = await runtime.switchSession(threadId, remoteActor);
      this.assertSessionScope(peer, session);
      return { session };
    }
    if (method === "POST" && path === "/api/sessions/attach") {
      const threadId = requiredString(body.threadId, "threadId");
      this.assertSessionDetailScope(peer, await runtime.sessionDetail(threadId));
      const session = await runtime.attachSession(threadId, remoteActor);
      this.assertSessionScope(peer, session);
      return { session };
    }
    if (method === "GET" && path === "/api/models") {
      await this.assertCurrentSessionScope(peer, runtime);
      return { models: await runtime.listModels() };
    }
    if (method === "POST" && path === "/api/session/model") {
      await this.assertCurrentSessionScope(peer, runtime);
      return { session: await runtime.setModel(requiredString(body.model, "model"), remoteActor) };
    }
    if (method === "POST" && path === "/api/session/reasoning") {
      await this.assertCurrentSessionScope(peer, runtime);
      return { session: await runtime.setReasoningEffort(requiredString(body.reasoning, "reasoning"), remoteActor) };
    }
    if (method === "POST" && path === "/api/session/fast") {
      await this.assertCurrentSessionScope(peer, runtime);
      return { session: await runtime.setFastMode(Boolean(body.enabled), remoteActor) };
    }
    if (method === "POST" && path === "/api/session/launch") {
      await this.assertCurrentSessionScope(peer, runtime);
      return { session: await runtime.setLaunchProfile(requiredString(body.profileId, "profileId"), remoteActor, {
        applyToCurrent: Boolean(body.apply),
        confirmUnsafe: Boolean(body.confirmUnsafe),
      }) };
    }
    if (method === "POST" && path === "/api/prompt") {
      await this.assertCurrentSessionScope(peer, runtime);
      return runtime.sendPrompt(requiredString(body.text, "text"), remoteActor, stringValue(body.correlationId) || undefined);
    }
    if (method === "POST" && path === "/api/prompt/upload") {
      await this.assertCurrentSessionScope(peer, runtime);
      const files = Array.isArray(body.files) ? body.files.map((file, index) => parseUploadFile(file, index)) : [];
      return runtime.sendUploadPrompt({ text: stringValue(body.text), correlationId: stringValue(body.correlationId) || undefined, transcribeOnly: Boolean(body.transcribeOnly), files }, remoteActor);
    }
    if (method === "POST" && path.startsWith("/api/approvals/") && path.endsWith("/respond")) {
      await this.assertCurrentSessionScope(peer, runtime);
      const approvalId = params[0];
      if (!approvalId) throw unsupportedPeerRoute(method, path);
      return runtime.respondExternalApproval(approvalId, parseApprovalChoice(requiredString(body.choice, "choice")), remoteActor);
    }
    if (method === "POST" && (path === "/api/abort" || path === "/api/stop")) {
      await this.assertCurrentSessionScope(peer, runtime);
      await runtime.abort(remoteActor);
      return { ok: true };
    }
    if (method === "POST" && path === "/api/handback") {
      await this.assertCurrentSessionScope(peer, runtime);
      return runtime.handback(remoteActor);
    }
    if (method === "POST" && path === "/api/retry") {
      await this.assertCurrentSessionScope(peer, runtime);
      return runtime.retry(remoteActor);
    }
    if (method === "POST" && path === "/api/sync") {
      await this.assertCurrentSessionScope(peer, runtime);
      return runtime.sync(remoteActor);
    }
    throw unsupportedPeerRoute(method, path);
  }

  private async handleSessionWorktreeWebRoute(context: PeerWebRouteContext, params: string[]): Promise<unknown> {
    const { peer, runtime, method, path, body, remoteActor } = context;
    if (method === "GET" && path === "/api/sessions/worktrees") {
      await this.assertCurrentSessionScope(peer, runtime);
      return runtime.sessionWorktrees();
    }
    if (method === "POST" && path === "/api/sessions/worktrees/fork") {
      await this.assertCurrentSessionScope(peer, runtime);
      return runtime.forkCurrentSessionToWorktree({ includeUncommitted: Boolean(body.includeUncommitted) }, remoteActor);
    }
    if (method === "POST" && path === "/api/sessions/worktrees/compare") {
      await this.assertCurrentSessionScope(peer, runtime);
      const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
      return runtime.compareSessionWorktrees(ids);
    }
    if (method === "POST" && path === "/api/sessions/worktrees/integrate") {
      await this.assertCurrentSessionScope(peer, runtime);
      const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
      const resolutions = Array.isArray(body.resolutions) ? body.resolutions.map(parseWorktreeResolution).filter((item): item is WorktreeConflictResolution => Boolean(item)) : [];
      return { run: await runtime.integrateSessionWorktrees(ids, { resolutions }, remoteActor) };
    }
    if (method === "POST" && path === "/api/sessions/worktrees/integrate/preview") {
      await this.assertCurrentSessionScope(peer, runtime);
      const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
      return runtime.previewSessionWorktreeIntegration(ids);
    }
    if (method === "POST" && path === "/api/sessions/worktrees/integrate/patch") {
      await this.assertCurrentSessionScope(peer, runtime);
      const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
      return runtime.exportSessionWorktreeIntegrationPatch(ids);
    }
    if (method === "POST" && path === "/api/sessions/worktrees/cleanup") {
      await this.assertCurrentSessionScope(peer, runtime);
      return runtime.cleanupSessionWorktrees(remoteActor);
    }
    if (method === "POST" && path.startsWith("/api/sessions/worktrees/integrations/") && path.endsWith("/finalize")) {
      await this.assertCurrentSessionScope(peer, runtime);
      const integrationId = params[0];
      if (!integrationId) throw unsupportedPeerRoute(method, path);
      return runtime.finalizeSessionWorktreeIntegration(integrationId, {
        targetBranch: stringValue(body.targetBranch) || undefined,
        removeIntegrationWorktree: Boolean(body.removeIntegrationWorktree),
        removeSourceWorktrees: Boolean(body.removeSourceWorktrees),
        deleteIntegrationBranch: Boolean(body.deleteIntegrationBranch),
      }, remoteActor);
    }
    const id = params[0];
    const action = params[1];
    if (id && method === "GET" && action === "diff") {
      await this.assertCurrentSessionScope(peer, runtime);
      return runtime.sessionWorktreeDiff(id);
    }
    if (id && method === "POST" && action === "update") {
      await this.assertCurrentSessionScope(peer, runtime);
      return runtime.updateSessionWorktreeFromBase(id, remoteActor);
    }
    if (id && method === "POST" && action === "commit") {
      await this.assertCurrentSessionScope(peer, runtime);
      return runtime.commitSessionWorktree(id, stringValue(body.message), remoteActor);
    }
    if (id && method === "DELETE" && !action) {
      await this.assertCurrentSessionScope(peer, runtime);
      return { record: await runtime.removeSessionWorktree(id, Boolean(body.force), remoteActor) };
    }
    throw unsupportedPeerRoute(method, path);
  }

  private async handleQueueWebRoute(context: PeerWebRouteContext, params: string[]): Promise<unknown> {
    const { peer, runtime, method, path, body, remoteActor } = context;
    if (method === "GET" && path === "/api/queue") {
      await this.assertCurrentSessionScope(peer, runtime);
      return { queue: runtime.queue(), paused: runtime.queuePaused() };
    }
    if (method === "POST" && path === "/api/queue") {
      await this.assertCurrentSessionScope(peer, runtime);
      return { queue: runtime.queueAction(requiredString(body.action, "action") as never, stringValue(body.id) || undefined, remoteActor), paused: runtime.queuePaused() };
    }
    if (method === "GET" && path === "/api/queue/plans") {
      return await this.scopedQueuePlanner(peer, runtime);
    }
    if (method === "POST" && path === "/api/queue/plans") {
      await this.assertCurrentSessionScope(peer, runtime);
      const input = parseQueuePlanInput(body);
      this.assertQueuePlanInputScope(peer, input);
      const plan = await runtime.createQueuePlan(input, remoteActor);
      this.assertQueuePlanScope(peer, plan);
      return { plan, snapshot: await this.scopedQueuePlanner(peer, runtime) };
    }
    const id = params[0];
    const action = params[1];
    if (id) {
      this.assertQueuePlanIdScope(peer, runtime, id);
      if (method === "PATCH" && !action) {
        const input = parseQueuePlanPatchInput(body);
        this.assertQueuePlanInputScope(peer, input);
        return { plan: runtime.updateQueuePlan(id, input, remoteActor), snapshot: await this.scopedQueuePlanner(peer, runtime) };
      }
      if (method === "DELETE" && !action) {
        const result = runtime.deleteQueuePlan(id, remoteActor);
        return { ...result, snapshot: await this.scopedQueuePlanner(peer, runtime) };
      }
      if (method === "POST" && action === "move") {
        const plan = await runtime.moveQueuePlan(id, parseQueuePlanStatus(requiredString(body.status, "status")), remoteActor);
        return { plan, snapshot: await this.scopedQueuePlanner(peer, runtime) };
      }
      if (method === "POST" && action === "approve") {
        return { plan: runtime.approveQueuePlan(id, remoteActor), snapshot: await this.scopedQueuePlanner(peer, runtime) };
      }
      if (method === "POST" && action === "enqueue") {
        const plan = await runtime.enqueueQueuePlan(id, remoteActor);
        return { plan, snapshot: await this.scopedQueuePlanner(peer, runtime) };
      }
    }
    throw unsupportedPeerRoute(method, path);
  }

  private async handleChatWebRoute(context: PeerWebRouteContext): Promise<unknown> {
    const { peer, runtime, method, path, query, body, remoteActor } = context;
    if (method === "GET" && path === "/api/chat/history") {
      await this.assertCurrentSessionScope(peer, runtime);
      return { messages: await runtime.chatHistory(numberValue(query.limit, 200)) };
    }
    if (method === "GET" && path === "/api/chat/attachment") {
      await this.assertCurrentSessionScope(peer, runtime);
      const attachment = await runtime.chatAttachment(
        requiredString(query.messageId, "messageId"),
        requiredString(query.attachmentId, "attachmentId"),
      );
      if (!attachment) {
        throw new Error("Chat attachment not found");
      }
      return attachment;
    }
    if (method === "GET" && path === "/api/chat/mirror") {
      await this.assertCurrentSessionScope(peer, runtime);
      return runtime.webMirrorPreference("");
    }
    if (method === "POST" && path === "/api/chat/mirror") {
      await this.assertCurrentSessionScope(peer, runtime);
      return runtime.webMirrorPreference(stringValue(body.argument) || stringValue(body.mode) || "", remoteActor);
    }
    if (method === "DELETE" && path === "/api/chat/history") {
      await this.assertCurrentSessionScope(peer, runtime);
      return runtime.clearChatHistory(remoteActor);
    }
    throw unsupportedPeerRoute(method, path);
  }

  private handleActivityWebRoute(context: PeerWebRouteContext): unknown {
    const { peer, runtime, method, path, query } = context;
    if (method === "GET" && path === "/api/activity") {
      return { events: runtime.activity({ limit: numberValue(query.limit, 100), source: stringValue(query.source) as never || "all", status: stringValue(query.status) as never || "all", category: stringValue(query.category) as never || "all", actor: stringValue(query.actor), agentId: stringValue(query.agentId), threadId: stringValue(query.threadId), workspace: stringValue(query.workspace), type: stringValue(query.type), since: stringValue(query.since) }).filter((event) => this.canUseSession(peer, event)) };
    }
    throw unsupportedPeerRoute(method, path);
  }

  private async handleArtifactWebRoute(context: PeerWebRouteContext): Promise<unknown> {
    const { peer, runtime, method, path, query, body, remoteActor } = context;
    if (method === "GET" && path === "/api/artifacts") {
      await this.assertCurrentSessionScope(peer, runtime);
      return { reports: await runtime.artifacts() };
    }
    if (method === "GET" && path === "/api/artifacts/usage") {
      await this.assertCurrentSessionScope(peer, runtime);
      return runtime.artifactUsage();
    }
    if (method === "POST" && path === "/api/artifacts/cleanup/preview") {
      await this.assertCurrentSessionScope(peer, runtime);
      return runtime.artifactCleanupPreview();
    }
    if (method === "POST" && path === "/api/artifacts/cleanup/run") {
      await this.assertCurrentSessionScope(peer, runtime);
      return runtime.artifactCleanupRun(remoteActor);
    }
    if (method === "GET" && path === "/api/artifacts/preview") {
      await this.assertCurrentSessionScope(peer, runtime);
      return runtime.artifactPreview(requiredString(query.turnId, "turnId"), requiredString(query.path, "path"));
    }
    if (method === "GET" && path === "/api/artifacts/diff") {
      await this.assertCurrentSessionScope(peer, runtime);
      return runtime.artifactDiff(requiredString(query.turnId, "turnId"), requiredString(query.path, "path"));
    }
    if (method === "DELETE" && path === "/api/artifacts") {
      await this.assertCurrentSessionScope(peer, runtime);
      return { removed: await runtime.deleteArtifact(requiredString(query.turnId, "turnId"), remoteActor) };
    }
    if (method === "POST" && path === "/api/artifacts/bulk") {
      await this.assertCurrentSessionScope(peer, runtime);
      const action = requiredString(body.action, "action");
      if (action !== "delete") throw new Error("Unsupported artifact bulk action.");
      const turnIds = Array.isArray(body.turnIds) ? body.turnIds.filter((item): item is string => typeof item === "string") : [];
      const removed: string[] = [];
      for (const turnId of turnIds) {
        if (await runtime.deleteArtifact(turnId, remoteActor)) removed.push(turnId);
      }
      return { removed };
    }
    if (method === "GET" && path === "/api/artifacts/zip") {
      await this.assertCurrentSessionScope(peer, runtime);
      const bundle = await runtime.createArtifactZip(requiredString(query.turnId, "turnId"), remoteActor);
      if (!bundle) throw new Error("Artifact turn not found or ZIP could not be created.");
      return { name: bundle.name, mimeType: "application/zip", dataBase64: readFileSync(bundle.path).toString("base64") };
    }
    if (method === "GET" && path === "/api/artifacts/file") {
      await this.assertCurrentSessionScope(peer, runtime);
      const turnId = requiredString(query.turnId, "turnId");
      const relativePath = requiredString(query.path, "path");
      const preview = await runtime.artifactPreview(turnId, relativePath);
      if (preview?.safeStatus === "blocked") {
        throw new Error("Artifact blocked by safe-file policy.");
      }
      const report = await runtime.artifact(turnId);
      const artifact = report?.artifacts.find((candidate) => candidate.relativePath === relativePath);
      if (!artifact) throw new Error("Artifact not found.");
      return { name: artifact.name, mimeType: mimeTypeFromName(artifact.name), dataBase64: readFileSync(artifact.localPath).toString("base64"), sizeBytes: artifact.sizeBytes };
    }
    throw unsupportedPeerRoute(method, path);
  }

  private handleOperationsWebRoute(context: PeerWebRouteContext): unknown {
    const { runtime, method, path, query, body, remoteActor } = context;
    if (method === "GET" && path === "/api/logs") return runtime.logs((stringValue(query.target) || "connector") as never, {
      limit: numberValue(query.limit, numberValue(query.lines, 100)),
      cursor: stringValue(query.cursor) || null,
      level: stringValue(query.level) || null,
      search: stringValue(query.search) || null,
      since: stringValue(query.since) || null,
    });
    if (method === "POST" && path === "/api/logs/clear") return runtime.clearLogs((stringValue(body.target) || "connector") as never, remoteActor);
    if (method === "POST" && path === "/api/runtime/restart") return runtime.restartConnector(remoteActor);
    throw unsupportedPeerRoute(method, path);
  }

  private async handlePeerProbe(peer: PeerRecord, payload: unknown): Promise<unknown> {
    const requestedUrl = stringValue(objectRecord(payload).url);
    if (!peer.url) {
      throw new Error("Remote probe refused because this peer has no registered URL. Pair with --public-url or set the peer URL first.");
    }
    if (requestedUrl && normalizePeerUrl(requestedUrl) !== normalizePeerUrl(peer.url)) {
      throw new Error("Remote probe refused because the requested URL does not match this peer's registered URL.");
    }
    return await checkPeerEndpoint(peer.url, { expectedTlsFingerprint: peer.tlsFingerprint });
  }

  private assertScope(peer: PeerRecord, permission: Permission): void {
    if (!peer.scopes.includes(permission)) {
      throw new Error(`Peer permission denied: ${permission}`);
    }
  }

  private runtimeFor(peer: PeerRecord, sourceContextKey?: ChannelContextKey): RelayRuntime {
    return this.options.runtimeForContext?.(peer, sourceContextKey) ?? this.runtime;
  }

  private assertAgentScope(peer: PeerRecord, agentId?: AgentId): void {
    if (agentId && !this.canUseAgent(peer, agentId)) {
      throw new Error(`Peer is not allowed to use agent: ${agentId}`);
    }
  }

  private canUseAgent(peer: PeerRecord, agentId: AgentId): boolean {
    return peer.allowedAgents.length === 0 || peer.allowedAgents.includes(agentId);
  }

  private assertWorkspaceScope(peer: PeerRecord, workspace: string | undefined): void {
    const resolved = this.resolveWorkspaceAlias(peer, workspace);
    if (!resolved || peer.allowedWorkspaceRoots.length === 0) {
      return;
    }
    const normalized = resolved.replace(/\\/g, "/");
    const allowed = peer.allowedWorkspaceRoots.some((root) => {
      const normalizedRoot = root.replace(/\\/g, "/").replace(/\/+$/, "");
      return normalized === normalizedRoot || normalized.startsWith(`${normalizedRoot}/`);
    });
    if (!allowed) {
      throw new Error(`Peer is not allowed to use workspace: ${workspace}`);
    }
  }

  private async assertCurrentSessionScope(peer: PeerRecord, runtime: RelayRuntime): Promise<void> {
    const snapshot = await runtime.snapshot();
    this.assertSessionScope(peer, snapshot.session);
  }

  private assertSessionScope(peer: PeerRecord, session: { agentId?: string; workspace?: string; cwd?: string } | Record<string, unknown>): void {
    const agentId = typeof session.agentId === "string" ? session.agentId : undefined;
    const workspace = typeof session.workspace === "string"
      ? session.workspace
      : typeof session.cwd === "string"
        ? session.cwd
        : undefined;
    this.assertAgentScope(peer, parseAgentId(agentId));
    this.assertWorkspaceScope(peer, workspace);
  }

  private assertSessionDetailScope(peer: PeerRecord, detail: Record<string, unknown>): void {
    const record = objectRecord(detail.record);
    if (Object.keys(record).length > 0) {
      this.assertSessionScope(peer, record);
    }
  }

  private canUseSession(peer: PeerRecord, session: { agentId?: string; workspace?: string; cwd?: string } | Record<string, unknown>): boolean {
    try {
      this.assertSessionScope(peer, session);
      return true;
    } catch {
      return false;
    }
  }

  private scopedSnapshot(peer: PeerRecord, snapshot: RelaySnapshot): RelaySnapshot {
    this.assertSessionScope(peer, snapshot.session);
    return {
      ...snapshot,
      enabledAgents: snapshot.enabledAgents.filter((agentId) => this.canUseAgent(peer, agentId)),
      workspaces: uniqueStrings([
        ...Object.keys(peer.workspaceAliases ?? {}),
        ...snapshot.workspaces.filter((workspace) => this.workspaceAllowed(peer, workspace)),
      ]),
    };
  }

  private scopedBootstrapStatus(peer: PeerRecord, status: Record<string, unknown>): Record<string, unknown> {
    const snapshot = status.snapshot;
    if (isRelaySnapshot(snapshot)) {
      return {
        ...status,
        snapshot: this.scopedSnapshot(peer, snapshot),
      };
    }
    return status;
  }

  private scopedDiagnostics(peer: PeerRecord, diagnostics: WebDiagnosticsDto): WebDiagnosticsDto {
    return {
      ...diagnostics,
      snapshot: this.scopedSnapshot(peer, diagnostics.snapshot),
    };
  }

  private scopedControlOptions<T extends { workspaces: string[] }>(peer: PeerRecord, options: T): T {
    return {
      ...options,
      workspaces: uniqueStrings([
        ...Object.keys(peer.workspaceAliases ?? {}),
        ...options.workspaces.filter((workspace) => this.workspaceAllowed(peer, workspace)),
      ]),
    };
  }

  private scopedSessionPage(peer: PeerRecord, page: SessionPageDto): SessionPageDto {
    return {
      ...page,
      sessions: page.sessions.filter((session) => this.canUseThreadRecord(peer, session)),
    };
  }

  private scopedTasks(peer: PeerRecord, tasks: WebTasksDto): WebTasksDto {
    const currentAllowed = tasks.current ? this.canUseSession(peer, tasks.current) : true;
    return {
      ...tasks,
      current: tasks.current && this.canUseSession(peer, tasks.current) ? tasks.current : null,
      external: tasks.external && this.canUseSession(peer, tasks.external) ? tasks.external : null,
      queue: currentAllowed ? tasks.queue : [],
      recent: tasks.recent.filter((event) => this.canUseSession(peer, event)),
    };
  }

  private scopedActiveSessions(peer: PeerRecord, active: ActiveSessionsDto): ActiveSessionsDto {
    return {
      ...active,
      sessions: active.sessions.filter((session) => this.canUseSession(peer, session)),
    };
  }

  private async scopedQueuePlanner(peer: PeerRecord, runtime: RelayRuntime): Promise<QueuePlannerSnapshotDto> {
    const snapshot = runtime.queuePlanner();
    const plans = snapshot.plans.filter((plan) => this.canUseQueuePlan(peer, plan));
    const columns = Object.fromEntries(QUEUE_PLAN_STATUSES.map((status) => [
      status,
      plans.filter((plan) => plan.effectiveStatus === status),
    ])) as QueuePlannerSnapshotDto["columns"];
    return {
      ...snapshot,
      plans,
      columns,
      queue: await this.currentSessionAllowed(peer, runtime) ? snapshot.queue : [],
      inProgress: snapshot.inProgress.filter((task) => this.canUseSession(peer, task)),
    };
  }

  private scopedJobs(peer: PeerRecord, jobs: UnifiedJobsDto): UnifiedJobsDto {
    return {
      ...jobs,
      jobs: jobs.jobs.filter((job) => this.canUseJob(peer, job)),
    };
  }

  private scopedTrace(peer: PeerRecord, trace: TraceDetailDto): TraceDetailDto {
    const activity = trace.activity.filter((event) => this.canUseSession(peer, event));
    const jobs = trace.jobs.filter((job) => this.canUseJob(peer, job));
    const timeline = trace.timeline.filter((item) => this.canUseSession(peer, item));
    const threadId = activity.find((event) => event.threadId)?.threadId ?? jobs.find((job) => job.threadId)?.threadId ?? trace.summary.threadId;
    const workspace = activity.find((event) => event.workspace)?.workspace ?? jobs.find((job) => job.workspace)?.workspace ?? trace.summary.workspace;
    const agentId = activity.find((event) => event.agentId)?.agentId ?? jobs.find((job) => job.agentId)?.agentId ?? trace.summary.agentId;
    return {
      ...trace,
      activity,
      jobs,
      timeline,
      audit: [],
      chat: trace.chat.filter((message) => !threadId || message.threadId === threadId),
      queue: trace.queue,
      summary: {
        ...trace.summary,
        threadId,
        workspace,
        agentId,
      },
    };
  }

  private canUseJob(peer: PeerRecord, job: UnifiedJobDto): boolean {
    return this.canUseSession(peer, job);
  }

  private canUseTemplate(peer: PeerRecord, template: PromptTemplate): boolean {
    return template.scope === "shared" &&
      (!template.defaultAgentId || this.canUseAgent(peer, template.defaultAgentId)) &&
      this.workspaceAllowed(peer, template.defaultWorkspace);
  }

  private canUseWorkflow(peer: PeerRecord, workflow: Workflow): boolean {
    return workflow.scope === "shared" && workflow.steps.every((step) => this.canUseWorkflowStep(peer, step));
  }

  private canUseWorkflowStep(peer: PeerRecord, step: WorkflowStep): boolean {
    return step.target === "local" &&
      (!step.agentId || this.canUseAgent(peer, step.agentId)) &&
      this.workspaceAllowed(peer, step.workspace);
  }

  private assertTemplateScope(peer: PeerRecord, runtime: RelayRuntime, id: string): void {
    const template = runtime.workflowStore.getTemplate(id);
    if (template && !this.canUseTemplate(peer, template)) {
      throw new Error("Peer is not allowed to use this template.");
    }
  }

  private assertWorkflowScope(peer: PeerRecord, runtime: RelayRuntime, id: string): void {
    const workflow = runtime.workflowStore.getWorkflow(id);
    if (workflow && !this.canUseWorkflow(peer, workflow)) {
      throw new Error("Peer is not allowed to use this workflow.");
    }
  }

  private assertTemplateInputScope(peer: PeerRecord, input: Partial<PromptTemplate>): void {
    if (input.defaultAgentId) this.assertAgentScope(peer, input.defaultAgentId);
    this.assertWorkspaceScope(peer, input.defaultWorkspace);
  }

  private assertWorkflowInputScope(peer: PeerRecord, input: Partial<Workflow>): void {
    for (const step of input.steps ?? []) {
      if (step.target !== "local") {
        throw new Error("Peer-proxied workflows cannot target another peer.");
      }
      if (step.agentId) this.assertAgentScope(peer, step.agentId);
      this.assertWorkspaceScope(peer, step.workspace);
    }
  }

  private canUseWorkflowRun(peer: PeerRecord, runtime: RelayRuntime, run: WorkflowRun): boolean {
    if (run.workflowSnapshot && !this.canUseWorkflow(peer, run.workflowSnapshot)) {
      return false;
    }
    if (run.templateSnapshot && !this.canUseTemplate(peer, run.templateSnapshot)) {
      return false;
    }
    if (run.workflowId) {
      const workflow = runtime.workflowStore.getWorkflow(run.workflowId);
      return !workflow || this.canUseWorkflow(peer, workflow);
    }
    if (run.templateId) {
      const template = runtime.workflowStore.getTemplate(run.templateId);
      return !template || this.canUseTemplate(peer, template);
    }
    return true;
  }

  private assertQueuePlanIdScope(peer: PeerRecord, runtime: RelayRuntime, id: string): void {
    const plan = runtime.queuePlanStore.get(id);
    if (plan && !this.canUseQueuePlan(peer, plan)) {
      throw new Error("Peer is not allowed to use this queue plan.");
    }
  }

  private assertQueuePlanScope(peer: PeerRecord, plan: QueuePlanDto): void {
    if (!this.canUseQueuePlan(peer, plan)) {
      throw new Error("Peer is not allowed to use this queue plan.");
    }
  }

  private canUseQueuePlan(peer: PeerRecord, plan: { agentId?: string; workspace?: string; threadId?: string | null }): boolean {
    return this.canUseSession(peer, { agentId: plan.agentId, workspace: plan.workspace });
  }

  private assertQueuePlanInputScope(peer: PeerRecord, input: Partial<QueuePlanInput>): void {
    if (input.agentId) this.assertAgentScope(peer, input.agentId);
    this.assertWorkspaceScope(peer, input.workspace);
  }

  private assertWorkflowRunScope(peer: PeerRecord, runtime: RelayRuntime, id: string): void {
    const run = runtime.workflowStore.getRun(id);
    if (run && !this.canUseWorkflowRun(peer, runtime, run)) {
      throw new Error("Peer is not allowed to use this workflow run.");
    }
  }

  private assertAgentUpdateJobScope(peer: PeerRecord, runtime: RelayRuntime, id: string): void {
    const job = runtime.agentUpdateJobs().find((candidate) => candidate.id === id);
    if (job) {
      this.assertAgentScope(peer, job.agentId);
    }
  }

  private async scopeRelayEvent(peer: PeerRecord, runtime: RelayRuntime, event: RelayEvent): Promise<RelayEvent | null> {
    switch (event.type) {
      case "snapshot":
        return { ...event, data: this.scopedSnapshot(peer, event.data) };
      case "session_update":
        return this.canUseAgentSessionInfo(peer, event.session) ? event : null;
      case "activity_update":
        return { ...event, events: event.events.filter((item) => this.canUseSession(peer, item)) };
      case "active_sessions_update":
        return { ...event, active: this.scopedActiveSessions(peer, event.active) };
      case "agent_update":
        return this.canUseAgent(peer, event.job.agentId) ? event : null;
      case "status":
        return event;
      case "chat_history":
      case "queue_update":
      case "turn_start":
      case "text_delta":
      case "tool_start":
      case "tool_update":
      case "tool_end":
      case "todo_update":
      case "turn_complete":
      case "turn_error":
        return await this.currentSessionAllowed(peer, runtime) ? event : null;
    }
  }

  private async currentSessionAllowed(peer: PeerRecord, runtime: RelayRuntime): Promise<boolean> {
    try {
      await this.assertCurrentSessionScope(peer, runtime);
      return true;
    } catch {
      return false;
    }
  }

  private canUseThreadRecord(peer: PeerRecord, record: AgentThreadRecord): boolean {
    return this.canUseAgent(peer, record.agentId) && this.workspaceAllowed(peer, record.cwd);
  }

  private canUseAgentSessionInfo(peer: PeerRecord, info: AgentSessionInfo): boolean {
    return this.canUseAgent(peer, info.agentId) && this.workspaceAllowed(peer, info.workspace);
  }

  private workspaceAllowed(peer: PeerRecord, workspace: string | undefined): boolean {
    try {
      this.assertWorkspaceScope(peer, workspace);
      return true;
    } catch {
      return false;
    }
  }

  private resolveWorkspaceAlias(peer: PeerRecord, workspace: string | undefined): string | undefined {
    if (!workspace) return undefined;
    return peer.workspaceAliases?.[workspace] ?? workspace;
  }
}

export function peerError(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: Error }).cause;
    const base = error.message || String(error);
    return cause?.message ? `${base}: ${cause.message}` : base;
  }
  return String(error);
}

function peerActor(peer: PeerRecord, actor?: WebActivityActor): WebActivityActor {
  return {
    channel: "system",
    id: `peer:${peer.id}${actor?.id ? `:${actor.id}` : ""}`,
    label: actor?.label ? `${actor.label} via ${peer.name}` : `Peer ${peer.name}`,
    username: actor?.username,
    channelUserId: actor?.channelUserId,
  };
}

function normalizeMethod(value: unknown): WebHttpMethod {
  const method = typeof value === "string" ? value.toUpperCase() : "GET";
  return isWebHttpMethod(method) ? method : "GET";
}

function isWebHttpMethod(value: string): value is WebHttpMethod {
  return value === "GET" || value === "POST" || value === "PATCH" || value === "PUT" || value === "DELETE";
}

function normalizePath(value: unknown): string {
  const path = typeof value === "string" ? value.trim() : "";
  if (!path.startsWith("/api/")) {
    throw new Error("Only /api routes can be proxied.");
  }
  return path;
}

function normalizePeerUrl(value: string): string {
  const url = new URL(value);
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function nonEmptyRecord(value: unknown): Record<string, unknown> | undefined {
  const record = objectRecord(value);
  return Object.keys(record).length ? record : undefined;
}

function parseAgentId(value: unknown): AgentId | undefined {
  const text = stringValue(value);
  return isAgentId(text) ? text : undefined;
}

function parseRequiredAgentId(value: unknown): AgentId {
  const agentId = parseAgentId(value);
  if (!agentId) {
    throw new Error("agentId is required.");
  }
  return agentId;
}

function parseApprovalChoice(value: string): AgentApprovalChoice {
  if (value === "yes" || value === "persist" || value === "no") {
    return value;
  }
  throw new Error(`Invalid approval choice: ${value}`);
}

function parseWorkspaceMode(value: unknown): WorkflowStep["workspaceMode"] {
  const text = stringValue(value);
  return text === "shared" || text === "worktree" || text === "attached" ? text : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : value === undefined || value === null ? "" : String(value).trim();
}

function requiredString(value: unknown, key: string): string {
  const text = stringValue(value);
  if (!text) {
    throw new Error(`${key} is required.`);
  }
  return text;
}

function numberValue(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(stringValue(value));
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function optionalNumberValue(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(stringValue(value));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseUploadFile(value: unknown, index: number): { name: string; mimeType?: string; data: Buffer } {
  const record = objectRecord(value);
  const dataBase64 = requiredString(record.dataBase64, `files[${index}].dataBase64`);
  return {
    name: stringValue(record.name) || `upload-${index + 1}`,
    mimeType: stringValue(record.mimeType) || undefined,
    data: Buffer.from(dataBase64.replace(/^data:[^,]+,/, ""), "base64"),
  };
}

function isRelaySnapshot(value: unknown): value is RelaySnapshot {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) &&
    "session" in value &&
    "enabledAgents" in value &&
    "workspaces" in value);
}

function parseAgentUpdateOperation(value: string): "update" | "install" {
  if (!value || value === "update") {
    return "update";
  }
  if (value === "install") {
    return "install";
  }
  throw new Error(`Invalid agent update operation: ${value}`);
}

function unsupportedPeerRoute(method: WebHttpMethod, path: string): Error {
  return new Error(`Remote endpoint is not implemented: ${method} ${path}`);
}

function permissionForJobAction(id: string, action: "cancel" | "retry"): Permission {
  if (id === "web:current" && action === "cancel") {
    return "prompt.abort";
  }
  if (id.startsWith("queue:")) {
    return "queue.write";
  }
  if (id.startsWith("support-bundle:")) {
    return "diagnostics.read";
  }
  if (id.startsWith("workflow-run:")) {
    return "workflows.run";
  }
  return "updates.run";
}

function positiveInteger(value: unknown): number | undefined {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function parseTemplateInput(body: Record<string, unknown>): Partial<PromptTemplate> & Pick<PromptTemplate, "name" | "prompt"> {
  return {
    id: stringValue(body.id) || undefined,
    name: requiredString(body.name, "name"),
    description: stringValue(body.description) || undefined,
    tags: stringList(body.tags),
    prompt: requiredString(body.prompt, "prompt"),
    variables: Array.isArray(body.variables) ? body.variables.map((variable) => {
      const record = objectRecord(variable);
      return {
        name: requiredString(record.name, "variable.name"),
        label: stringValue(record.label) || undefined,
        required: record.required !== false,
        defaultValue: stringValue(record.defaultValue) || undefined,
      };
    }) : undefined,
    defaultAgentId: parseAgentId(body.defaultAgentId),
    defaultWorkspace: stringValue(body.defaultWorkspace) || undefined,
    defaultModel: stringValue(body.defaultModel) || undefined,
    defaultReasoning: stringValue(body.defaultReasoning) || undefined,
    defaultLaunchProfile: stringValue(body.defaultLaunchProfile) || undefined,
    scope: body.scope === "shared" ? "shared" : "private",
  };
}

function parseWorkflowInput(body: Record<string, unknown>): Partial<Workflow> & Pick<Workflow, "name" | "steps"> {
  return {
    id: stringValue(body.id) || undefined,
    name: requiredString(body.name, "name"),
    description: stringValue(body.description) || undefined,
    tags: stringList(body.tags),
    steps: Array.isArray(body.steps) ? body.steps.map(parseWorkflowStepInput) : [],
    schedule: nonEmptyRecord(body.schedule) as Workflow["schedule"],
    scope: body.scope === "shared" ? "shared" : "private",
  };
}

function parseWorkflowStepInput(value: unknown): WorkflowStep {
  const record = objectRecord(value);
  const target = stringValue(record.target);
  return {
    id: stringValue(record.id) || "",
    name: stringValue(record.name) || "Step",
    type: record.type === "workflow" ? "workflow" : "prompt",
    prompt: stringValue(record.prompt) || undefined,
    templateId: stringValue(record.templateId) || undefined,
    workflowId: stringValue(record.workflowId) || undefined,
    condition: nonEmptyRecord(record.condition) as WorkflowStep["condition"],
    retryPolicy: nonEmptyRecord(record.retryPolicy) as WorkflowStep["retryPolicy"],
    agentId: parseAgentId(record.agentId),
    workspace: stringValue(record.workspace) || undefined,
    workspaceMode: parseWorkspaceMode(record.workspaceMode),
    model: stringValue(record.model) || undefined,
    reasoningEffort: stringValue(record.reasoningEffort) || undefined,
    launchProfileId: stringValue(record.launchProfileId) || undefined,
    sessionMode: record.sessionMode === "new" || record.sessionMode === "attach" ? record.sessionMode : "current",
    threadId: stringValue(record.threadId) || undefined,
    target: target.startsWith("peer:") ? target as WorkflowStep["target"] : "local",
    requiresApproval: Boolean(record.requiresApproval),
    continueOnError: Boolean(record.continueOnError),
  };
}

function parseQueuePlanInput(body: Record<string, unknown>): QueuePlanInput {
  return {
    title: stringValue(body.title) || undefined,
    prompt: requiredString(body.prompt, "prompt"),
    status: body.status === undefined ? undefined : parseQueuePlanStatus(requiredString(body.status, "status")),
    labels: stringList(body.labels),
    priority: optionalNumberValue(body.priority),
    agentId: parseAgentId(body.agentId),
    workspace: stringValue(body.workspace) || undefined,
    threadId: stringValue(body.threadId) || undefined,
  };
}

function parseQueuePlanPatchInput(body: Record<string, unknown>): Partial<QueuePlanInput> {
  const prompt = body.prompt === undefined ? undefined : stringValue(body.prompt);
  if (prompt !== undefined && !prompt) throw new Error("prompt is required.");
  return Object.fromEntries(Object.entries({
    title: body.title === undefined ? undefined : stringValue(body.title),
    prompt,
    status: body.status === undefined ? undefined : parseQueuePlanStatus(requiredString(body.status, "status")),
    labels: body.labels === undefined ? undefined : stringList(body.labels),
    priority: body.priority === undefined ? undefined : optionalNumberValue(body.priority),
    agentId: body.agentId === undefined ? undefined : parseAgentId(body.agentId),
    workspace: body.workspace === undefined ? undefined : stringValue(body.workspace),
    threadId: body.threadId === undefined ? undefined : stringValue(body.threadId),
  }).filter(([, value]) => value !== undefined)) as Partial<QueuePlanInput>;
}

function parseQueuePlanStatus(value: string): QueuePlanStatus {
  if (!QUEUE_PLAN_STATUSES.includes(value as QueuePlanStatus)) {
    throw new Error("Unsupported queue plan status.");
  }
  return value as QueuePlanStatus;
}

function parseWorktreeResolution(value: unknown): WorktreeConflictResolution | null {
  const record = objectRecord(value);
  const path = stringValue(record.path);
  const choice = stringValue(record.choice) || "auto";
  if (!path || !["auto", "ours", "theirs", "both", "manual"].includes(choice)) return null;
  return {
    path,
    choice: choice as WorktreeConflictResolution["choice"],
    sourceWorktreeId: stringValue(record.sourceWorktreeId) || undefined,
    content: stringValue(record.content) || undefined,
  };
}

function variableRecord(value: unknown): Record<string, string> {
  return Object.fromEntries(
    Object.entries(objectRecord(value)).map(([key, raw]) => [key, String(raw ?? "")]),
  );
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

function isGitHubSource(source: string): boolean {
  return source.startsWith("github:") || /^https:\/\/github\.com\//i.test(source);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function mimeTypeFromName(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".csv")) return "text/csv";
  if (lower.endsWith(".md") || lower.endsWith(".txt") || lower.endsWith(".log")) return "text/plain";
  return "application/octet-stream";
}
