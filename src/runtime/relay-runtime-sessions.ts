import { randomUUID } from "node:crypto";

import { ensureOutDir, type ArtifactTurnReport } from "../artifacts/artifacts.js";
import {
  buildFileInstructions,
  outboxPath,
  stageFile,
  type StagedFile,
} from "../artifacts/attachments.js";
import {
  CODEX_AGENT_CAPABILITIES,
  agentLabel,
  agentReasoningLabel,
  agentReasoningOptions,
  isAgentId,
  type AgentCapabilities,
  type AgentId,
  type AgentPromptObject,
  type AgentSessionInfo,
  type AgentSessionService,
  type AgentThreadRecord,
} from "../agents/shared/agent.js";
import { getExternalSnapshotForSession } from "../agents/shared/agent-activity.js";
import { listAgentAdapterDescriptors } from "../agents/shared/agent-adapter.js";
import { AgentUpdateManager, type AgentUpdateJobSnapshot, type AgentUpdateOperation } from "../agents/shared/agent-updates.js";
import { createAgentSessionService, enabledAgents } from "../agents/shared/agent-factory.js";
import { AuditLogStore, type AuditEvent, type AuditListOptions } from "../access/audit-log.js";
import { BotPreferencesStore } from "../state/bot-preferences.js";
import { ChannelCommandService } from "../channels/shared/channel-command-service.js";
import { ChannelTurnService } from "../channels/shared/channel-turn-service.js";
import { activeSessionSourceForContextKey, ChannelMirrorRegistry } from "../channels/shared/channel-mirror-registry.js";
import type { LoginResult } from "../agents/codex/codex-auth.js";
import { listThreads as listCodexThreads } from "../agents/codex/codex-state.js";
import type { ConnectorConfig } from "../core/config.js";
import type { ChannelContextKey } from "../channels/shared/context-key.js";
import { friendlyErrorText } from "../core/error-messages.js";
import { clearLogFile, getAgentUpdateLogPath, getConnectorHealth, getConnectorLogPath, getPackageVersion, getUpdateLogPath, getVersionChecks, readConnectorState, readFormattedLogTail, spawnConnectorRestart, spawnSelfUpdate } from "../support/operations.js";
import { PromptStore, toPromptEnvelope, type PromptEnvelope } from "../state/prompt-store.js";
import { UnifiedJobStore } from "../state/job-store.js";
import { buildRuntimeMetrics, type RuntimeMetricsDto } from "./metrics.js";
import { RelayArtifactService } from "./relay-artifact-service.js";
import { RelayAuthService } from "./relay-auth-service.js";
import { RelayExternalActivityMonitor } from "./relay-external-activity-monitor.js";
import { RelayQueueService, type RelayQueueAction } from "./relay-queue-service.js";
import { RuntimeSnapshotCache } from "./runtime-cache.js";
import {
  activeSessionPriority,
  activityToUnifiedJob,
  agentUpdateStatusToUnified,
  dedupeJobs,
  hostLoginCommand,
  hostLogoutCommand,
  isPromptTerminalActivity,
  normalizeMimeType,
  promptActivityToUnifiedJob,
  shouldRefreshActiveSessions,
  taskToUnifiedJob,
  uploadFileDtos,
} from "./relay-runtime-helpers.js";
import { RelayDashboardService } from "./relay-dashboard-service.js";
import { capabilitiesOf } from "../channels/shared/bot-rendering.js";
import { renderSessionInfoPlain, renderSessionUsageRows } from "../channels/shared/session-format.js";
import { SessionLockStore, type SessionLock } from "../access/session-locks.js";
import { SessionRegistry, type ContextMetadata } from "../state/session-registry.js";
import { createSupportBundle, type SupportBundleResult } from "../support/support-bundle.js";
import { transcribeAudio, type TranscriptionBackend } from "../artifacts/voice.js";
import {
  WebActivityStore,
  WebChatStore,
  type WebActivityActor,
  type WebActivityCategory,
  type WebActivityEvent,
  type WebActivitySource,
  type WebActivityStatus,
  type WebChatMessage,
} from "../web/web-state.js";
import type {
  ActiveSessionDto,
  ActiveSessionsDto,
  ArtifactPreviewDto,
  ArtifactReportDto,
  CursorPageDto,
  DashboardControlOptions,
  QueueItemDto,
  RelayEvent,
  RelaySnapshot,
  SessionPageDto,
  UnifiedJobDto,
  UnifiedJobsDto,
  UploadPromptFile,
  UploadPromptResult,
  WebAdapterHealthDto,
  WebAuthDto,
  WebDiagnosticsDto,
  WebPermissionsDto,
  WebTaskDto,
  WebTasksDto,
} from "./relay-runtime-types.js";
export type { RuntimeMetricsDto } from "./metrics.js";
import { evaluateWorkspacePolicy, filterAllowedWorkspaces } from "../core/workspace-policy.js";
import type { RelayRuntimeDelegate } from "./relay-runtime-delegate.js";
export type {
  ActiveSessionDto,
  ActiveSessionsDto,
  ArtifactPreviewDto,
  ArtifactReportDto,
  DashboardControlOptions,
  ExternalMirrorState,
  QueueItemDto,
  RelayEvent,
  RelaySnapshot,
  SessionPageDto,
  UnifiedJobDto,
  UnifiedJobsDto,
  UploadPromptFile,
  UploadPromptResult,
  WebAdapterHealthDto,
  WebAuthDto,
  WebDiagnosticsDto,
  WebPermissionsDto,
  WebTaskDto,
  WebTasksDto,
} from "./relay-runtime-types.js";

export const WEB_CONTEXT_KEY = "web:dashboard";
const ACTIVE_CODEX_DISCOVERY_LIMIT = 200;
const ACTIVE_ACTIVITY_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_WEB_SESSION_PAGE_SIZE = 50;
const MAX_CHAT_HISTORY = 250;

export function relayRuntimeLocks(runtime: RelayRuntimeDelegate): SessionLock[] {
    return runtime.lockStore.list();
  }

export function relayRuntimeLockWebSession(runtime: RelayRuntimeDelegate, ownerName = "Web dashboard", actor?: WebActivityActor): SessionLock {
    const label = ownerName || actor?.label || "Web dashboard";
    const lock = runtime.lockStore.set(runtime.contextKey, {
      userId: actor?.id ?? "web",
      label,
      channel: "web",
    }, runtime.config.sessionLockTtlMs);
    runtime.appendActivity({
      source: "web",
      status: "info",
      type: "lock_created",
      threadId: null,
      workspace: runtime.config.workspace,
      actor,
      detail: `locked by ${label}`,
    });
    runtime.appendAudit({
      action: "lock_updated",
      status: "ok",
      contextKey: runtime.contextKey,
      actor,
      description: "lock",
      detail: `locked by ${label}`,
    });
    return lock;
  }

export function relayRuntimeUnlockWebSession(runtime: RelayRuntimeDelegate, actor?: WebActivityActor): { removed: boolean; locks: SessionLock[] } {
    const removed = runtime.lockStore.clear(runtime.contextKey);
    runtime.appendActivity({
      source: "web",
      status: "info",
      type: "lock_removed",
      threadId: null,
      workspace: runtime.config.workspace,
      actor,
      detail: removed ? "unlocked" : "no lock",
    });
    runtime.appendAudit({
      action: "lock_updated",
      status: "ok",
      contextKey: runtime.contextKey,
      actor,
      description: "unlock",
      detail: removed ? "unlocked" : "no lock",
    });
    return { removed, locks: runtime.locks() };
  }

export async function relayRuntimeControlOptions(runtime: RelayRuntimeDelegate, agentId?: AgentId): Promise<DashboardControlOptions> {
    const { session, dispose } = await runtime.getControlSession(agentId);
    try {
      const info = runtime.publicInfo(session);
      const capabilities = info.capabilities ?? CODEX_AGENT_CAPABILITIES;
      if (capabilities.modelSelection) {
        await session.refreshModels().catch((error: unknown) => {
          console.warn(
            `Failed to refresh ${agentLabel(info.agentId)} models: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      }
      return {
        models: capabilities.modelSelection ? session.listModels() : [],
        reasoningLabel: agentReasoningLabel(info.agentId),
        reasoningOptions: agentReasoningOptions(info.agentId),
        launchProfiles: capabilities.launchProfiles ? session.listLaunchProfiles() : [],
        workspaces: filterAllowedWorkspaces(session.listWorkspaces(), runtime.config),
        capabilities,
      };
    } finally {
      if (dispose) {
        session.dispose();
      }
    }
  }

export async function relayRuntimeAuthStatus(runtime: RelayRuntimeDelegate, agentId?: AgentId): Promise<WebAuthDto> {
    const { session, dispose } = await runtime.getControlSession(agentId);
    try {
      const info = runtime.publicInfo(session);
      const capabilities = info.capabilities ?? CODEX_AGENT_CAPABILITIES;
      if (!capabilities.auth) {
        return {
          agentId: info.agentId,
          agentLabel: info.agentLabel,
          supported: false,
          authenticated: null,
          detail: `${info.agentLabel} authentication is managed outside NordRelay.`,
          loginSupported: false,
          logoutSupported: false,
          hostLoginCommand: hostLoginCommand(info, runtime.config),
          hostLogoutCommand: hostLogoutCommand(info, runtime.config),
        };
      }
      const status = await runtime.authService.check(info);
      return {
        agentId: info.agentId,
        agentLabel: info.agentLabel,
        supported: true,
        authenticated: status.authenticated,
        method: status.method,
        detail: status.detail,
        loginSupported: capabilities.login,
        logoutSupported: capabilities.logout,
        hostLoginCommand: hostLoginCommand(info, runtime.config),
        hostLogoutCommand: hostLogoutCommand(info, runtime.config),
      };
    } finally {
      if (dispose) {
        session.dispose();
      }
    }
  }

export async function relayRuntimeLogin(runtime: RelayRuntimeDelegate, agentId?: AgentId, actor?: WebActivityActor): Promise<WebAuthDto & { result: LoginResult | null }> {
    const { session, dispose } = await runtime.getControlSession(agentId);
    try {
      const info = runtime.publicInfo(session);
      const capabilities = info.capabilities ?? CODEX_AGENT_CAPABILITIES;
      if (!capabilities.login) {
        return {
          ...(await runtime.authStatus(info.agentId)),
          result: {
            success: false,
            message: `${info.agentLabel} login is not managed by NordRelay. Run ${hostLoginCommand(info, runtime.config)} on the host.`,
          },
        };
      }
      if (!runtime.config.enableTelegramLogin) {
        return {
          ...(await runtime.authStatus(info.agentId)),
          result: {
            success: false,
            message: `Remote login is disabled. Run ${hostLoginCommand(info, runtime.config)} on the host.`,
          },
        };
      }
      const result = await runtime.authService.startLogin(info);
      runtime.appendActivity({
        source: "web",
        status: result.success ? "info" : "failed",
        type: result.success ? "login_started" : "login_failed",
        threadId: info.threadId,
        workspace: info.workspace,
        agentId: info.agentId,
        actor,
        detail: result.message,
      });
      runtime.appendAudit({
        action: "command",
        status: result.success ? "ok" : "failed",
        contextKey: runtime.contextKey,
        agentId: info.agentId,
        threadId: info.threadId,
        workspace: info.workspace,
        actor,
        description: "login",
        detail: result.message,
      });
      return { ...(await runtime.authStatus(info.agentId)), result };
    } finally {
      if (dispose) {
        session.dispose();
      }
    }
  }

export async function relayRuntimeLogout(runtime: RelayRuntimeDelegate, agentId?: AgentId, actor?: WebActivityActor): Promise<WebAuthDto & { result: LoginResult | null }> {
    const { session, dispose } = await runtime.getControlSession(agentId);
    try {
      const info = runtime.publicInfo(session);
      const capabilities = info.capabilities ?? CODEX_AGENT_CAPABILITIES;
      if (!capabilities.logout) {
        return {
          ...(await runtime.authStatus(info.agentId)),
          result: {
            success: false,
            message: `${info.agentLabel} logout is not managed by NordRelay. Run ${hostLogoutCommand(info, runtime.config)} on the host.`,
          },
        };
      }
      if (!runtime.config.enableTelegramLogin) {
        return {
          ...(await runtime.authStatus(info.agentId)),
          result: {
            success: false,
            message: `Remote auth management is disabled. Run ${hostLogoutCommand(info, runtime.config)} on the host.`,
          },
        };
      }
      const current = await runtime.authService.check(info);
      if (current.method === "api-key") {
        return {
          ...(await runtime.authStatus(info.agentId)),
          result: {
            success: false,
            message: "Cannot logout while API-key authentication is configured. Remove the API key from .env to use CLI auth.",
          },
        };
      }
      const result = await runtime.authService.startLogout(info);
      runtime.appendActivity({
        source: "web",
        status: result.success ? "info" : "failed",
        type: result.success ? "logout_completed" : "logout_failed",
        threadId: info.threadId,
        workspace: info.workspace,
        agentId: info.agentId,
        actor,
        detail: result.message,
      });
      runtime.appendAudit({
        action: "command",
        status: result.success ? "ok" : "failed",
        contextKey: runtime.contextKey,
        agentId: info.agentId,
        threadId: info.threadId,
        workspace: info.workspace,
        actor,
        description: "logout",
        detail: result.message,
      });
      return { ...(await runtime.authStatus(info.agentId)), result };
    } finally {
      if (dispose) {
        session.dispose();
      }
    }
  }

export async function relayRuntimeChatHistory(runtime: RelayRuntimeDelegate, limit = 200): Promise<WebChatMessage[]> {
    const session = await runtime.getSession(true);
    return runtime.chatStore.list(runtime.publicInfo(session).threadId, limit);
  }

export async function relayRuntimeWebMirrorPreference(runtime: RelayRuntimeDelegate, argument = "", actor?: WebActivityActor): Promise<{
    mode: string;
    minInterval: number;
    response: { plain: string; html: string };
  }> {
    const session = await runtime.getSession(true);
    runtime.registry.updateMetadata(runtime.contextKey, session);
    const info = runtime.publicInfo(session);
    const response = new ChannelCommandService(runtime.config).renderMirrorPreference({
      source: "web",
      contextKey: runtime.contextKey,
      argument,
      preferencesStore: runtime.preferencesStore,
      cliMirrorSupported: capabilitiesOf(info).cliMirror,
      agentLabel: info.agentLabel,
    });
    const mode = runtime.preferencesStore.get(runtime.contextKey).mirrorMode ?? runtime.config.webMirrorMode;
    const changed = argument.trim() && response.plain.startsWith("CLI mirroring:");
    if (changed) {
      runtime.appendActivity({
        source: "web",
        status: "info",
        type: "mirror_mode_changed",
        threadId: info.threadId,
        workspace: info.workspace,
        agentId: info.agentId,
        actor,
        detail: mode,
      });
      runtime.appendAudit({
        action: "command",
        status: "ok",
        contextKey: runtime.contextKey,
        agentId: info.agentId,
        threadId: info.threadId,
        workspace: info.workspace,
        actor,
        description: `mirror ${mode}`,
      });
      runtime.externalActivityMonitor.reset();
      void runtime.externalActivityMonitor.monitorSafe();
    }
    return {
      mode,
      minInterval: runtime.config.webMirrorMinUpdateMs,
      response,
    };
  }

export async function relayRuntimeSessionDetail(runtime: RelayRuntimeDelegate, threadId: string): Promise<Record<string, unknown>> {
    const session = await runtime.getSession(true);
    const record = session.getSessionRecord(threadId);
    const active = runtime.publicInfo(session, { includeUsage: true });
    return {
      record,
      active,
      usageRows: active.threadId === threadId ? renderSessionUsageRows(active) : [],
      messages: runtime.chatStore.list(threadId, 100),
      activity: runtime.activity({ limit: 100 }).filter((event) => event.threadId === threadId),
    };
  }

export async function relayRuntimeClearChatHistory(runtime: RelayRuntimeDelegate, actor?: WebActivityActor): Promise<{ removed: number; messages: WebChatMessage[] }> {
    const session = await runtime.getSession(true);
    const info = runtime.publicInfo(session);
    const removed = runtime.chatStore.clear(info.threadId);
    const messages = await runtime.chatHistory();
    runtime.broadcast({ type: "chat_history", messages });
    runtime.appendActivity({
      source: "web",
      status: "info",
      type: "chat_history_cleared",
      threadId: info.threadId,
      workspace: info.workspace,
      agentId: info.agentId,
      actor,
      detail: `${removed} messages removed.`,
    });
    return { removed, messages };
  }

export function relayRuntimeActivity(runtime: RelayRuntimeDelegate, options: {
    limit?: number;
    source?: WebActivitySource | "all";
    status?: WebActivityStatus | "all";
    category?: WebActivityCategory | "all";
    actor?: string;
    agentId?: AgentId | "all" | string;
    threadId?: string;
    workspace?: string;
    type?: string;
    since?: string | number;
  } = {}): WebActivityEvent[] {
    const currentInfo = runtime.registry.get(runtime.contextKey)?.getInfo();
    return runtime.activityStore.list(options).map((event: WebActivityEvent) => runtime.enrichActivityEvent(event, currentInfo));
  }

export function relayRuntimeActivityPage(runtime: RelayRuntimeDelegate, options: {
    limit?: number;
    cursor?: string;
    source?: WebActivitySource | "all";
    status?: WebActivityStatus | "all";
    category?: WebActivityCategory | "all";
    actor?: string;
    agentId?: AgentId | "all" | string;
    threadId?: string;
    workspace?: string;
    type?: string;
    since?: string | number;
  } = {}): CursorPageDto<WebActivityEvent> {
    const currentInfo = runtime.registry.get(runtime.contextKey)?.getInfo();
    const page = runtime.activityStore.listPage(options);
    return {
      ...page,
      items: page.items.map((event: WebActivityEvent) => runtime.enrichActivityEvent(event, currentInfo)),
    };
  }

export async function relayRuntimeRetry(runtime: RelayRuntimeDelegate, actor?: WebActivityActor): Promise<{ queued: boolean; queueId?: string; correlationId?: string }> {
    const cached = runtime.queueService.getLastPrompt();
    if (!cached) {
      throw new Error("Nothing to retry. Send a message first.");
    }
    runtime.appendAudit({
      action: "command",
      status: "ok",
      contextKey: runtime.contextKey,
      actor,
      description: "retry",
      detail: cached.description,
    });
    return runtime.sendEnvelope({ ...cached, activityActor: cached.activityActor ?? actor }, actor);
  }

export async function relayRuntimeSync(runtime: RelayRuntimeDelegate, actor?: WebActivityActor): Promise<ReturnType<AgentSessionService["syncFromAgentState"]>> {
    const session = await runtime.getSession(true);
    const info = runtime.publicInfo(session);
    if (!(info.capabilities ?? CODEX_AGENT_CAPABILITIES).externalActivity) {
      throw new Error(`${info.agentLabel} has no external state watcher to sync.`);
    }
    const result = session.syncFromAgentState({ reattach: true });
    if (result.changed) {
      runtime.updateSession(session);
    }
    runtime.appendActivity({
      source: "web",
      status: "info",
      type: "session_sync",
      threadId: result.info.threadId,
      workspace: result.info.workspace,
      agentId: result.info.agentId,
      actor,
      detail: result.changedFields.length > 0 ? result.changedFields.join(", ") : "already in sync",
    });
    runtime.appendAudit({
      action: "command",
      status: "ok",
      contextKey: runtime.contextKey,
      agentId: result.info.agentId,
      threadId: result.info.threadId,
      workspace: result.info.workspace,
      actor,
      description: "sync",
      detail: result.changedFields.join(", ") || "none",
    });
    return result;
  }

export async function relayRuntimeListSessions(runtime: RelayRuntimeDelegate, limit = 80, query = "", agentId?: AgentId): Promise<AgentThreadRecord[]> {
    const { session, dispose } = await runtime.getControlSession(agentId);
    try {
      return runtime.filteredSessions(session, query, Math.max(1, limit * 3)).slice(0, limit);
    } finally {
      if (dispose) {
        session.dispose();
      }
    }
  }

export async function relayRuntimeListSessionsPage(runtime: RelayRuntimeDelegate, page = 1, pageSize = MAX_WEB_SESSION_PAGE_SIZE, query = "", agentId?: AgentId): Promise<SessionPageDto> {
    const { session, dispose } = await runtime.getControlSession(agentId);
    try {
      const effectivePage = Math.max(1, Math.floor(page));
      const effectivePageSize = Math.min(MAX_WEB_SESSION_PAGE_SIZE, Math.max(1, Math.floor(pageSize)));
      const offset = (effectivePage - 1) * effectivePageSize;
      const requested = Math.min(5_000, Math.max(100, (offset + effectivePageSize + 1) * 3));
      const records = runtime.filteredSessions(session, query, requested);
      return {
        sessions: records.slice(offset, offset + effectivePageSize),
        pagination: {
          page: effectivePage,
          pageSize: effectivePageSize,
          hasPrevious: effectivePage > 1,
          hasNext: records.length > offset + effectivePageSize,
        },
      };
    } finally {
      if (dispose) {
        session.dispose();
      }
    }
  }

export function relayRuntimeFilteredSessions(runtime: RelayRuntimeDelegate, session: AgentSessionService, query: string, limit: number): AgentThreadRecord[] {
    const normalized = query.trim().toLowerCase();
    return session.listAllSessions(limit)
      .filter((record) => evaluateWorkspacePolicy(record.cwd, runtime.config).allowed)
      .filter((record) => {
        if (!normalized) {
          return true;
        }
        return [
          record.id,
          record.title,
          record.cwd,
          record.model,
          record.reasoningEffort,
          record.firstUserMessage,
        ].some((value) => value?.toLowerCase().includes(normalized));
      })
      .sort((left, right) => sessionUpdatedAtMs(right) - sessionUpdatedAtMs(left));
  }

function sessionUpdatedAtMs(record: AgentThreadRecord): number {
    const value = record.updatedAt instanceof Date ? record.updatedAt.getTime() : Date.parse(String(record.updatedAt));
    return Number.isFinite(value) ? value : 0;
  }

export async function relayRuntimeListModels(runtime: RelayRuntimeDelegate): Promise<ReturnType<AgentSessionService["listModels"]>> {
    const session = await runtime.getSession(true);
    const info = runtime.publicInfo(session);
    await session.refreshModels({ force: true }).catch((error: unknown) => {
      console.warn(
        `Failed to refresh ${agentLabel(info.agentId)} models: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    return session.listModels();
  }

export async function relayRuntimeSetAgent(runtime: RelayRuntimeDelegate, agentId: AgentId, actor?: WebActivityActor): Promise<AgentSessionInfo> {
    if (!enabledAgents(runtime.config).includes(agentId)) {
      throw new Error(`Agent is not enabled: ${agentId}`);
    }
    const session = await runtime.registry.switchAgent(runtime.contextKey, agentId);
    runtime.updateSession(session);
    const info = runtime.publicInfo(session);
    runtime.appendActivity({
      source: "web",
      status: "info",
      type: "agent_switch",
      threadId: info.threadId,
      workspace: info.workspace,
      agentId: info.agentId,
      actor,
      detail: `Dashboard switched agent to ${info.agentLabel}.`,
    });
    return runtime.publicInfo(session);
  }

export async function relayRuntimeNewSession(runtime: RelayRuntimeDelegate, options: {
    agentId?: AgentId;
    workspace?: string;
    model?: string;
    reasoningEffort?: string;
    launchProfileId?: string;
    fastMode?: boolean;
  } = {}, actor?: WebActivityActor): Promise<AgentSessionInfo> {
    const session = options.agentId ? await runtime.registry.switchAgent(runtime.contextKey, options.agentId) : await runtime.getSession(true);
    runtime.ensureIdle(session);
    if (options.reasoningEffort) {
      const reasoningOptions = agentReasoningOptions(session.getInfo().agentId);
      if (!reasoningOptions.includes(options.reasoningEffort as never)) {
        throw new Error(`Invalid ${agentReasoningLabel(session.getInfo().agentId)} value: ${options.reasoningEffort}`);
      }
      session.setReasoningEffort(options.reasoningEffort);
    }
    if (options.launchProfileId && (session.getInfo().capabilities ?? CODEX_AGENT_CAPABILITIES).launchProfiles) {
      session.setLaunchProfile(options.launchProfileId);
    }
    if (typeof options.fastMode === "boolean" && (session.getInfo().capabilities ?? CODEX_AGENT_CAPABILITIES).fastMode) {
      session.setFastMode(options.fastMode);
    }
    const info = await session.newThread(options.workspace, options.model);
    runtime.updateSession(session);
    runtime.appendActivity({
      source: "web",
      status: "info",
      type: "session_new",
      threadId: info.threadId,
      workspace: info.workspace,
      agentId: info.agentId,
      actor,
      detail: "New dashboard session created.",
    });
    return runtime.publicInfo(session);
  }

export async function relayRuntimeSwitchSession(runtime: RelayRuntimeDelegate, threadId: string, actor?: WebActivityActor): Promise<AgentSessionInfo> {
    const session = await runtime.getSession(true);
    runtime.ensureIdle(session);
    const info = await session.switchSession(threadId);
    runtime.updateSession(session);
    runtime.broadcast({ type: "chat_history", messages: await runtime.chatHistory() });
    runtime.appendActivity({
      source: "web",
      status: "info",
      type: "session_switch",
      threadId: info.threadId,
      workspace: info.workspace,
      agentId: info.agentId,
      actor,
      detail: "Dashboard switched session.",
    });
    return runtime.publicInfo(session);
  }

export async function relayRuntimeAttachSession(runtime: RelayRuntimeDelegate, threadId: string, actor?: WebActivityActor): Promise<AgentSessionInfo> {
    return runtime.switchSession(threadId, actor);
  }

export async function relayRuntimeSetModel(runtime: RelayRuntimeDelegate, model: string, actor?: WebActivityActor): Promise<AgentSessionInfo> {
    const session = await runtime.getSession(true);
    runtime.ensureIdle(session);
    await session.setModelForCurrentSession(model);
    runtime.updateSession(session);
    const info = runtime.publicInfo(session);
    runtime.appendActivity({ source: "web", status: "info", type: "model_changed", threadId: info.threadId, workspace: info.workspace, agentId: info.agentId, actor, detail: model });
    return info;
  }

export async function relayRuntimeSetReasoningEffort(runtime: RelayRuntimeDelegate, effort: string, actor?: WebActivityActor): Promise<AgentSessionInfo> {
    const session = await runtime.getSession(true);
    runtime.ensureIdle(session);
    const options = agentReasoningOptions(session.getInfo().agentId);
    if (!options.includes(effort as never)) {
      throw new Error(`Invalid ${agentReasoningLabel(session.getInfo().agentId)} value: ${effort}`);
    }
    await session.setReasoningEffortForCurrentSession(effort);
    runtime.updateSession(session);
    const info = runtime.publicInfo(session);
    runtime.appendActivity({ source: "web", status: "info", type: "reasoning_changed", threadId: info.threadId, workspace: info.workspace, agentId: info.agentId, actor, detail: effort });
    return info;
  }

export async function relayRuntimeSetFastMode(runtime: RelayRuntimeDelegate, enabled: boolean, actor?: WebActivityActor): Promise<AgentSessionInfo> {
    const session = await runtime.getSession(true);
    runtime.ensureIdle(session);
    if (!(session.getInfo().capabilities ?? CODEX_AGENT_CAPABILITIES).fastMode) {
      throw new Error(`Fast mode is not supported for ${agentLabel(session.getInfo().agentId)}.`);
    }
    session.setFastMode(enabled);
    runtime.updateSession(session);
    const info = runtime.publicInfo(session);
    runtime.appendActivity({ source: "web", status: "info", type: "fast_mode_changed", threadId: info.threadId, workspace: info.workspace, agentId: info.agentId, actor, detail: enabled ? "on" : "off" });
    return info;
  }

export async function relayRuntimeSetLaunchProfile(
  runtime: RelayRuntimeDelegate,
  profileId: string,
  actor?: WebActivityActor,
  options: { applyToCurrent?: boolean } = {},
): Promise<AgentSessionInfo> {
    const session = await runtime.getSession(true);
    runtime.ensureIdle(session);
    if (options.applyToCurrent) {
      const external = getExternalSnapshotForSession(session, runtime.config, { maxEvents: 0 });
      if (external?.activity.active && !session.isProcessing()) {
        throw new Error(`Cannot apply launch profile while the external ${external.agentLabel} CLI task is still running.`);
      }
    }
    const result = options.applyToCurrent && session.setLaunchProfileForCurrentSession
      ? await session.setLaunchProfileForCurrentSession(profileId)
      : { value: session.setLaunchProfile(profileId).id, appliedToActiveThread: false };
    runtime.updateSession(session);
    const info = runtime.publicInfo(session);
    runtime.appendActivity({
      source: "web",
      status: "info",
      type: result.appliedToActiveThread ? "launch_profile_applied" : "launch_profile_changed",
      threadId: info.threadId,
      workspace: info.workspace,
      agentId: info.agentId,
      actor,
      detail: info.launchProfileLabel ?? result.value ?? profileId,
    });
    return info;
  }

export async function relayRuntimeHandback(runtime: RelayRuntimeDelegate, actor?: WebActivityActor): Promise<ReturnType<AgentSessionService["handback"]>> {
    const session = await runtime.getSession(true);
    runtime.ensureIdle(session);
    const result = session.handback();
    runtime.updateSession(session);
    const info = runtime.publicInfo(session);
    runtime.appendActivity({ source: "web", status: "info", type: "handback", threadId: result.threadId, workspace: result.workspace, agentId: info.agentId, actor, detail: result.command ?? "Thread handed back." });
    return result;
  }

export async function relayRuntimeAbort(runtime: RelayRuntimeDelegate, actor?: WebActivityActor): Promise<void> {
    const session = await runtime.getSession(true);
    const snapshot = getExternalSnapshotForSession(session, runtime.config, { maxEvents: 0 });
    if (snapshot?.activity.active && !session.isProcessing()) {
      runtime.broadcast({
        type: "status",
        level: "warn",
        message: `Cannot abort the external ${snapshot.agentLabel} CLI task from NordRelay. Stop it in the terminal where it is running.`,
        at: new Date().toISOString(),
      });
      const info = runtime.publicInfo(session);
      runtime.appendActivity({ source: "web", status: "aborted", type: "prompt_abort_rejected", threadId: info.threadId, workspace: info.workspace, agentId: info.agentId, actor, detail: `External ${snapshot.agentLabel} CLI task is active.` });
      return;
    }
    await session.abort();
    const info = runtime.publicInfo(session);
    runtime.appendActivity({ source: "web", status: "aborted", type: "prompt_aborted", threadId: info.threadId, workspace: info.workspace, agentId: info.agentId, actor, detail: "Current operation aborted." });
    runtime.broadcast({ type: "status", level: "warn", message: "Current operation aborted.", at: new Date().toISOString() });
  }

export async function relayRuntimeGetControlSession(runtime: RelayRuntimeDelegate, agentId?: AgentId): Promise<{ session: AgentSessionService; dispose: boolean }> {
    const active = await runtime.getSession(true);
    const activeInfo = runtime.publicInfo(active);
    if (!agentId || agentId === activeInfo.agentId) {
      return { session: active, dispose: false };
    }
    if (!enabledAgents(runtime.config).includes(agentId)) {
      throw new Error(`Agent is not enabled: ${agentId}`);
    }
    const session = await createAgentSessionService(runtime.config, agentId, {
      deferThreadStart: true,
      workspace: activeInfo.workspace,
    });
    return { session, dispose: true };
  }

export function relayRuntimeCliPathOptions(runtime: RelayRuntimeDelegate): { piCliPath?: string; hermesCliPath?: string; openClawCliPath?: string; claudeCodeCliPath?: string } {
    return {
      piCliPath: runtime.config.piCliPath,
      hermesCliPath: runtime.config.hermesCliPath,
      openClawCliPath: runtime.config.openClawCliPath,
      claudeCodeCliPath: runtime.config.claudeCodeCliPath,
    };
  }
