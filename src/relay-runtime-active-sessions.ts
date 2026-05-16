import { randomUUID } from "node:crypto";

import { ensureOutDir, type ArtifactTurnReport } from "./artifacts.js";
import {
  buildFileInstructions,
  outboxPath,
  stageFile,
  type StagedFile,
} from "./attachments.js";
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
} from "./agent.js";
import { getExternalSnapshotForSession } from "./agent-activity.js";
import { listAgentAdapterDescriptors } from "./agent-adapter.js";
import { AgentUpdateManager, type AgentUpdateJobSnapshot, type AgentUpdateOperation } from "./agent-updates.js";
import { createAgentSessionService, enabledAgents } from "./agent-factory.js";
import { AuditLogStore, type AuditEvent, type AuditListOptions } from "./audit-log.js";
import { BotPreferencesStore } from "./bot-preferences.js";
import { ChannelCommandService } from "./channel-command-service.js";
import { ChannelTurnService } from "./channel-turn-service.js";
import { activeSessionSourceForContextKey, ChannelMirrorRegistry } from "./channel-mirror-registry.js";
import type { LoginResult } from "./codex-auth.js";
import { listThreads as listCodexThreads } from "./codex-state.js";
import type { ConnectorConfig } from "./config.js";
import type { ChannelContextKey } from "./context-key.js";
import { friendlyErrorText } from "./error-messages.js";
import { clearLogFile, getAgentUpdateLogPath, getConnectorHealth, getConnectorLogPath, getPackageVersion, getUpdateLogPath, getVersionChecks, readConnectorState, readFormattedLogTail, spawnConnectorRestart, spawnSelfUpdate } from "./operations.js";
import { PromptStore, toPromptEnvelope, type PromptEnvelope } from "./prompt-store.js";
import { UnifiedJobStore } from "./job-store.js";
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
import { capabilitiesOf } from "./bot-rendering.js";
import { renderSessionInfoPlain, renderSessionUsageRows } from "./session-format.js";
import { SessionLockStore, type SessionLock } from "./session-locks.js";
import { SessionRegistry, type ContextMetadata } from "./session-registry.js";
import { createSupportBundle, type SupportBundleResult } from "./support-bundle.js";
import { transcribeAudio, type TranscriptionBackend } from "./voice.js";
import {
  WebActivityStore,
  WebChatStore,
  type WebActivityActor,
  type WebActivityCategory,
  type WebActivityEvent,
  type WebActivitySource,
  type WebActivityStatus,
  type WebChatMessage,
} from "./web-state.js";
import type {
  ActiveSessionDto,
  ActiveSessionMirrorDto,
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
import { evaluateWorkspacePolicy, filterAllowedWorkspaces } from "./workspace-policy.js";
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

export async function relayRuntimeActiveSessions(runtime: RelayRuntimeDelegate): Promise<ActiveSessionsDto> {
    const sessions = new Map<string, ActiveSessionDto>();
    const knownContexts = runtime.listKnownContextMetadata();
    const preferences = new BotPreferencesStore(runtime.config.workspace, runtime.config.stateBackend);
    const addActiveSession = (session: ActiveSessionDto): void => {
      const key = runtime.activeSessionKey(session);
      const existing = sessions.get(key);
      sessions.set(key, runtime.preferredActiveSession(existing, session));
    };

    if (runtime.currentProgress?.status === "running") {
      addActiveSession({
        ...runtime.currentProgress,
        contextKey: runtime.contextKey,
        sourceContextKey: runtime.contextKey,
        source: "web",
        status: "running",
        queueLength: runtime.queueService.length(),
        queuePaused: runtime.queueService.isPaused(),
      });
    }

    for (const active of runtime.discoverRunningConnectorSessions()) {
      addActiveSession(active);
    }

    for (const active of runtime.discoverActiveCodexSessions(knownContexts, preferences)) {
      addActiveSession(active);
    }

    for (const meta of knownContexts) {
      if (meta.contextKey === runtime.contextKey && runtime.currentProgress?.status === "running") {
        continue;
      }
      const active = runtime.externalActiveSession(meta, knownContexts, preferences);
      if (active) {
        addActiveSession(active);
      }
    }

    return {
      sessions: [...sessions.values()].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)),
      updatedAt: new Date().toISOString(),
    };
  }

export async function relayRuntimeGetSession(runtime: RelayRuntimeDelegate, deferThreadStart: boolean): Promise<AgentSessionService> {
    return runtime.registry.getOrCreate(runtime.contextKey, { deferThreadStart });
  }

export function relayRuntimeListKnownContextMetadata(runtime: RelayRuntimeDelegate): ContextMetadata[] {
    const contexts = new Map<string, ContextMetadata>();
    const add = (meta: ContextMetadata | undefined): void => {
      if (meta?.contextKey) {
        contexts.set(meta.contextKey, meta);
      }
    };

    for (const meta of runtime.registry.listContexts()) {
      add(meta);
    }

    const sharedRegistry = new SessionRegistry(runtime.config);
    try {
      for (const meta of sharedRegistry.listContexts()) {
        add(meta);
      }
    } finally {
      sharedRegistry.disposeAll();
    }

    const current = runtime.registry.get(runtime.contextKey)?.getInfo();
    if (current) {
      add({
        contextKey: runtime.contextKey,
        agentId: current.agentId,
        threadId: current.threadId,
        workspace: current.workspace,
        model: current.model,
        reasoningEffort: current.reasoningEffort,
        launchProfileId: current.nextLaunchProfileId ?? current.launchProfileId,
        sessionPath: current.sessionPath,
        updatedAt: Date.now(),
      });
    }

    return [...contexts.values()];
  }

export function relayRuntimeDiscoverRunningConnectorSessions(runtime: RelayRuntimeDelegate): ActiveSessionDto[] {
    const active: ActiveSessionDto[] = [];
    const terminal = new Set<string>();
    const now = Date.now();
    for (const event of runtime.activityStore.list({ limit: 500 })) {
      if (!event.threadId || !event.agentId || !event.contextKey) {
        continue;
      }
      const key = `${event.source}:${event.contextKey}:${event.agentId}:${event.threadId}`;
      if (isPromptTerminalActivity(event)) {
        terminal.add(key);
        continue;
      }
      if (event.type !== "prompt_started" || event.status !== "running" || event.source === "cli") {
        continue;
      }
      if (terminal.has(key)) {
        continue;
      }
      const startedMs = Date.parse(event.timestamp);
      if (!Number.isFinite(startedMs) || now - startedMs > ACTIVE_ACTIVITY_TTL_MS) {
        continue;
      }
      active.push({
        id: `${event.contextKey}:${event.id}`,
        contextKey: event.contextKey,
        sourceContextKey: event.contextKey,
        source: event.source,
        status: "running",
        agentId: event.agentId,
        agentLabel: event.agentId ? agentLabel(event.agentId) : undefined,
        threadId: event.threadId,
        workspace: event.workspace,
        prompt: event.prompt,
        startedAt: event.timestamp,
        updatedAt: event.timestamp,
        durationMs: Math.max(0, now - startedMs),
        queueLength: runtime.promptStore.list(event.contextKey).length,
        queuePaused: runtime.promptStore.isPaused(event.contextKey),
        detail: event.actor?.label ? `Started by ${event.actor.label}` : undefined,
      });
    }
    return active;
  }

export function relayRuntimeDiscoverActiveCodexSessions(runtime: RelayRuntimeDelegate, knownContexts: ContextMetadata[], preferences: BotPreferencesStore): ActiveSessionDto[] {
    if (!runtime.config.codexEnabled || !enabledAgents(runtime.config).includes("codex")) {
      return [];
    }

    const capabilities = runtime.capabilitiesForAgent("codex");
    if (!capabilities.externalActivity) {
      return [];
    }

    const active: ActiveSessionDto[] = [];
    const nowMs = Date.now();
    const staleAfterMs = runtime.config.codexExternalBusyStaleMs;
    for (const thread of listCodexThreads(ACTIVE_CODEX_DISCOVERY_LIMIT)) {
      if (staleAfterMs > 0 && nowMs - thread.updatedAt.getTime() > staleAfterMs) {
        continue;
      }
      const meta: ContextMetadata = {
        contextKey: `cli:codex:${thread.id}`,
        agentId: "codex",
        threadId: thread.id,
        workspace: thread.cwd,
        model: thread.model ?? undefined,
        reasoningEffort: thread.reasoningEffort ?? undefined,
        updatedAt: thread.updatedAt.getTime(),
      };
      const session = runtime.externalActiveSession(meta, knownContexts, preferences);
      if (session) {
        active.push(session);
      }
    }
    return active;
  }

export function relayRuntimeExternalActiveSession(runtime: RelayRuntimeDelegate, meta: ContextMetadata, knownContexts: ContextMetadata[], preferences: BotPreferencesStore): ActiveSessionDto | null {
    if (!meta.threadId) {
      return null;
    }
    const agentId = isAgentId(meta.agentId) ? meta.agentId : runtime.config.defaultAgent;
    if (!enabledAgents(runtime.config).includes(agentId)) {
      return null;
    }
    const capabilities = runtime.capabilitiesForAgent(agentId);
    if (!capabilities.externalActivity) {
      return null;
    }
    if (
      agentId === "codex" &&
      meta.updatedAt &&
      runtime.config.codexExternalBusyStaleMs > 0 &&
      Date.now() - meta.updatedAt > runtime.config.codexExternalBusyStaleMs
    ) {
      return null;
    }

    const snapshot = getExternalSnapshotForSession(runtime.sessionStubForMetadata(meta, agentId, capabilities), runtime.config, {
      maxEvents: 8,
    });
    if (!snapshot?.activity.active) {
      return null;
    }

    const startedAt = snapshot.activity.startedAt?.toISOString() ?? new Date().toISOString();
    const updatedAt = snapshot.activity.updatedAt?.toISOString() ?? new Date().toISOString();
    const startedMs = Date.parse(startedAt);
    const sourceContextKey = `cli:${snapshot.agentId}:${snapshot.threadId}`;
    const mirrorChannels = runtime.mirrorRegistry.activeMirrorsForThread(snapshot.agentId, snapshot.threadId, knownContexts, preferences);
    const queueLength = runtime.mirrorRegistry.queueLengthForExternalSource(sourceContextKey, mirrorChannels);
    const mirrorDetail = mirrorChannels.length > 0
      ? `Mirroring: ${mirrorChannels.map((mirror: ActiveSessionMirrorDto) => `${mirror.source} ${mirror.mode}`).join(", ")}`
      : "Mirroring: none";
    return {
      id: `${sourceContextKey}:${snapshot.activity.turnId ?? snapshot.threadId}`,
      contextKey: sourceContextKey,
      sourceContextKey,
      source: "cli",
      status: "external",
      agentId: snapshot.agentId,
      agentLabel: snapshot.agentLabel,
      threadId: snapshot.threadId,
      workspace: meta.workspace,
      prompt: snapshot.latestUserMessage ?? undefined,
      currentTool: snapshot.latestToolName ?? undefined,
      lastTool: snapshot.latestToolName ?? undefined,
      startedAt,
      updatedAt,
      durationMs: Number.isFinite(startedMs) ? Math.max(0, Date.now() - startedMs) : 0,
      queueLength,
      queuePaused: runtime.mirrorRegistry.queuePausedForExternalSource(sourceContextKey, mirrorChannels),
      mirrorChannels,
      detail: `${mirrorDetail} | ${snapshot.sourceLabel}: ${snapshot.sourcePath}`,
    };
  }

export function relayRuntimeSessionStubForMetadata(runtime: RelayRuntimeDelegate, meta: ContextMetadata, agentId: AgentId, capabilities: AgentCapabilities): AgentSessionService {
    const info: AgentSessionInfo = {
      agentId,
      agentLabel: agentLabel(agentId),
      threadId: meta.threadId,
      workspace: meta.workspace,
      model: meta.model,
      reasoningEffort: meta.reasoningEffort,
      launchProfileId: meta.launchProfileId ?? runtime.config.defaultLaunchProfileId,
      launchProfileLabel: meta.launchProfileId ?? runtime.config.defaultLaunchProfileId,
      launchProfileBehavior: "-",
      sandboxMode: "-",
      approvalPolicy: "-",
      fastMode: false,
      unsafeLaunch: false,
      sessionPath: meta.sessionPath,
      capabilities,
    };
    return {
      getInfo: () => info,
      getActiveThreadId: () => meta.threadId,
    } as AgentSessionService;
  }

export function relayRuntimeCapabilitiesForAgent(runtime: RelayRuntimeDelegate, agentId: AgentId): AgentCapabilities {
    return listAgentAdapterDescriptors().find((descriptor) => descriptor.id === agentId)?.capabilities ?? CODEX_AGENT_CAPABILITIES;
  }

export function relayRuntimeActiveSessionKey(runtime: RelayRuntimeDelegate, session: Pick<ActiveSessionDto, "agentId" | "threadId" | "id">): string {
    return session.threadId ? `${session.agentId ?? "unknown"}:${session.threadId}` : session.id;
  }

export function relayRuntimePreferredActiveSession(runtime: RelayRuntimeDelegate, existing: ActiveSessionDto | undefined, candidate: ActiveSessionDto): ActiveSessionDto {
    if (!existing) {
      return candidate;
    }
    const existingPriority = activeSessionPriority(existing);
    const candidatePriority = activeSessionPriority(candidate);
    if (candidatePriority !== existingPriority) {
      return candidatePriority > existingPriority ? candidate : existing;
    }
    return Date.parse(candidate.updatedAt) >= Date.parse(existing.updatedAt) ? candidate : existing;
  }

export function relayRuntimeRecordActivity(runtime: RelayRuntimeDelegate, input: Omit<WebActivityEvent, "id" | "timestamp"> & { timestamp?: string }): WebActivityEvent {
    return runtime.appendActivity(input);
  }

export function relayRuntimeAppendActivity(runtime: RelayRuntimeDelegate, input: Omit<WebActivityEvent, "id" | "timestamp"> & { timestamp?: string }): WebActivityEvent {
    const event = runtime.activityStore.append(runtime.enrichActivityInput(input));
    runtime.broadcast({ type: "activity_update", events: runtime.activity({ limit: 50 }) });
    return event;
  }

export function relayRuntimeEnrichActivityInput<T extends Omit<WebActivityEvent, "id" | "timestamp"> & { timestamp?: string }>(runtime: RelayRuntimeDelegate, input: T): T {
    return runtime.enrichActivityFields(input) as T;
  }

export function relayRuntimeEnrichActivityEvent(runtime: RelayRuntimeDelegate, event: WebActivityEvent, info?: AgentSessionInfo): WebActivityEvent {
    return runtime.enrichActivityFields(event, info) as WebActivityEvent;
  }

export function relayRuntimeEnrichActivityFields<T extends Pick<WebActivityEvent, "threadId"> & Partial<Pick<WebActivityEvent, "workspace" | "agentId">>>(runtime: RelayRuntimeDelegate, event: T, info?: AgentSessionInfo): T {
    if (!info) {
      return !event.threadId && !event.workspace ? { ...event, workspace: runtime.config.workspace } : event;
    }
    if (event.threadId && info.threadId && event.threadId === info.threadId) {
      return { ...event, workspace: event.workspace ?? info.workspace, agentId: event.agentId ?? info.agentId };
    }
    if (!event.threadId && !event.workspace) {
      return { ...event, workspace: runtime.config.workspace };
    }
    return event;
  }

export function relayRuntimeAppendAudit(runtime: RelayRuntimeDelegate, input: Omit<AuditEvent, "id" | "timestamp" | "channelId">): AuditEvent {
    return runtime.auditStore.append({ ...input, channelId: "web" });
  }

export function relayRuntimeUpdateCurrentProgress(runtime: RelayRuntimeDelegate, patch: Partial<WebTaskDto> = {}): void {
    if (!runtime.currentProgress) {
      return;
    }
    if ("currentTool" in patch) {
      runtime.currentProgress.currentTool = patch.currentTool;
      const { currentTool: _currentTool, ...rest } = patch;
      Object.assign(runtime.currentProgress, rest);
    } else {
      Object.assign(runtime.currentProgress, patch);
    }
    runtime.currentProgress.durationMs = Date.now() - runtime.currentTurnStartedAt;
    runtime.currentProgress.updatedAt = new Date().toISOString();
  }

export function relayRuntimeAddCurrentTool(runtime: RelayRuntimeDelegate, toolName: string): void {
    if (!runtime.currentProgress) {
      return;
    }
    const existing = runtime.currentProgress.tools.find((tool: { name: string; count: number }) => tool.name === toolName);
    if (existing) {
      existing.count += 1;
    } else {
      runtime.currentProgress.tools.push({ name: toolName, count: 1 });
    }
    runtime.updateCurrentProgress({ currentTool: toolName, lastTool: toolName });
  }

export function relayRuntimeBroadcastQueue(runtime: RelayRuntimeDelegate): void {
    runtime.broadcast({ type: "queue_update", queue: runtime.queue(), paused: runtime.queuePaused() });
  }

export function relayRuntimeBroadcastStatus(runtime: RelayRuntimeDelegate, message: string, level: "info" | "warn" | "error" = "info"): void {
    runtime.broadcast({ type: "status", message, level, at: new Date().toISOString() });
  }

export function relayRuntimeBroadcast(runtime: RelayRuntimeDelegate, event: RelayEvent): void {
    for (const subscriber of runtime.subscribers) {
      try {
        subscriber(event);
      } catch {
        runtime.subscribers.delete(subscriber);
      }
    }
    if (shouldRefreshActiveSessions(event)) {
      runtime.scheduleActiveSessionsBroadcast();
    }
  }

export function relayRuntimeScheduleActiveSessionsBroadcast(runtime: RelayRuntimeDelegate): void {
    if (runtime.activeSessionsBroadcastTimer) {
      return;
    }
    const delayMs = Math.max(0, 1_000 - (Date.now() - runtime.activeSessionsLastBroadcastAt));
    runtime.activeSessionsBroadcastTimer = setTimeout(() => {
      runtime.activeSessionsBroadcastTimer = null;
      runtime.activeSessionsLastBroadcastAt = Date.now();
      void runtime.activeSessions()
        .then((active) => runtime.broadcast({ type: "active_sessions_update", active }))
        .catch(() => {});
    }, delayMs);
    runtime.activeSessionsBroadcastTimer.unref?.();
  }

export function relayRuntimePublicInfo(runtime: RelayRuntimeDelegate, session: AgentSessionService): AgentSessionInfo {
    const info = session.getInfo();
    const agentId = info.agentId ?? "codex";
    return {
      ...info,
      agentId,
      agentLabel: info.agentLabel ?? agentLabel(agentId),
      capabilities: info.capabilities ?? CODEX_AGENT_CAPABILITIES,
    };
  }
