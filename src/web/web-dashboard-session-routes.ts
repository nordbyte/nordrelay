import type { IncomingMessage, ServerResponse } from "node:http";

import { isAgentId, type AgentId } from "../agents/shared/agent.js";
import type { RelayRuntime, SessionPageDto } from "../runtime/relay-runtime.js";
import type { AuthenticatedUser } from "../access/user-management.js";
import type { WebActivityActor, WebActivityCategory } from "./web-state.js";
import {
  numberParam,
  optionalBooleanField,
  optionalStringField,
  parseUploadFiles,
  readJsonBody,
  requiredSearch,
  sendJson,
  stringField,
} from "./web-dashboard-http.js";

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
    options.assertScopedAgent(authUser, agentId);
    options.assertScopedWorkspace(authUser, workspace);
    sendJson(res, 200, {
      session: await runtime.newSession({
        agentId,
        workspace,
        model: optionalStringField(body, "model"),
        reasoningEffort: optionalStringField(body, "reasoningEffort"),
        launchProfileId: optionalStringField(body, "launchProfileId"),
        fastMode: optionalBooleanField(body, "fastMode"),
      }, options.activityActor),
    });
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
    const detail = await runtime.sessionDetail(threadId);
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
    sendJson(res, 200, { session: await runtime.setLaunchProfile(stringField(body, "profileId"), options.activityActor) });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/prompt") {
    const body = await readJsonBody(req);
    await options.assertCurrentSessionScope(authUser);
    sendJson(res, 202, await runtime.sendPrompt(stringField(body, "text"), options.activityActor));
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/prompt/upload") {
    const body = await readJsonBody(req);
    await options.assertCurrentSessionScope(authUser);
    sendJson(res, 202, await runtime.sendUploadPrompt({
      text: optionalStringField(body, "text"),
      files: parseUploadFiles(body.files),
    }, options.activityActor));
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
    sendJson(res, 200, {
      events: options.filterActivityByScope(authUser, runtime.activity({
        limit: numberParam(url, "limit", 100),
        source: (url.searchParams.get("source") || "all") as never,
        status: (url.searchParams.get("status") || "all") as never,
        category: (url.searchParams.get("category") || "all") as WebActivityCategory | "all",
        actor: url.searchParams.get("actor") || undefined,
        agentId: url.searchParams.get("agent") || "all",
        threadId: url.searchParams.get("thread") || undefined,
        workspace: url.searchParams.get("workspace") || undefined,
        type: url.searchParams.get("type") || undefined,
        since: url.searchParams.get("since") || undefined,
      })),
    });
    return true;
  }

  return false;
}
