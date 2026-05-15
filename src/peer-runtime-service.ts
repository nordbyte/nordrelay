import { readFileSync } from "node:fs";

import { enabledAgents } from "./agent-factory.js";
import { listAgentAdapterDescriptors } from "./agent-adapter.js";
import { isAgentId, type AgentId, type AgentSessionInfo, type AgentThreadRecord } from "./agent.js";
import { permissionForWebRequest, type Permission } from "./access-control.js";
import { listChannelDescriptors } from "./channel-adapter.js";
import type { ConnectorConfig } from "./config.js";
import { friendlyErrorText } from "./error-messages.js";
import type { PeerRecord, PeerRpcRequest, PeerWebProxyPayload } from "./peer-types.js";
import type { RelayRuntime } from "./relay-runtime.js";
import type { ActiveSessionsDto, RelayEvent, RelaySnapshot, SessionPageDto, UnifiedJobDto, UnifiedJobsDto, WebDiagnosticsDto, WebTasksDto } from "./relay-runtime-types.js";
import type { WebActivityActor } from "./web-state.js";

export class PeerRuntimeService {
  constructor(
    private readonly config: ConnectorConfig,
    private readonly runtime: RelayRuntime,
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
      return { ok: true, at: new Date().toISOString() };
    }
    throw new Error(`Unsupported peer RPC type: ${request.type}`);
  }

  subscribe(peer: PeerRecord, send: (event: RelayEvent) => void): () => void {
    this.assertScope(peer, "sessions.read");
    return this.runtime.subscribe((event) => {
      void this.scopeRelayEvent(peer, event)
        .then((scoped) => {
          if (scoped) send(scoped);
        })
        .catch(() => {
          // If a scope check fails for an event, drop that event for this peer.
        });
    });
  }

  private async handleWebProxy(peer: PeerRecord, payload: PeerWebProxyPayload, actor?: WebActivityActor): Promise<unknown> {
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

    if (method === "GET" && path === "/api/bootstrap") {
      const agentId = parseAgentId(query.agent);
      this.assertAgentScope(peer, agentId);
      const status = this.scopedBootstrapStatus(peer, await this.runtime.bootstrapStatus());
      return {
        auth: {
          user: { id: `peer:${peer.id}`, email: `${peer.name}@peer.local`, displayName: peer.name, active: true },
          groups: [],
          permissions: peer.scopes,
        },
        channels: listChannelDescriptors(),
        agentAdapters: listAgentAdapterDescriptors().filter((adapter) => this.canUseAgent(peer, adapter.id)),
        enabledAgents: enabledAgents(this.config).filter((agentId) => this.canUseAgent(peer, agentId)),
        controls: this.scopedControlOptions(peer, await this.runtime.controlOptions(agentId)),
        status,
      };
    }
    if (method === "GET" && path === "/api/health") return this.runtime.status();
    if (method === "GET" && path === "/api/snapshot") return this.scopedSnapshot(peer, await this.runtime.snapshot());
    if (method === "GET" && path === "/api/version") return this.runtime.version();
    if (method === "POST" && path === "/api/update") return this.runtime.updateConnector(remoteActor);
    if (method === "GET" && path === "/api/agent-updates") {
      return { jobs: this.runtime.agentUpdateJobs().filter((job) => this.canUseAgent(peer, job.agentId)) };
    }
    if (method === "POST" && path === "/api/agent-update") {
      const agentId = parseRequiredAgentId(body.agentId);
      this.assertAgentScope(peer, agentId);
      return { job: this.runtime.startAgentUpdate(agentId, parseAgentUpdateOperation(stringValue(body.operation)), remoteActor) };
    }
    const agentUpdateLogMatch = path.match(/^\/api\/agent-update\/([^/]+)\/log$/);
    if (agentUpdateLogMatch?.[1] && method === "GET") {
      const id = decodeURIComponent(agentUpdateLogMatch[1]);
      this.assertAgentUpdateJobScope(peer, id);
      return this.runtime.agentUpdateLog(id);
    }
    if (agentUpdateLogMatch?.[1] && method === "DELETE") {
      const id = decodeURIComponent(agentUpdateLogMatch[1]);
      this.assertAgentUpdateJobScope(peer, id);
      return { deletedId: id, job: this.runtime.deleteAgentUpdateLog(id, remoteActor) };
    }
    const agentUpdateInputMatch = path.match(/^\/api\/agent-update\/([^/]+)\/input$/);
    if (agentUpdateInputMatch?.[1] && method === "POST") {
      const id = decodeURIComponent(agentUpdateInputMatch[1]);
      this.assertAgentUpdateJobScope(peer, id);
      return { job: this.runtime.sendAgentUpdateInput(id, requiredString(body.input, "input"), remoteActor) };
    }
    const agentUpdateCancelMatch = path.match(/^\/api\/agent-update\/([^/]+)\/cancel$/);
    if (agentUpdateCancelMatch?.[1] && method === "POST") {
      const id = decodeURIComponent(agentUpdateCancelMatch[1]);
      this.assertAgentUpdateJobScope(peer, id);
      return { job: this.runtime.cancelAgentUpdate(id, remoteActor) };
    }
    if (method === "GET" && path === "/api/tasks") return this.scopedTasks(peer, await this.runtime.tasks());
    if (method === "GET" && path === "/api/progress") return this.scopedTasks(peer, await this.runtime.tasks());
    if (method === "GET" && path === "/api/metrics") return this.runtime.metrics();
    if (method === "GET" && path === "/api/jobs") return this.scopedJobs(peer, await this.runtime.jobs());
    const jobLogMatch = path.match(/^\/api\/jobs\/([^/]+)\/log$/);
    if (jobLogMatch?.[1] && method === "GET") {
      const id = decodeURIComponent(jobLogMatch[1]);
      const data = await this.runtime.jobLog(id);
      if (data.job && !this.canUseJob(peer, data.job)) {
        throw new Error("Peer is not allowed to read this job.");
      }
      return data;
    }
    const jobActionMatch = path.match(/^\/api\/jobs\/([^/]+)\/action$/);
    if (jobActionMatch?.[1] && method === "POST") {
      const id = decodeURIComponent(jobActionMatch[1]);
      const action = requiredString(body.action, "action");
      if (action !== "cancel" && action !== "retry") {
        throw new Error("Unsupported job action.");
      }
      this.assertScope(peer, permissionForJobAction(id, action));
      return this.scopedJobs(peer, await this.runtime.jobAction(id, action, remoteActor));
    }
    if (method === "GET" && path === "/api/active-sessions") return this.scopedActiveSessions(peer, await this.runtime.activeSessions());
    if (method === "GET" && path === "/api/adapters/health") {
      return { adapters: (await this.runtime.adapterHealth()).filter((adapter) => this.canUseAgent(peer, adapter.id)) };
    }
    if (method === "GET" && path === "/api/diagnostics") return this.scopedDiagnostics(peer, await this.runtime.diagnostics());
    if (method === "GET" && path === "/api/diagnostics/bundle") {
      await this.assertCurrentSessionScope(peer);
      const bundle = await this.runtime.supportBundle(remoteActor);
      return {
        ...bundle,
        mimeType: "application/zip",
        dataBase64: readFileSync(bundle.path).toString("base64"),
      };
    }
    if (method === "GET" && path === "/api/control-options") {
      const agentId = parseAgentId(query.agent);
      this.assertAgentScope(peer, agentId);
      return this.scopedControlOptions(peer, await this.runtime.controlOptions(agentId));
    }
    if (method === "GET" && path === "/api/auth/status") {
      const agentId = parseAgentId(query.agent);
      this.assertAgentScope(peer, agentId);
      return this.runtime.authStatus(agentId);
    }
    if (method === "POST" && path === "/api/auth/login") {
      const agentId = parseAgentId(body.agentId);
      this.assertAgentScope(peer, agentId);
      return this.runtime.login(agentId, remoteActor);
    }
    if (method === "POST" && path === "/api/auth/logout") {
      const agentId = parseAgentId(body.agentId);
      this.assertAgentScope(peer, agentId);
      return this.runtime.logout(agentId, remoteActor);
    }
    if (method === "GET" && path === "/api/sessions") {
      const agentId = parseAgentId(query.agent);
      this.assertAgentScope(peer, agentId);
      return this.scopedSessionPage(peer, await this.runtime.listSessionsPage(numberValue(query.page, 1), numberValue(query.limit, 50), stringValue(query.query), agentId));
    }
    if (method === "GET" && path === "/api/sessions/detail") {
      const detail = await this.runtime.sessionDetail(requiredString(query.threadId, "threadId"));
      this.assertSessionDetailScope(peer, detail);
      return detail;
    }
    if (method === "POST" && path === "/api/agent") {
      const agentId = parseRequiredAgentId(body.agentId);
      this.assertAgentScope(peer, agentId);
      return { session: await this.runtime.setAgent(agentId, remoteActor) };
    }
    if (method === "POST" && path === "/api/sessions/new") {
      const agentId = parseAgentId(body.agentId);
      const workspace = stringValue(body.workspace) || undefined;
      this.assertAgentScope(peer, agentId);
      this.assertWorkspaceScope(peer, workspace);
      return {
        session: await this.runtime.newSession({
          agentId,
          workspace,
          model: stringValue(body.model) || undefined,
          reasoningEffort: stringValue(body.reasoningEffort) || undefined,
          launchProfileId: stringValue(body.launchProfileId) || undefined,
          fastMode: typeof body.fastMode === "boolean" ? body.fastMode : undefined,
        }, remoteActor),
      };
    }
    if (method === "POST" && path === "/api/sessions/switch") {
      const threadId = requiredString(body.threadId, "threadId");
      this.assertSessionDetailScope(peer, await this.runtime.sessionDetail(threadId));
      const session = await this.runtime.switchSession(threadId, remoteActor);
      this.assertSessionScope(peer, session);
      return { session };
    }
    if (method === "POST" && path === "/api/sessions/attach") {
      const threadId = requiredString(body.threadId, "threadId");
      this.assertSessionDetailScope(peer, await this.runtime.sessionDetail(threadId));
      const session = await this.runtime.attachSession(threadId, remoteActor);
      this.assertSessionScope(peer, session);
      return { session };
    }
    if (method === "GET" && path === "/api/models") {
      await this.assertCurrentSessionScope(peer);
      return { models: await this.runtime.listModels() };
    }
    if (method === "POST" && path === "/api/session/model") {
      await this.assertCurrentSessionScope(peer);
      return { session: await this.runtime.setModel(requiredString(body.model, "model"), remoteActor) };
    }
    if (method === "POST" && path === "/api/session/reasoning") {
      await this.assertCurrentSessionScope(peer);
      return { session: await this.runtime.setReasoningEffort(requiredString(body.reasoning, "reasoning"), remoteActor) };
    }
    if (method === "POST" && path === "/api/session/fast") {
      await this.assertCurrentSessionScope(peer);
      return { session: await this.runtime.setFastMode(Boolean(body.enabled), remoteActor) };
    }
    if (method === "POST" && path === "/api/session/launch") {
      await this.assertCurrentSessionScope(peer);
      return { session: await this.runtime.setLaunchProfile(requiredString(body.profileId, "profileId"), remoteActor) };
    }
    if (method === "POST" && path === "/api/prompt") {
      await this.assertCurrentSessionScope(peer);
      return this.runtime.sendPrompt(requiredString(body.text, "text"), remoteActor);
    }
    if (method === "POST" && path === "/api/prompt/upload") {
      await this.assertCurrentSessionScope(peer);
      const files = Array.isArray(body.files) ? body.files.map((file, index) => parseUploadFile(file, index)) : [];
      return this.runtime.sendUploadPrompt({ text: stringValue(body.text), files }, remoteActor);
    }
    if (method === "POST" && (path === "/api/abort" || path === "/api/stop")) {
      await this.assertCurrentSessionScope(peer);
      await this.runtime.abort(remoteActor);
      return { ok: true };
    }
    if (method === "POST" && path === "/api/handback") {
      await this.assertCurrentSessionScope(peer);
      return this.runtime.handback(remoteActor);
    }
    if (method === "POST" && path === "/api/retry") {
      await this.assertCurrentSessionScope(peer);
      return this.runtime.retry(remoteActor);
    }
    if (method === "POST" && path === "/api/sync") {
      await this.assertCurrentSessionScope(peer);
      return this.runtime.sync(remoteActor);
    }
    if (method === "GET" && path === "/api/queue") {
      await this.assertCurrentSessionScope(peer);
      return { queue: this.runtime.queue(), paused: this.runtime.queuePaused() };
    }
    if (method === "POST" && path === "/api/queue") {
      await this.assertCurrentSessionScope(peer);
      return { queue: this.runtime.queueAction(requiredString(body.action, "action") as never, stringValue(body.id) || undefined, remoteActor), paused: this.runtime.queuePaused() };
    }
    if (method === "GET" && path === "/api/chat/history") {
      await this.assertCurrentSessionScope(peer);
      return { messages: await this.runtime.chatHistory(numberValue(query.limit, 200)) };
    }
    if (method === "DELETE" && path === "/api/chat/history") {
      await this.assertCurrentSessionScope(peer);
      return this.runtime.clearChatHistory(remoteActor);
    }
    if (method === "GET" && path === "/api/activity") {
      return { events: this.runtime.activity({ limit: numberValue(query.limit, 100), source: stringValue(query.source) as never || "all", status: stringValue(query.status) as never || "all", category: stringValue(query.category) as never || "all", actor: stringValue(query.actor), agentId: stringValue(query.agentId), threadId: stringValue(query.threadId), workspace: stringValue(query.workspace), type: stringValue(query.type), since: stringValue(query.since) }).filter((event) => this.canUseSession(peer, event)) };
    }
    if (method === "GET" && path === "/api/artifacts") {
      await this.assertCurrentSessionScope(peer);
      return { reports: await this.runtime.artifacts() };
    }
    if (method === "GET" && path === "/api/artifacts/preview") {
      await this.assertCurrentSessionScope(peer);
      return this.runtime.artifactPreview(requiredString(query.turnId, "turnId"), requiredString(query.path, "path"));
    }
    if (method === "DELETE" && path === "/api/artifacts") {
      await this.assertCurrentSessionScope(peer);
      return { removed: await this.runtime.deleteArtifact(requiredString(query.turnId, "turnId"), remoteActor) };
    }
    if (method === "GET" && path === "/api/logs") return this.runtime.logs((stringValue(query.target) || "connector") as never, numberValue(query.lines, 100));
    if (method === "POST" && path === "/api/logs/clear") return this.runtime.clearLogs((stringValue(body.target) || "connector") as never, remoteActor);
    if (method === "POST" && path === "/api/runtime/restart") return this.runtime.restartConnector(remoteActor);

    throw new Error(`Remote endpoint is not implemented: ${method} ${path}`);
  }

  private assertScope(peer: PeerRecord, permission: Permission): void {
    if (!peer.scopes.includes(permission)) {
      throw new Error(`Peer permission denied: ${permission}`);
    }
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
    if (!workspace || peer.allowedWorkspaceRoots.length === 0) {
      return;
    }
    const normalized = workspace.replace(/\\/g, "/");
    const allowed = peer.allowedWorkspaceRoots.some((root) => {
      const normalizedRoot = root.replace(/\\/g, "/").replace(/\/+$/, "");
      return normalized === normalizedRoot || normalized.startsWith(`${normalizedRoot}/`);
    });
    if (!allowed) {
      throw new Error(`Peer is not allowed to use workspace: ${workspace}`);
    }
  }

  private async assertCurrentSessionScope(peer: PeerRecord): Promise<void> {
    const snapshot = await this.runtime.snapshot();
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
      workspaces: snapshot.workspaces.filter((workspace) => this.workspaceAllowed(peer, workspace)),
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
      workspaces: options.workspaces.filter((workspace) => this.workspaceAllowed(peer, workspace)),
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

  private scopedJobs(peer: PeerRecord, jobs: UnifiedJobsDto): UnifiedJobsDto {
    return {
      ...jobs,
      jobs: jobs.jobs.filter((job) => this.canUseJob(peer, job)),
    };
  }

  private canUseJob(peer: PeerRecord, job: UnifiedJobDto): boolean {
    return this.canUseSession(peer, job);
  }

  private assertAgentUpdateJobScope(peer: PeerRecord, id: string): void {
    const job = this.runtime.agentUpdateJobs().find((candidate) => candidate.id === id);
    if (job) {
      this.assertAgentScope(peer, job.agentId);
    }
  }

  private async scopeRelayEvent(peer: PeerRecord, event: RelayEvent): Promise<RelayEvent | null> {
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
        return await this.currentSessionAllowed(peer) ? event : null;
    }
  }

  private async currentSessionAllowed(peer: PeerRecord): Promise<boolean> {
    try {
      await this.assertCurrentSessionScope(peer);
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
}

export function peerError(error: unknown): string {
  return friendlyErrorText(error);
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

function normalizeMethod(value: unknown): string {
  const method = typeof value === "string" ? value.toUpperCase() : "GET";
  return ["GET", "POST", "PATCH", "PUT", "DELETE"].includes(method) ? method : "GET";
}

function normalizePath(value: unknown): string {
  const path = typeof value === "string" ? value.trim() : "";
  if (!path.startsWith("/api/")) {
    throw new Error("Only /api routes can be proxied.");
  }
  return path;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
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
  return "updates.run";
}
