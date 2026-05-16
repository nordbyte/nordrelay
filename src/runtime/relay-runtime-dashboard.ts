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

export function relayRuntimeSubscribe(runtime: RelayRuntimeDelegate, callback: (event: RelayEvent) => void): () => void {
    runtime.subscribers.add(callback);
    void runtime.snapshot().then((data) => callback({ type: "snapshot", data })).catch(() => {});
    void runtime.chatHistory().then((messages) => callback({ type: "chat_history", messages })).catch(() => {});
    void runtime.activeSessions().then((active) => callback({ type: "active_sessions_update", active })).catch(() => {});
    callback({ type: "activity_update", events: runtime.activity({ limit: 50 }) });
    return () => runtime.subscribers.delete(callback);
  }

export async function relayRuntimeSnapshot(runtime: RelayRuntimeDelegate): Promise<RelaySnapshot> {
    const session = await runtime.getSession(true);
    const info = runtime.publicInfo(session);
    return {
      session: info,
      sessionText: renderSessionInfoPlain(info),
      queue: runtime.queue(),
      queuePaused: runtime.queuePaused(),
      processing: session.isProcessing(),
      enabledAgents: enabledAgents(runtime.config),
      workspaces: filterAllowedWorkspaces(session.listWorkspaces(), runtime.config),
    };
  }

export async function relayRuntimeStatus(runtime: RelayRuntimeDelegate): Promise<Record<string, unknown>> {
    const cliOptions = runtime.cliPathOptions();
    const [health, versionChecks, snapshot] = await Promise.all([
      getConnectorHealth(cliOptions),
      getVersionChecks(cliOptions),
      runtime.snapshot(),
    ]);
    return {
      health,
      versionChecks,
      snapshot,
    };
  }

export async function relayRuntimeBootstrapStatus(runtime: RelayRuntimeDelegate): Promise<Record<string, unknown>> {
    return {
      health: {
        version: await getPackageVersion(),
        state: await readConnectorState(),
      },
      snapshot: await runtime.snapshot(),
    };
  }

export async function relayRuntimeVersion(runtime: RelayRuntimeDelegate): Promise<Record<string, unknown>> {
    return runtime.dashboardService.version();
  }

export async function relayRuntimeDiagnostics(runtime: RelayRuntimeDelegate): Promise<WebDiagnosticsDto> {
    return runtime.dashboardService.diagnostics();
  }

export async function relayRuntimeAdapterHealth(runtime: RelayRuntimeDelegate): Promise<WebAdapterHealthDto[]> {
    return runtime.dashboardService.adapterHealth();
  }

export function relayRuntimePermissions(runtime: RelayRuntimeDelegate): WebPermissionsDto {
    return {
      mode: "users",
      message: "Access is managed by NordRelay users, groups, Telegram identities, Telegram chat access records, Discord identities, and Discord channel access records.",
    };
  }

export async function relayRuntimeMetrics(runtime: RelayRuntimeDelegate): Promise<RuntimeMetricsDto> {
    const [active, jobs] = await Promise.all([
      runtime.activeSessions(),
      runtime.jobs(),
    ]);
    return buildRuntimeMetrics({
      queueLength: runtime.queueService.length(),
      queuePaused: runtime.queueService.isPaused(),
      activeTurnCount: active.sessions.length,
      jobs: jobs.jobs,
      activity: runtime.activity({ limit: 500 }),
    });
  }

export function relayRuntimeAudit(runtime: RelayRuntimeDelegate, options: number | AuditListOptions = 50): AuditEvent[] {
    return runtime.auditStore.list(options);
  }

export async function relayRuntimeSupportBundle(runtime: RelayRuntimeDelegate, actor?: WebActivityActor): Promise<SupportBundleResult> {
    const bundle = await createSupportBundle({
      config: runtime.config,
      diagnostics: await runtime.diagnostics(),
      adapterHealth: await runtime.adapterHealth(),
      auditEvents: runtime.auditStore.list(100),
      agentUpdateJobs: runtime.agentUpdates.list(),
      source: "web",
    });
    runtime.appendActivity({
      source: "web",
      status: "info",
      type: "diagnostics_bundle_exported",
      threadId: null,
      workspace: runtime.config.workspace,
      actor,
      detail: bundle.path,
    });
    runtime.appendAudit({
      action: "command",
      status: "ok",
      contextKey: runtime.contextKey,
      actor,
      description: "export diagnostics bundle",
      detail: bundle.path,
    });
    return bundle;
  }

export async function relayRuntimeLogs(runtime: RelayRuntimeDelegate, target: "connector" | "update" | "agent-updates" = "connector", lines = 100): Promise<ReturnType<typeof readFormattedLogTail>> {
    if (target === "update") {
      return readFormattedLogTail(lines, getUpdateLogPath());
    }
    if (target === "agent-updates") {
      return readFormattedLogTail(lines, getAgentUpdateLogPath());
    }
    return readFormattedLogTail(lines);
  }

export function relayRuntimeClearLogs(runtime: RelayRuntimeDelegate, target: "connector" | "update" | "agent-updates" = "connector", actor?: WebActivityActor): { ok: true; filePath: string; clearedAt: string } {
    const result = clearLogFile(target === "update" ? getUpdateLogPath() : target === "agent-updates" ? getAgentUpdateLogPath() : getConnectorLogPath());
    runtime.appendActivity({
      source: "web",
      status: "info",
      type: "logs_cleared",
      threadId: null,
      workspace: runtime.config.workspace,
      actor,
      detail: `Cleared ${target} log.`,
    });
    runtime.appendAudit({
      action: "command",
      status: "ok",
      contextKey: runtime.contextKey,
      actor,
      description: `clear ${target} log`,
      detail: result.filePath,
    });
    return { ok: true, filePath: result.filePath, clearedAt: result.clearedAt.toISOString() };
  }

export function relayRuntimeRestartConnector(runtime: RelayRuntimeDelegate, actor?: WebActivityActor): { ok: true; message: string } {
    spawnConnectorRestart();
    runtime.broadcastStatus("Restart requested. The dashboard may disconnect briefly.", "warn");
    runtime.appendActivity({
      source: "web",
      status: "info",
      type: "restart_requested",
      threadId: null,
      workspace: runtime.config.workspace,
      actor,
      detail: "Dashboard requested a connector restart.",
    });
    runtime.appendAudit({
      action: "command",
      status: "ok",
      contextKey: runtime.contextKey,
      actor,
      description: "restart connector",
    });
    return { ok: true, message: "Restart requested." };
  }

export function relayRuntimeDispose(runtime: RelayRuntimeDelegate): void {
    if (runtime.externalMonitor) {
      clearInterval(runtime.externalMonitor);
    }
    runtime.dashboardService.stopBackgroundRefresh();
    runtime.agentUpdates.cancelAll();
    runtime.registry.disposeAll();
    runtime.subscribers.clear();
  }
