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
  type AgentSessionInfoOptions,
  type AgentSessionService,
} from "../agents/shared/agent.js";
import { getExternalSnapshotForSession } from "../agents/shared/agent-activity.js";
import { listAgentAdapterDescriptors } from "../agents/shared/agent-adapter.js";
import { AgentUpdateManager, type AgentUpdateJobSnapshot, type AgentUpdateOperation } from "../agents/shared/agent-updates.js";
import { createAgentSessionService, enabledAgents } from "../agents/shared/agent-factory.js";
import { readCodexFastMode } from "../agents/codex/codex-config.js";
import { AuditLogStore, type AuditEvent, type AuditListOptions } from "../access/audit-log.js";
import { BotPreferencesStore } from "../state/bot-preferences.js";
import { ChannelCommandService } from "../channels/shared/channel-command-service.js";
import { ChannelTurnService } from "../channels/shared/channel-turn-service.js";
import { activeSessionSourceForContextKey, ChannelMirrorRegistry } from "../channels/shared/channel-mirror-registry.js";
import type { LoginResult } from "../agents/codex/codex-auth.js";
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
  isExternalSnapshotSuppressedByManagedAbort,
  isPromptTerminalActivity,
  normalizeMimeType,
  promptActivityToUnifiedJob,
  shouldRefreshActiveSessions,
  taskToUnifiedJob,
  uploadFileDtos,
} from "./relay-runtime-helpers.js";
import { relayRuntimeBroadcastQueueStatus } from "./relay-runtime-events.js";
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
import { evaluateWorkspacePolicy, filterAllowedWorkspaces } from "../core/workspace-policy.js";
import type { RelayRuntimeDelegate } from "./relay-runtime-delegate.js";
import { launchInfoFromMetadata } from "./launch-metadata.js";
import { getObservabilityRegistry } from "../observability/observability-registry.js";
import {
  relayRuntimeDiscoverActiveClaudeCodeSessions,
  relayRuntimeDiscoverActiveCodexSessions,
  relayRuntimeDiscoverActiveHermesSessions,
  relayRuntimeDiscoverActiveOpenClawSessions,
  relayRuntimeDiscoverActivePiSessions,
} from "./relay-runtime-active-discovery.js";
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
export {
  codexExecThreadId,
  relayRuntimeDiscoverActiveClaudeCodeSessions,
  relayRuntimeDiscoverActiveCodexSessions,
  relayRuntimeDiscoverActiveHermesSessions,
  relayRuntimeDiscoverActiveOpenClawSessions,
  relayRuntimeDiscoverActivePiSessions,
  relayRuntimeDiscoverActiveRecordedAgentSessions,
} from "./relay-runtime-active-discovery.js";

export const WEB_CONTEXT_KEY = "web:dashboard";
const ACTIVE_ACTIVITY_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_WEB_SESSION_PAGE_SIZE = 50;
const MAX_CHAT_HISTORY = 250;

export async function relayRuntimeActiveSessions(runtime: RelayRuntimeDelegate): Promise<ActiveSessionsDto> {
    const sessions = new Map<string, ActiveSessionDto>();
    const knownContexts = safeActiveSessionList(() => runtime.listKnownContextMetadata());
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

    for (const active of safeActiveSessionList(() => runtime.discoverRunningConnectorSessions())) {
      addActiveSession(active);
    }

    for (const discovered of await Promise.all([
      cachedActiveDiscovery(runtime, "codex", runtime.config.activeDiscoveryCacheTtlMs, () => runtime.discoverActiveCodexSessions(knownContexts, preferences)),
      cachedActiveDiscovery(runtime, "pi", runtime.config.activeDiscoveryCacheTtlMs, () => relayRuntimeDiscoverActivePiSessions(runtime, knownContexts, preferences)),
      cachedActiveDiscovery(runtime, "hermes", runtime.config.activeDiscoveryCacheTtlMs, () => relayRuntimeDiscoverActiveHermesSessions(runtime, knownContexts, preferences)),
      cachedActiveDiscovery(runtime, "openclaw", runtime.config.openClawActiveDiscoveryCacheTtlMs, () => relayRuntimeDiscoverActiveOpenClawSessions(runtime, knownContexts, preferences)),
      cachedActiveDiscovery(runtime, "claude-code", runtime.config.activeDiscoveryCacheTtlMs, () => relayRuntimeDiscoverActiveClaudeCodeSessions(runtime, knownContexts, preferences)),
    ])) {
      for (const active of discovered) {
        addActiveSession(active);
      }
    }

    for (const meta of knownContexts) {
      if (meta.contextKey === runtime.contextKey && runtime.currentProgress?.status === "running") {
        continue;
      }
      const active = safeActiveSession(() => runtime.externalActiveSession(meta, knownContexts, preferences));
      if (active) {
        addActiveSession(active);
      }
    }

    return {
      sessions: [...sessions.values()].map((session) => activeSessionWithName(runtime, session)).sort((left, right) =>
        right.durationMs - left.durationMs || Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
      ),
      updatedAt: new Date().toISOString(),
    };
  }

function activeSessionWithName(runtime: RelayRuntimeDelegate, session: ActiveSessionDto): ActiveSessionDto {
    if (!session.threadId || !session.agentId) {
      return session;
    }
    const record = runtime.sessionNameStore.get(session.agentId, session.threadId);
    return record ? { ...session, sessionName: record.name } : session;
  }

function safeActiveSession<T>(fn: () => T): T | null {
    try {
      return fn();
    } catch {
      return null;
    }
  }

function safeActiveSessionList<T>(fn: () => T[]): T[] {
    try {
      return fn();
    } catch {
      return [];
    }
  }

async function cachedActiveDiscovery(
  runtime: RelayRuntimeDelegate,
  key: string,
  ttlMs: number,
  producer: () => ActiveSessionDto[],
): Promise<ActiveSessionDto[]> {
    try {
      return (await runtime.cache.get<ActiveSessionDto[]>(`active-discovery:${key}`, ttlMs, async () => producer())).value;
    } catch {
      return [];
    }
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

    const current = safeActiveSession(() => runtime.registry.get(runtime.contextKey)?.getInfo()) ?? undefined;
    if (current) {
      add({
        contextKey: runtime.contextKey,
        agentId: current.agentId,
        threadId: current.threadId,
        workspace: current.workspace,
        model: current.model,
        reasoningEffort: current.reasoningEffort,
        activeLaunchProfileId: current.launchProfileId,
        launchProfileLabel: current.launchProfileLabel,
        launchProfileBehavior: current.launchProfileBehavior,
        sandboxMode: current.sandboxMode,
        approvalPolicy: current.approvalPolicy,
        unsafeLaunch: current.unsafeLaunch,
        launchProfileId: current.nextLaunchProfileId ?? current.launchProfileId,
        nextLaunchProfileLabel: current.nextLaunchProfileLabel,
        nextLaunchProfileBehavior: current.nextLaunchProfileBehavior,
        nextUnsafeLaunch: current.nextUnsafeLaunch,
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
    if (isExternalSnapshotSuppressedByManagedAbort(snapshot, runtime.activityStore.list({ threadId: snapshot.threadId, limit: 50 }))) {
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
      approvalRequired: snapshot.pendingApprovals?.[0],
      detail: `${mirrorDetail} | ${snapshot.sourceLabel}: ${snapshot.sourcePath}`,
    };
  }

export function relayRuntimeSessionStubForMetadata(runtime: RelayRuntimeDelegate, meta: ContextMetadata, agentId: AgentId, capabilities: AgentCapabilities): AgentSessionService {
    const launch = launchInfoFromMetadata(runtime.config, meta, agentId);
    const nextLaunchProfileId = meta.launchProfileId && meta.launchProfileId !== launch.id ? meta.launchProfileId : undefined;
    const info: AgentSessionInfo = {
      agentId,
      agentLabel: agentLabel(agentId),
      threadId: meta.threadId,
      workspace: meta.workspace,
      model: meta.model,
      reasoningEffort: meta.reasoningEffort,
      launchProfileId: launch.id,
      launchProfileLabel: launch.label,
      launchProfileBehavior: launch.behavior,
      sandboxMode: launch.sandboxMode,
      approvalPolicy: launch.approvalPolicy,
      fastMode: metadataFastMode(meta, agentId),
      unsafeLaunch: launch.unsafe,
      nextLaunchProfileId,
      nextLaunchProfileLabel: nextLaunchProfileId ? meta.nextLaunchProfileLabel ?? nextLaunchProfileId : undefined,
      nextLaunchProfileBehavior: nextLaunchProfileId ? meta.nextLaunchProfileBehavior : undefined,
      nextUnsafeLaunch: nextLaunchProfileId ? meta.nextUnsafeLaunch : undefined,
      sessionPath: meta.sessionPath,
      workspaceMode: meta.workspaceMode ?? "attached",
      worktree: meta.worktreeId ? (() => {
        const record = runtime.worktreeService.getByThreadId(meta.threadId);
        return record ? {
          id: record.id,
          sourceWorkspace: record.sourceWorkspace,
          repoRoot: record.repoRoot,
          baseSha: record.baseSha,
          branchName: record.branchName,
          status: record.status,
          commitSha: record.commitSha,
        } : undefined;
      })() : undefined,
      capabilities,
    };
    return {
      getInfo: () => info,
      getActiveThreadId: () => meta.threadId,
    } as AgentSessionService;
  }

function metadataFastMode(meta: ContextMetadata, agentId: AgentId): boolean {
  if (agentId !== "codex") {
    return false;
  }
  return readCodexFastMode() ?? meta.fastMode ?? false;
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
    const queue = runtime.queue();
    const paused = runtime.queuePaused();
    runtime.broadcast({ type: "queue_update", queue, paused });
    relayRuntimeBroadcastQueueStatus(runtime, paused ? "paused" : "updated");
  }

export function relayRuntimeBroadcastStatus(runtime: RelayRuntimeDelegate, message: string, level: "info" | "warn" | "error" = "info"): void {
    runtime.broadcast({ type: "status", message, level, at: new Date().toISOString() });
  }

export function relayRuntimeBroadcast(runtime: RelayRuntimeDelegate, event: RelayEvent): void {
    const prepared = runtime.prepareEvent(event);
    for (const subscriber of runtime.subscribers) {
      try {
        subscriber(prepared);
      } catch {
        runtime.subscribers.delete(subscriber);
      }
    }
    if (shouldRefreshActiveSessions(prepared)) {
      runtime.scheduleActiveSessionsBroadcast();
    }
  }

export function relayRuntimeScheduleActiveSessionsBroadcast(runtime: RelayRuntimeDelegate): void {
    if (runtime.activeSessionsBroadcastTimer) {
      return;
    }
    const delayMs = Math.max(0, 1_000 - (Date.now() - runtime.activeSessionsLastBroadcastAt));
    const poller = getObservabilityRegistry().registerPoller({
      id: "runtime:active-sessions-broadcast",
      owner: "runtime",
      kind: "active-sessions-broadcast",
      currentDelayMs: delayMs,
      nextRunAt: Date.now() + delayMs,
    });
    runtime.activeSessionsBroadcastTimer = setTimeout(() => {
      runtime.activeSessionsBroadcastTimer = null;
      runtime.activeSessionsLastBroadcastAt = Date.now();
      const finish = poller.start();
      void runtime.activeSessions()
        .then((active) => runtime.broadcast({ type: "active_sessions_update", active }))
        .then(() => {
          finish();
          poller.close();
        })
        .catch((error) => {
          finish(error);
          poller.close();
        });
    }, delayMs);
    runtime.activeSessionsBroadcastTimer.unref?.();
  }

export function relayRuntimePublicInfo(runtime: RelayRuntimeDelegate, session: AgentSessionService, options?: AgentSessionInfoOptions): AgentSessionInfo {
    const info = session.getInfo(options);
    const agentId = info.agentId ?? "codex";
    const sessionNameRecord = info.threadId ? runtime.sessionNameStore.get(agentId, info.threadId) : null;
    const metadata = runtime.listKnownContextMetadata().find((meta) => meta.contextKey === runtime.contextKey && (!info.threadId || meta.threadId === info.threadId));
    const worktree = runtime.worktreeService.getByThreadId(info.threadId) ?? runtime.worktreeService.getByWorkspace(info.workspace);
    const worktreeSnapshot = worktree ? runtime.worktreeService.snapshot(worktree) : undefined;
    return {
      ...info,
      agentId,
      agentLabel: info.agentLabel ?? agentLabel(agentId),
      sessionName: sessionNameRecord?.name,
      workspaceMode: worktreeSnapshot ? "worktree" : (info.workspaceMode ?? metadata?.workspaceMode ?? "shared"),
      worktree: worktreeSnapshot ? {
        id: worktreeSnapshot.id,
        sourceWorkspace: worktreeSnapshot.sourceWorkspace,
        repoRoot: worktreeSnapshot.repoRoot,
        baseSha: worktreeSnapshot.baseSha,
        branchName: worktreeSnapshot.branchName,
        status: worktreeSnapshot.statusText,
        dirty: worktreeSnapshot.dirty,
        commitSha: worktreeSnapshot.commitSha,
      } : info.worktree,
      capabilities: info.capabilities ?? CODEX_AGENT_CAPABILITIES,
    };
  }
