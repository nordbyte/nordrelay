import type { IncomingMessage, ServerResponse } from "node:http";

import { isAgentId, type AgentApprovalChoice, type AgentId } from "../agents/shared/agent.js";
import type { RelayRuntime, SessionPageDto } from "../runtime/relay-runtime.js";
import type { QueuePlanInput } from "../runtime/relay-runtime-queue-planner.js";
import { SESSION_WORKSPACE_MODES, type SessionWorkspaceMode, type WorktreeConflictResolution } from "../worktrees/worktree-types.js";
import type { AuthenticatedUser } from "../access/user-management.js";
import type { WebActivityActor, WebActivityCategory } from "./web-state.js";
import { QUEUE_PLAN_STATUSES, type QueuePlanStatus } from "../state/queue-plan-store.js";
import {
  numberParam,
  objectRecord,
  optionalBooleanField,
  optionalStringField,
  parseUploadFiles,
  readJsonBody,
  requiredSearch,
  sendJson,
  stringField,
} from "./web-dashboard-http.js";
import { cursorPage, normalizeCursorLimit } from "../core/pagination.js";

export interface DashboardSessionRouteOptions {
  runtime: RelayRuntime;
  authUser: AuthenticatedUser;
  parseAgentId: (value: string | undefined) => AgentId | undefined;
  assertScopedAgent: (authUser: AuthenticatedUser, agentId?: AgentId) => void;
  assertScopedWorkspace: (authUser: AuthenticatedUser, workspace: string | undefined) => void;
  assertCurrentSessionScope: (authUser: AuthenticatedUser) => Promise<void>;
  assertSessionScope: (authUser: AuthenticatedUser, session: { agentId?: string; workspace?: string; cwd?: string } | Record<string, unknown>) => void;
  assertSessionDetailScope: (authUser: AuthenticatedUser, threadId: string, detail: Record<string, unknown>) => void;
  scopedSessionPage: (authUser: AuthenticatedUser, page: SessionPageDto) => SessionPageDto;
  filterActivityByScope: <T extends { agentId?: string; workspace?: string }>(authUser: AuthenticatedUser, events: T[]) => T[];
  activityActor: WebActivityActor;
}

export async function handleDashboardSessionRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  options: DashboardSessionRouteOptions,
): Promise<boolean> {
  const { runtime, authUser } = options;

  if (req.method === "GET" && url.pathname === "/api/locks") {
    await options.assertCurrentSessionScope(authUser);
    sendJson(res, 200, { locks: runtime.locks() });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/locks") {
    const body = await readJsonBody(req);
    await options.assertCurrentSessionScope(authUser);
    sendJson(res, 200, { lock: runtime.lockWebSession(optionalStringField(body, "ownerName"), options.activityActor), locks: runtime.locks() });
    return true;
  }

  if (req.method === "DELETE" && url.pathname === "/api/locks") {
    await options.assertCurrentSessionScope(authUser);
    sendJson(res, 200, runtime.unlockWebSession(options.activityActor));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/auth/status") {
    const agentId = options.parseAgentId(url.searchParams.get("agent") ?? undefined);
    options.assertScopedAgent(authUser, agentId);
    sendJson(res, 200, await runtime.authStatus(agentId));
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/login") {
    const body = await readJsonBody(req);
    const agentId = options.parseAgentId(optionalStringField(body, "agentId"));
    options.assertScopedAgent(authUser, agentId);
    sendJson(res, 200, await runtime.login(agentId, options.activityActor));
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/logout") {
    const body = await readJsonBody(req);
    const agentId = options.parseAgentId(optionalStringField(body, "agentId"));
    options.assertScopedAgent(authUser, agentId);
    sendJson(res, 200, await runtime.logout(agentId, options.activityActor));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/snapshot") {
    await options.assertCurrentSessionScope(authUser);
    sendJson(res, 200, await runtime.snapshot());
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/sessions") {
    const agentId = options.parseAgentId(url.searchParams.get("agent") ?? undefined);
    if (agentId) {
      options.assertScopedAgent(authUser, agentId);
    } else {
      await options.assertCurrentSessionScope(authUser);
    }
    const page = await runtime.listSessionsPage(
      numberParam(url, "page", 1),
      numberParam(url, "limit", 50),
      url.searchParams.get("query") ?? "",
      agentId,
    );
    sendJson(res, 200, options.scopedSessionPage(authUser, page));
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/agent") {
    const body = await readJsonBody(req);
    const agentId = stringField(body, "agentId");
    if (!isAgentId(agentId)) {
      throw new Error(`Invalid agent: ${agentId}`);
    }
    options.assertScopedAgent(authUser, agentId);
    sendJson(res, 200, { session: await runtime.setAgent(agentId, options.activityActor) });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/sessions/new") {
    const body = await readJsonBody(req);
    const agentId = options.parseAgentId(optionalStringField(body, "agentId"));
    const workspace = optionalStringField(body, "workspace");
    const workspaceMode = parseWorkspaceMode(optionalStringField(body, "workspaceMode"));
    options.assertScopedAgent(authUser, agentId);
    options.assertScopedWorkspace(authUser, workspace);
    sendJson(res, 200, {
      session: await runtime.newSession({
        agentId,
        workspace,
        workspaceMode,
        model: optionalStringField(body, "model"),
        reasoningEffort: optionalStringField(body, "reasoningEffort"),
        launchProfileId: optionalStringField(body, "launchProfileId"),
        fastMode: optionalBooleanField(body, "fastMode"),
      }, options.activityActor),
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/sessions/worktrees") {
    await options.assertCurrentSessionScope(authUser);
    sendJson(res, 200, await runtime.sessionWorktrees());
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/sessions/worktrees/fork") {
    const body = await readJsonBody(req);
    await options.assertCurrentSessionScope(authUser);
    sendJson(res, 200, await runtime.forkCurrentSessionToWorktree({
      includeUncommitted: optionalBooleanField(body, "includeUncommitted"),
    }, options.activityActor));
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/sessions/worktrees/integrate") {
    const body = await readJsonBody(req);
    const ids = Array.isArray(body?.ids) ? body.ids.map(String).filter(Boolean) : [];
    await options.assertCurrentSessionScope(authUser);
    sendJson(res, 200, { run: await runtime.integrateSessionWorktrees(ids, { resolutions: parseWorktreeResolutions(body?.resolutions) }, options.activityActor) });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/sessions/worktrees/integrate/preview") {
    const body = await readJsonBody(req);
    const ids = Array.isArray(body?.ids) ? body.ids.map(String).filter(Boolean) : [];
    await options.assertCurrentSessionScope(authUser);
    sendJson(res, 200, await runtime.previewSessionWorktreeIntegration(ids));
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/sessions/worktrees/integrate/patch") {
    const body = await readJsonBody(req);
    const ids = Array.isArray(body?.ids) ? body.ids.map(String).filter(Boolean) : [];
    await options.assertCurrentSessionScope(authUser);
    sendJson(res, 200, await runtime.exportSessionWorktreeIntegrationPatch(ids));
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/sessions/worktrees/cleanup") {
    await options.assertCurrentSessionScope(authUser);
    sendJson(res, 200, await runtime.cleanupSessionWorktrees(options.activityActor));
    return true;
  }

  const worktreeFinalizeMatch = url.pathname.match(/^\/api\/sessions\/worktrees\/integrations\/([^/]+)\/finalize$/);
  if (req.method === "POST" && worktreeFinalizeMatch) {
    const body = await readJsonBody(req);
    await options.assertCurrentSessionScope(authUser);
    sendJson(res, 200, await runtime.finalizeSessionWorktreeIntegration(decodeURIComponent(worktreeFinalizeMatch[1]!), {
      targetBranch: optionalStringField(body, "targetBranch"),
      removeIntegrationWorktree: optionalBooleanField(body, "removeIntegrationWorktree"),
      removeSourceWorktrees: optionalBooleanField(body, "removeSourceWorktrees"),
      deleteIntegrationBranch: optionalBooleanField(body, "deleteIntegrationBranch"),
    }, options.activityActor));
    return true;
  }

  const worktreeDiffMatch = url.pathname.match(/^\/api\/sessions\/worktrees\/([^/]+)\/diff$/);
  if (req.method === "GET" && worktreeDiffMatch) {
    await options.assertCurrentSessionScope(authUser);
    sendJson(res, 200, await runtime.sessionWorktreeDiff(decodeURIComponent(worktreeDiffMatch[1]!)));
    return true;
  }

  const worktreeUpdateMatch = url.pathname.match(/^\/api\/sessions\/worktrees\/([^/]+)\/update$/);
  if (req.method === "POST" && worktreeUpdateMatch) {
    await options.assertCurrentSessionScope(authUser);
    sendJson(res, 200, await runtime.updateSessionWorktreeFromBase(decodeURIComponent(worktreeUpdateMatch[1]!), options.activityActor));
    return true;
  }

  const worktreeCommitMatch = url.pathname.match(/^\/api\/sessions\/worktrees\/([^/]+)\/commit$/);
  if (req.method === "POST" && worktreeCommitMatch) {
    const body = await readJsonBody(req);
    await options.assertCurrentSessionScope(authUser);
    sendJson(res, 200, await runtime.commitSessionWorktree(decodeURIComponent(worktreeCommitMatch[1]!), optionalStringField(body, "message"), options.activityActor));
    return true;
  }

  const worktreeMatch = url.pathname.match(/^\/api\/sessions\/worktrees\/([^/]+)$/);
  if (req.method === "DELETE" && worktreeMatch) {
    const body = await readJsonBody(req).catch(() => ({}));
    await options.assertCurrentSessionScope(authUser);
    sendJson(res, 200, { record: await runtime.removeSessionWorktree(decodeURIComponent(worktreeMatch[1]!), optionalBooleanField(body, "force") ?? false, options.activityActor) });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/sessions/switch") {
    const body = await readJsonBody(req);
    const threadId = stringField(body, "threadId");
    const detail = await runtime.sessionDetail(threadId);
    if (detail.record && typeof detail.record === "object") {
      options.assertSessionScope(authUser, detail.record as Record<string, unknown>);
    }
    const session = await runtime.switchSession(threadId, options.activityActor);
    options.assertSessionScope(authUser, session);
    sendJson(res, 200, { session });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/sessions/attach") {
    const body = await readJsonBody(req);
    const session = await runtime.attachSession(stringField(body, "threadId"), options.activityActor);
    options.assertSessionScope(authUser, session);
    sendJson(res, 200, { session });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/sessions/detail") {
    const threadId = requiredSearch(url, "threadId");
    const agentId = options.parseAgentId(url.searchParams.get("agent") ?? undefined);
    if (agentId) {
      options.assertScopedAgent(authUser, agentId);
    }
    const detail = await runtime.sessionDetail(threadId, agentId);
    options.assertSessionDetailScope(authUser, threadId, detail);
    sendJson(res, 200, detail);
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/models") {
    await options.assertCurrentSessionScope(authUser);
    sendJson(res, 200, { models: await runtime.listModels() });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/session/model") {
    const body = await readJsonBody(req);
    await options.assertCurrentSessionScope(authUser);
    sendJson(res, 200, { session: await runtime.setModel(stringField(body, "model"), options.activityActor) });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/session/reasoning") {
    const body = await readJsonBody(req);
    await options.assertCurrentSessionScope(authUser);
    sendJson(res, 200, { session: await runtime.setReasoningEffort(stringField(body, "reasoning"), options.activityActor) });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/session/fast") {
    const body = await readJsonBody(req);
    await options.assertCurrentSessionScope(authUser);
    sendJson(res, 200, { session: await runtime.setFastMode(Boolean(body?.enabled), options.activityActor) });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/session/launch") {
    const body = await readJsonBody(req);
    await options.assertCurrentSessionScope(authUser);
    sendJson(res, 200, {
      session: await runtime.setLaunchProfile(stringField(body, "profileId"), options.activityActor, { applyToCurrent: Boolean(body?.apply) }),
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/prompt") {
    const body = await readJsonBody(req);
    await options.assertCurrentSessionScope(authUser);
    sendJson(res, 202, await runtime.sendPrompt(stringField(body, "text"), options.activityActor, optionalStringField(body, "correlationId")));
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/prompt/upload") {
    const body = await readJsonBody(req);
    await options.assertCurrentSessionScope(authUser);
    sendJson(res, 202, await runtime.sendUploadPrompt({
      text: optionalStringField(body, "text"),
      correlationId: optionalStringField(body, "correlationId"),
      transcribeOnly: optionalBooleanField(body, "transcribeOnly") ?? false,
      files: parseUploadFiles(body.files),
    }, options.activityActor));
    return true;
  }

  const approvalRespondMatch = url.pathname.match(/^\/api\/approvals\/([^/]+)\/respond$/);
  if (req.method === "POST" && approvalRespondMatch?.[1]) {
    await options.assertCurrentSessionScope(authUser);
    const body = await readJsonBody(req);
    const choice = parseApprovalChoice(stringField(body, "choice"));
    sendJson(res, 200, await runtime.respondExternalApproval(decodeURIComponent(approvalRespondMatch[1]), choice, options.activityActor));
    return true;
  }

  if (req.method === "POST" && (url.pathname === "/api/abort" || url.pathname === "/api/stop")) {
    await options.assertCurrentSessionScope(authUser);
    await runtime.abort(options.activityActor);
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/handback") {
    await options.assertCurrentSessionScope(authUser);
    sendJson(res, 200, await runtime.handback(options.activityActor));
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/retry") {
    await options.assertCurrentSessionScope(authUser);
    sendJson(res, 202, await runtime.retry(options.activityActor));
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/sync") {
    await options.assertCurrentSessionScope(authUser);
    sendJson(res, 200, await runtime.sync(options.activityActor));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/queue/plans") {
    await options.assertCurrentSessionScope(authUser);
    sendJson(res, 200, runtime.queuePlanner());
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/queue/plans") {
    const body = await readJsonBody(req);
    const input = parseQueuePlanBody(body, options);
    options.assertScopedAgent(authUser, input.agentId);
    options.assertScopedWorkspace(authUser, input.workspace);
    await options.assertCurrentSessionScope(authUser);
    const plan = await runtime.createQueuePlan(input, options.activityActor);
    sendJson(res, 201, { plan, snapshot: runtime.queuePlanner() });
    return true;
  }

  const queuePlanMatch = url.pathname.match(/^\/api\/queue\/plans\/([^/]+)(?:\/(move|approve|enqueue))?$/);
  if (queuePlanMatch?.[1]) {
    const id = decodeURIComponent(queuePlanMatch[1]);
    const action = queuePlanMatch[2];
    await options.assertCurrentSessionScope(authUser);
    if (req.method === "PATCH" && !action) {
      const body = await readJsonBody(req);
      const input = parseQueuePlanPatchBody(body, options);
      options.assertScopedAgent(authUser, input.agentId);
      options.assertScopedWorkspace(authUser, input.workspace);
      const plan = runtime.updateQueuePlan(id, input, options.activityActor);
      sendJson(res, 200, { plan, snapshot: runtime.queuePlanner() });
      return true;
    }
    if (req.method === "DELETE" && !action) {
      sendJson(res, 200, runtime.deleteQueuePlan(id, options.activityActor));
      return true;
    }
    if (req.method === "POST" && action === "move") {
      const body = await readJsonBody(req);
      const plan = await runtime.moveQueuePlan(id, parseQueuePlanStatus(stringField(body, "status")), options.activityActor);
      sendJson(res, 200, { plan, snapshot: runtime.queuePlanner() });
      return true;
    }
    if (req.method === "POST" && action === "approve") {
      const plan = runtime.approveQueuePlan(id, options.activityActor);
      sendJson(res, 200, { plan, snapshot: runtime.queuePlanner() });
      return true;
    }
    if (req.method === "POST" && action === "enqueue") {
      const plan = await runtime.enqueueQueuePlan(id, options.activityActor);
      sendJson(res, 202, { plan, snapshot: runtime.queuePlanner() });
      return true;
    }
  }

  if (req.method === "GET" && url.pathname === "/api/queue") {
    await options.assertCurrentSessionScope(authUser);
    sendJson(res, 200, { queue: runtime.queue(), paused: runtime.queuePaused() });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/queue") {
    const body = await readJsonBody(req);
    await options.assertCurrentSessionScope(authUser);
    sendJson(res, 200, { queue: runtime.queueAction(stringField(body, "action") as never, optionalStringField(body, "id"), options.activityActor), paused: runtime.queuePaused() });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/chat/history") {
    await options.assertCurrentSessionScope(authUser);
    sendJson(res, 200, { messages: await runtime.chatHistory(numberParam(url, "limit", 200)) });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/chat/mirror") {
    await options.assertCurrentSessionScope(authUser);
    sendJson(res, 200, await runtime.webMirrorPreference(""));
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/chat/mirror") {
    const body = await readJsonBody(req);
    await options.assertCurrentSessionScope(authUser);
    sendJson(res, 200, await runtime.webMirrorPreference(optionalStringField(body, "argument") ?? optionalStringField(body, "mode") ?? "", options.activityActor));
    return true;
  }

  if (req.method === "DELETE" && url.pathname === "/api/chat/history") {
    await options.assertCurrentSessionScope(authUser);
    sendJson(res, 200, await runtime.clearChatHistory(options.activityActor));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/activity") {
    const limit = normalizeCursorLimit(numberParam(url, "limit", 100), 100, 500);
    const scoped = options.filterActivityByScope(authUser, runtime.activity({
      limit: 500,
      source: (url.searchParams.get("source") || "all") as never,
      status: (url.searchParams.get("status") || "all") as never,
      category: (url.searchParams.get("category") || "all") as WebActivityCategory | "all",
      actor: url.searchParams.get("actor") || undefined,
      agentId: url.searchParams.get("agent") || "all",
      threadId: url.searchParams.get("thread") || undefined,
      workspace: url.searchParams.get("workspace") || undefined,
      type: url.searchParams.get("type") || undefined,
      since: url.searchParams.get("since") || undefined,
    }));
    const scopedPage = cursorPage(scoped, url.searchParams.get("cursor") || undefined, limit, (event) => event.id);
    sendJson(res, 200, {
      events: scopedPage.items,
      pagination: scopedPage.pagination,
    });
    return true;
  }

  return false;
}

function parseApprovalChoice(value: string): AgentApprovalChoice {
  if (value === "yes" || value === "persist" || value === "no") {
    return value;
  }
  throw new Error(`Invalid approval choice: ${value}`);
}

function parseWorkspaceMode(value: string | undefined): SessionWorkspaceMode | undefined {
  if (!value) {
    return undefined;
  }
  if (SESSION_WORKSPACE_MODES.includes(value as SessionWorkspaceMode)) {
    return value as SessionWorkspaceMode;
  }
  throw new Error(`Invalid workspace mode: ${value}`);
}

function parseQueuePlanBody(body: unknown, options: DashboardSessionRouteOptions): QueuePlanInput {
  const record = objectRecord(body);
  const prompt = stringField(record, "prompt").trim();
  if (!prompt) throw new Error("Prompt is empty.");
  return {
    title: optionalStringField(record, "title"),
    prompt,
    status: record.status ? parseQueuePlanStatus(String(record.status)) : undefined,
    labels: stringList(record.labels),
    priority: numberValue(record.priority),
    agentId: options.parseAgentId(optionalStringField(record, "agentId")),
    workspace: optionalStringField(record, "workspace"),
    threadId: optionalStringField(record, "threadId"),
  };
}

function parseQueuePlanPatchBody(body: unknown, options: DashboardSessionRouteOptions): Partial<QueuePlanInput> {
  const record = objectRecord(body);
  const prompt = optionalStringField(record, "prompt");
  if (prompt !== undefined && !prompt.trim()) throw new Error("Prompt is empty.");
  const patch = {
    title: optionalStringField(record, "title"),
    prompt: prompt?.trim(),
    status: record.status ? parseQueuePlanStatus(String(record.status)) : undefined,
    labels: record.labels === undefined ? undefined : stringList(record.labels),
    priority: record.priority === undefined ? undefined : numberValue(record.priority),
    agentId: record.agentId === undefined ? undefined : options.parseAgentId(optionalStringField(record, "agentId")),
    workspace: optionalStringField(record, "workspace"),
    threadId: optionalStringField(record, "threadId"),
  };
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as Partial<QueuePlanInput>;
}

function parseQueuePlanStatus(value: string): QueuePlanStatus {
  if (!QUEUE_PLAN_STATUSES.includes(value as QueuePlanStatus)) {
    throw new Error("Unsupported queue plan status.");
  }
  return value as QueuePlanStatus;
}

function parseWorktreeResolutions(value: unknown): WorktreeConflictResolution[] {
  if (!Array.isArray(value)) return [];
  return value.map((item): WorktreeConflictResolution | null => {
    const record = objectRecord(item);
    const path = optionalStringField(record, "path");
    const choice = optionalStringField(record, "choice") ?? "auto";
    if (!path || !["auto", "ours", "theirs", "both", "manual"].includes(choice)) return null;
    return {
      path,
      choice: choice as WorktreeConflictResolution["choice"],
      sourceWorktreeId: optionalStringField(record, "sourceWorktreeId"),
      content: optionalStringField(record, "content"),
    };
  }).filter((item): item is WorktreeConflictResolution => Boolean(item));
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

function numberValue(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}
