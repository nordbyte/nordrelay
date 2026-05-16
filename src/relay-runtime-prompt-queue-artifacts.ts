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
import { PromptStore, toPromptEnvelope, type PromptEnvelope, type QueuedPrompt } from "./prompt-store.js";
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

export async function relayRuntimeSendPrompt(runtime: RelayRuntimeDelegate, text: string, actor?: WebActivityActor): Promise<{ queued: boolean; queueId?: string }> {
    const trimmed = text.trim();
    if (!trimmed) {
      throw new Error("Prompt is empty.");
    }
    return runtime.sendEnvelope({ ...toPromptEnvelope(trimmed), activityActor: actor }, actor);
  }

export async function relayRuntimeSendUploadPrompt(runtime: RelayRuntimeDelegate, options: { text?: string; files: UploadPromptFile[] }, actor?: WebActivityActor): Promise<UploadPromptResult> {
    const text = options.text?.trim() ?? "";
    const files = options.files.filter((file) => file.data.byteLength > 0);
    if (!text && files.length === 0) {
      throw new Error("Prompt is empty.");
    }

    const session = await runtime.getSession(false);
    const workspace = session.getInfo().workspace;
    const turnId = randomUUID().slice(0, 12);
    const outDir = outboxPath(workspace, turnId);
    await ensureOutDir(outDir);

    const stagedFiles: StagedFile[] = [];
    const imagePaths: string[] = [];
    const transcriptParts: string[] = [];

    for (const [index, file] of files.entries()) {
      const mimeType = normalizeMimeType(file.mimeType, file.name);
      const staged = await stageFile(file.data, file.name || `upload-${index + 1}`, mimeType, {
        workspace,
        turnId,
        maxFileSize: runtime.config.maxFileSize,
      });
      stagedFiles.push(staged);

      if (mimeType.startsWith("image/")) {
        imagePaths.push(staged.localPath);
      }

      if (mimeType.startsWith("audio/")) {
        const result = await transcribeAudio(staged.localPath, {
          preferredBackend: runtime.config.voicePreferredBackend === "auto"
            ? undefined
            : runtime.config.voicePreferredBackend as TranscriptionBackend,
          language: runtime.config.voiceDefaultLanguage,
        });
        const transcript = result.text.trim();
        if (transcript) {
          transcriptParts.push(`Audio transcript (${staged.safeName}, via ${result.backend}):\n${transcript}`);
          runtime.appendActivity({
            source: "web",
            status: "completed",
            type: "voice_transcribed",
            threadId: session.getInfo().threadId,
            workspace,
            agentId: session.getInfo().agentId,
            actor,
            detail: `${staged.safeName} via ${result.backend}`,
            durationMs: result.durationMs,
          });
        }
      }
    }

    if (stagedFiles.length > 0) {
      runtime.appendActivity({
        source: "web",
        status: "info",
        type: "attachment_staged",
        threadId: session.getInfo().threadId,
        workspace,
        agentId: session.getInfo().agentId,
        actor,
        detail: `${stagedFiles.length} file(s): ${stagedFiles.map((file) => file.safeName).join(", ")}`,
      });
    }

    const audioOnly = stagedFiles.length > 0 && stagedFiles.every((file) => file.mimeType.startsWith("audio/"));
    if (runtime.config.voiceTranscribeOnly && audioOnly && !text) {
      return {
        queued: false,
        transcript: transcriptParts.join("\n\n"),
        transcribeOnly: true,
        files: uploadFileDtos(stagedFiles),
      };
    }

    const promptInput: AgentPromptObject = {};
    const textParts = [text, ...transcriptParts].filter(Boolean);
    if (textParts.length > 0) {
      promptInput.text = textParts.join("\n\n");
    }
    if (imagePaths.length > 0) {
      promptInput.imagePaths = imagePaths;
    }
    if (stagedFiles.length > 0) {
      promptInput.stagedFileInstructions = buildFileInstructions(stagedFiles, outDir);
    }

    const result = await runtime.sendEnvelope({ ...toPromptEnvelope(promptInput, outDir), activityActor: actor }, actor);
    return {
      ...result,
      transcript: transcriptParts.join("\n\n") || undefined,
      files: uploadFileDtos(stagedFiles),
    };
  }

export async function relayRuntimeSendEnvelope(runtime: RelayRuntimeDelegate, envelope: PromptEnvelope, actor?: WebActivityActor): Promise<{ queued: boolean; queueId?: string }> {
    const activityActor = envelope.activityActor ?? actor;
    const session = await runtime.getSession(false);
    const external = getExternalSnapshotForSession(session, runtime.config, { maxEvents: 0 });
    if (session.isProcessing() || external?.activity.active) {
      const queued = runtime.queueService.enqueue(envelope);
      const info = runtime.publicInfo(session);
      runtime.appendActivity({
        source: "web",
        status: "queued",
        type: "prompt_queued",
        threadId: info.threadId,
        workspace: info.workspace,
        agentId: info.agentId,
        actor: activityActor,
        prompt: envelope.description,
        detail: external?.activity.active
          ? `Queued because ${external.agentLabel} CLI is still processing another task.`
          : `Queued at position ${runtime.queueService.length()}.`,
      });
      runtime.appendAudit({
        action: "prompt_queued",
        status: "ok",
        contextKey: runtime.contextKey,
        agentId: info.agentId,
        threadId: info.threadId,
        workspace: info.workspace,
        promptId: queued.id,
        actor: activityActor,
        description: envelope.description,
      });
      if (external?.activity.active) {
        runtime.broadcastStatus(`Waiting for ${external.agentLabel} CLI task... ${runtime.queueService.length()} queued.`, "info");
      }
      runtime.broadcastQueue();
      return { queued: true, queueId: queued.id };
    }

    void runtime.runPrompt(session, { ...envelope, activityActor }).catch((error: unknown) => {
      runtime.broadcast({ type: "turn_error", id: runtime.currentTurnId ?? "turn", error: friendlyErrorText(error), at: new Date().toISOString() });
    });
    return { queued: false };
  }

export function relayRuntimeQueue(runtime: RelayRuntimeDelegate): QueueItemDto[] {
    return runtime.queueService.list();
  }

export function relayRuntimeQueuePaused(runtime: RelayRuntimeDelegate): boolean {
    return runtime.queueService.isPaused();
  }

export function relayRuntimeQueueAction(runtime: RelayRuntimeDelegate, action: RelayQueueAction, id?: string, actor?: WebActivityActor): QueueItemDto[] {
    const before = runtime.queueService.rawList();
    const affected = id ? before.find((item: QueuedPrompt) => item.id === id) : undefined;
    runtime.queueService.apply(action, id);
    if (id && action === "run") {
      void runtime.drainQueue().catch((error: unknown) => runtime.broadcastStatus(friendlyErrorText(error), "error"));
    }
    runtime.appendActivity({
      source: "web",
      status: "info",
      type: `queue_${action}`,
      threadId: null,
      workspace: runtime.config.workspace,
      actor,
      prompt: affected?.description,
      detail: id ? `${action}: ${id}` : `${action}: ${before.length} queued`,
    });
    runtime.appendAudit({
      action: "queue_updated",
      status: "ok",
      contextKey: runtime.contextKey,
      actor,
      description: id ? `${action}: ${id}` : action,
    });
    runtime.broadcastQueue();
    return runtime.queue();
  }

export async function relayRuntimeArtifacts(runtime: RelayRuntimeDelegate): Promise<ArtifactReportDto[]> {
    const session = await runtime.getSession(true);
    return runtime.artifactService.list(session.getInfo().workspace, 20);
  }

export async function relayRuntimeArtifact(runtime: RelayRuntimeDelegate, turnId: string): Promise<ArtifactTurnReport | null> {
    const session = await runtime.getSession(true);
    return runtime.artifactService.get(session.getInfo().workspace, turnId);
  }

export async function relayRuntimeDeleteArtifact(runtime: RelayRuntimeDelegate, turnId: string, actor?: WebActivityActor): Promise<boolean> {
    const session = await runtime.getSession(true);
    const info = runtime.publicInfo(session);
    const removed = await runtime.artifactService.delete(info.workspace, turnId);
    runtime.appendActivity({
      source: "web",
      status: removed ? "info" : "failed",
      type: "artifact_deleted",
      threadId: info.threadId,
      workspace: info.workspace,
      agentId: info.agentId,
      actor,
      detail: turnId,
    });
    return removed;
  }

export async function relayRuntimeCreateArtifactZip(runtime: RelayRuntimeDelegate, turnId: string, actor?: WebActivityActor): Promise<{ path: string; name: string } | null> {
    const session = await runtime.getSession(true);
    const info = runtime.publicInfo(session);
    const zip = await runtime.artifactService.createZip(info.workspace, turnId);
    if (zip) {
      runtime.appendActivity({
        source: "web",
        status: "info",
        type: "artifact_zip_created",
        threadId: info.threadId,
        workspace: info.workspace,
        agentId: info.agentId,
        actor,
        detail: zip.name,
      });
    }
    return zip;
  }

export async function relayRuntimeArtifactPreview(runtime: RelayRuntimeDelegate, turnId: string, relativePath: string): Promise<ArtifactPreviewDto | null> {
    const session = await runtime.getSession(true);
    return runtime.artifactService.preview(session.getInfo().workspace, turnId, relativePath);
  }

export async function relayRuntimeEnsureActiveThread(runtime: RelayRuntimeDelegate, session: AgentSessionService): Promise<void> {
    if (!session.hasActiveThread()) {
      await session.newThread();
      runtime.updateSession(session);
    }
  }

export function relayRuntimeEnsureIdle(runtime: RelayRuntimeDelegate, session: AgentSessionService): void {
    if (session.isProcessing()) {
      throw new Error("The active session is still processing a turn.");
    }
  }

export async function relayRuntimeRunPrompt(runtime: RelayRuntimeDelegate, session: AgentSessionService, envelope: PromptEnvelope): Promise<void> {
    const workspacePolicy = evaluateWorkspacePolicy(session.getInfo().workspace, runtime.config);
    if (!workspacePolicy.allowed) {
      throw new Error(workspacePolicy.warning ?? "Current workspace is blocked by policy.");
    }
    try {
      await runtime.turnService.run(session, envelope);
    } finally {
      await runtime.drainQueue();
    }
  }

export async function relayRuntimeDrainQueue(runtime: RelayRuntimeDelegate): Promise<void> {
    if (runtime.draining || runtime.queueService.isPaused()) {
      return;
    }
    runtime.draining = true;
    try {
      const session = await runtime.getSession(false);
      while (!session.isProcessing()) {
        const external = getExternalSnapshotForSession(session, runtime.config, { maxEvents: 0 });
        if (external?.activity.active) {
          runtime.broadcastStatus(`Waiting for ${external.agentLabel} CLI task... ${runtime.queueService.length()} queued.`, "info");
          return;
        }
        const next = runtime.queueService.dequeue();
        runtime.broadcastQueue();
        if (!next) {
          return;
        }
        await runtime.runPrompt(session, next);
      }
    } finally {
      runtime.draining = false;
    }
  }

export function relayRuntimeUpdateSession(runtime: RelayRuntimeDelegate, session: AgentSessionService): void {
    runtime.registry.updateMetadata(runtime.contextKey, session);
    runtime.broadcast({ type: "session_update", session: runtime.publicInfo(session) });
  }
