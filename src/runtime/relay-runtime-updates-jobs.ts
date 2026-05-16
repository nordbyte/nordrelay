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
import { cursorPage, normalizeCursorLimit } from "../core/pagination.js";
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

export function relayRuntimeUpdateConnector(runtime: RelayRuntimeDelegate, actor?: WebActivityActor): ReturnType<typeof spawnSelfUpdate> {
    runtime.dashboardService.invalidate("version");
    const update = spawnSelfUpdate();
    runtime.broadcastStatus(`Update started with ${update.method}. Log: ${update.logPath}`, "warn");
    runtime.appendActivity({
      source: "web",
      status: "info",
      type: "update_started",
      threadId: null,
      workspace: runtime.config.workspace,
      actor,
      detail: `${update.method}: ${update.summary}`,
    });
    runtime.appendAudit({
      action: "command",
      status: "ok",
      contextKey: runtime.contextKey,
      actor,
      description: "update",
      detail: update.summary,
    });
    return update;
  }

export function relayRuntimeAgentUpdateJobs(runtime: RelayRuntimeDelegate): AgentUpdateJobSnapshot[] {
    return runtime.agentUpdates.list();
  }

export function relayRuntimeStartAgentUpdate(runtime: RelayRuntimeDelegate, agentId: AgentId, operation: AgentUpdateOperation = "update", actor?: WebActivityActor): AgentUpdateJobSnapshot {
    runtime.dashboardService.invalidate("adapterHealth");
    runtime.dashboardService.invalidate("version");
    const job = runtime.agentUpdates.start(agentId, {
      piCliPath: runtime.config.piCliPath,
      hermesCliPath: runtime.config.hermesCliPath,
      openClawCliPath: runtime.config.openClawCliPath,
      claudeCodeCliPath: runtime.config.claudeCodeCliPath,
    }, operation);
    if (actor) {
      runtime.agentUpdateActors.set(job.id, actor);
    }
    runtime.agentUpdateStates.set(job.id, { status: job.status, needsInput: job.needsInput });
    runtime.broadcastStatus(`${job.agentLabel} ${operation} started. Log: ${job.logPath}`, "warn");
    runtime.appendActivity({
      source: "web",
      status: "info",
      type: operation === "install" ? "agent_install_started" : "agent_update_started",
      agentId,
      threadId: null,
      workspace: runtime.config.workspace,
      actor,
      detail: `${job.method}: ${job.summary}`,
    });
    runtime.appendAudit({
      action: "command",
      status: "ok",
      contextKey: runtime.contextKey,
      agentId,
      actor,
      description: `${operation} ${agentId}`,
      detail: job.summary,
    });
    return job;
  }

export function relayRuntimeAgentUpdateLog(runtime: RelayRuntimeDelegate, id: string): ReturnType<AgentUpdateManager["readLog"]> {
    return runtime.agentUpdates.readLog(id);
  }

export function relayRuntimeDeleteAgentUpdateLog(runtime: RelayRuntimeDelegate, id: string, actor?: WebActivityActor): AgentUpdateJobSnapshot {
    const job = runtime.agentUpdates.deleteLog(id);
    runtime.appendActivity({
      source: "web",
      status: "info",
      type: "agent_update_log_deleted",
      agentId: job.agentId,
      threadId: null,
      workspace: runtime.config.workspace,
      actor,
      detail: job.logPath,
    });
    runtime.appendAudit({
      action: "command",
      status: "ok",
      contextKey: runtime.contextKey,
      agentId: job.agentId,
      actor,
      description: `delete update log ${id}`,
      detail: job.logPath,
    });
    return job;
  }

export function relayRuntimeSendAgentUpdateInput(runtime: RelayRuntimeDelegate, id: string, input: string, actor?: WebActivityActor): AgentUpdateJobSnapshot {
    const job = runtime.agentUpdates.sendInput(id, input);
    runtime.appendActivity({
      source: "web",
      status: "info",
      type: "agent_update_input_sent",
      agentId: job.agentId,
      threadId: null,
      workspace: runtime.config.workspace,
      actor: actor ?? runtime.agentUpdateActors.get(id),
      detail: `Input sent to ${job.agentLabel} ${job.operation}.`,
    });
    return job;
  }

export function relayRuntimeCancelAgentUpdate(runtime: RelayRuntimeDelegate, id: string, actor?: WebActivityActor): AgentUpdateJobSnapshot {
    const job = runtime.agentUpdates.cancel(id);
    runtime.appendActivity({
      source: "web",
      status: "aborted",
      type: "agent_update_cancel_requested",
      agentId: job.agentId,
      threadId: null,
      workspace: runtime.config.workspace,
      actor: actor ?? runtime.agentUpdateActors.get(id),
      detail: `${job.agentLabel} ${job.operation} cancellation requested.`,
    });
    return job;
  }

export function relayRuntimeTasks(runtime: RelayRuntimeDelegate): WebTasksDto {
    return {
      current: runtime.currentProgress ? { ...runtime.currentProgress, tools: [...runtime.currentProgress.tools] } : null,
      external: runtime.externalActivityMonitor.task(),
      queue: runtime.queue(),
      queuePaused: runtime.queuePaused(),
      recent: runtime.activity({ limit: 20 }),
    };
  }

export async function relayRuntimeJobs(runtime: RelayRuntimeDelegate, options: { limit?: number; cursor?: string } = {}): Promise<UnifiedJobsDto> {
    const jobs: UnifiedJobDto[] = [];
    const current = runtime.currentProgress;
    if (current) {
      jobs.push(taskToUnifiedJob("web:current", "web-turn", "Current WebUI turn", current, {
        canCancel: current.status === "running",
        canRetry: false,
        canReadLog: false,
      }));
    }

    const external = runtime.externalActivityMonitor.task();
    if (external) {
      jobs.push(taskToUnifiedJob(`external:${external.agentId ?? "agent"}:${external.threadId ?? "pending"}`, "external-turn", "External CLI turn", external, {
        canCancel: false,
        canRetry: false,
        canReadLog: false,
      }));
    }

    for (const item of runtime.queueService.rawList()) {
      const createdAt = new Date(item.createdAt).toISOString();
      jobs.push({
        id: `queue:${item.id}`,
        kind: "queued-prompt",
        title: `Queued prompt ${item.id}`,
        status: "queued",
        source: "web",
        threadId: null,
        workspace: runtime.config.workspace,
        owner: item.activityActor,
        correlationId: item.correlationId,
        startedAt: createdAt,
        updatedAt: createdAt,
        summary: item.description,
        queueId: item.id,
        logTail: item.lastError,
        canCancel: true,
        canRetry: true,
        canReadLog: true,
      });
    }

    for (const job of runtime.agentUpdates.list()) {
      jobs.push({
        id: `agent-update:${job.id}`,
        kind: "agent-update",
        title: `${job.agentLabel} ${job.operation}`,
        status: agentUpdateStatusToUnified(job.status),
        source: "web",
        agentId: job.agentId,
        agentLabel: job.agentLabel,
        threadId: null,
        workspace: runtime.config.workspace,
        owner: runtime.agentUpdateActors.get(job.id),
        startedAt: job.startedAt,
        updatedAt: job.updatedAt,
        finishedAt: job.finishedAt,
        summary: job.error || job.summary,
        logPath: job.logPath,
        logTail: job.outputTail,
        updateJobId: job.id,
        canCancel: job.status === "running",
        canRetry: job.status !== "running",
        canReadLog: true,
      });
    }

    for (const event of runtime.activity({ limit: 100 })) {
      if (event.type === "diagnostics_bundle_exported") {
        jobs.push(activityToUnifiedJob(event, "support-bundle", "Diagnostics support bundle", {
          canCancel: false,
          canRetry: true,
          canReadLog: Boolean(event.detail),
        }));
      } else if (event.type === "update_started") {
        jobs.push(activityToUnifiedJob(event, "connector-update", "NordRelay update", {
          canCancel: false,
          canRetry: true,
          canReadLog: Boolean(event.detail),
        }));
      } else if (event.category === "prompt" && event.type.startsWith("prompt_")) {
        jobs.push(promptActivityToUnifiedJob(event));
      }
    }

    const liveJobs = dedupeJobs(jobs);
    const storedJobs = runtime.jobStore.upsertMany(liveJobs);
    const sortedJobs = dedupeJobs([...liveJobs, ...storedJobs]).sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
    const limit = normalizeCursorLimit(options.limit, 100, 500);
    const page = cursorPage(sortedJobs, options.cursor, limit, (job) => job.id);
    return {
      jobs: page.items,
      pagination: page.pagination,
      updatedAt: new Date().toISOString(),
    };
  }

export async function relayRuntimeJobLog(runtime: RelayRuntimeDelegate, id: string): Promise<{ job: UnifiedJobDto | null; plain: string }> {
    if (id.startsWith("agent-update:")) {
      const updateId = id.slice("agent-update:".length);
      const log = runtime.agentUpdates.readLog(updateId);
      return { job: (await runtime.jobs({ limit: 500 })).jobs.find((job) => job.id === id) ?? null, plain: log.plain };
    }
    if (id.startsWith("queue:")) {
      const queueId = id.slice("queue:".length);
      const item = runtime.queueService.rawList().find((candidate: { id: string }) => candidate.id === queueId);
      return {
        job: (await runtime.jobs({ limit: 500 })).jobs.find((job) => job.id === id) ?? null,
        plain: item ? [
          `Queued prompt: ${item.id}`,
          `Created: ${new Date(item.createdAt).toISOString()}`,
          `Attempts: ${item.attempts ?? 0}`,
          `Description: ${item.description}`,
          item.lastError ? `Last error: ${item.lastError}` : "",
        ].filter(Boolean).join("\n") : "Queued prompt not found.",
      };
    }
    if (id.startsWith("workflow-run:")) {
      const runId = id.slice("workflow-run:".length);
      const run = runtime.workflowStore.getRun(runId);
      return {
        job: (await runtime.jobs({ limit: 500 })).jobs.find((job) => job.id === id) ?? null,
        plain: run ? [
          `Workflow run: ${run.name}`,
          `Status: ${run.status}`,
          `Created: ${run.createdAt}`,
          run.startedAt ? `Started: ${run.startedAt}` : "",
          run.finishedAt ? `Finished: ${run.finishedAt}` : "",
          run.error ? `Error: ${run.error}` : "",
          "",
          ...run.steps.map((step, index) => [
            `${index + 1}. ${step.name}: ${step.status}`,
            step.correlationId ? `   Correlation: ${step.correlationId}` : "",
            step.error ? `   Error: ${step.error}` : "",
            step.prompt ? `   Prompt: ${step.prompt}` : "",
          ].filter(Boolean).join("\n")),
        ].filter(Boolean).join("\n") : "Workflow run not found.",
      };
    }
    const job = (await runtime.jobs({ limit: 500 })).jobs.find((candidate) => candidate.id === id) ?? null;
    return { job, plain: job?.logTail || job?.logPath || job?.summary || runtime.jobStore.get(id)?.summary || "No log available for this job." };
  }

export async function relayRuntimeJobAction(runtime: RelayRuntimeDelegate, id: string, action: "cancel" | "retry", actor?: WebActivityActor): Promise<UnifiedJobsDto> {
    if (id === "web:current" && action === "cancel") {
      await runtime.abort(actor);
      return runtime.jobs();
    }
    if (id.startsWith("queue:")) {
      const queueId = id.slice("queue:".length);
      runtime.queueService.apply(action === "cancel" ? "cancel" : "run", queueId);
      runtime.jobStore.patch(id, {
        status: action === "cancel" ? "aborted" : "queued",
        summary: action === "cancel" ? `Cancelled queued prompt ${queueId}.` : `Queued prompt ${queueId} moved to the front.`,
        canCancel: action !== "cancel",
        canRetry: action === "cancel",
        finishedAt: action === "cancel" ? new Date().toISOString() : undefined,
      });
      runtime.broadcast({ type: "queue_update", queue: runtime.queue(), paused: runtime.queuePaused() });
      runtime.appendActivity({
        source: "web",
        status: action === "cancel" ? "aborted" : "queued",
        type: action === "cancel" ? "job_cancelled" : "job_retried",
        threadId: null,
        workspace: runtime.config.workspace,
        actor,
        detail: `queue:${queueId}`,
      });
      if (action === "retry") {
        void runtime.drainQueue();
      }
      return runtime.jobs();
    }
    if (id.startsWith("agent-update:")) {
      const updateId = id.slice("agent-update:".length);
      const current = runtime.agentUpdates.get(updateId);
      if (!current) {
        throw new Error("Unknown agent update job.");
      }
      if (action === "cancel") {
        runtime.cancelAgentUpdate(updateId, actor);
      } else {
        runtime.startAgentUpdate(current.agentId, current.operation, actor);
      }
      return runtime.jobs();
    }
    if (id.startsWith("workflow-run:")) {
      const runId = id.slice("workflow-run:".length);
      if (action === "cancel") {
        await runtime.workflowService.cancelRun(runId, actor);
      } else {
        const run = runtime.workflowStore.getRun(runId);
        if (run?.status === "paused") {
          runtime.workflowService.resumeRun(runId, actor);
        } else if (run?.workflowId) {
          runtime.workflowService.runWorkflow(run.workflowId, run.variables, actor);
        } else if (run?.templateId) {
          await runtime.workflowService.runTemplate(run.templateId, run.variables, actor);
        } else {
          throw new Error("Workflow run cannot be retried.");
        }
      }
      return runtime.jobs();
    }
    if (id.startsWith("support-bundle:") && action === "retry") {
      await runtime.supportBundle(actor);
      return runtime.jobs();
    }
    if (id.startsWith("connector-update:") && action === "retry") {
      runtime.updateConnector(actor);
      return runtime.jobs();
    }
    throw new Error(`Unsupported job action: ${action} ${id}`);
  }

export function relayRuntimeRecordAgentUpdateLifecycle(runtime: RelayRuntimeDelegate, job: AgentUpdateJobSnapshot): void {
    const previous = runtime.agentUpdateStates.get(job.id);
    const actor = runtime.agentUpdateActors.get(job.id);
    if (job.needsInput && !previous?.needsInput) {
      runtime.appendActivity({
        source: "web",
        status: "info",
        type: "agent_update_input_required",
        agentId: job.agentId,
        threadId: null,
        workspace: runtime.config.workspace,
        actor,
        detail: `${job.agentLabel} ${job.operation} may require input.`,
      });
    }
    if (job.status !== "running" && previous?.status === "running") {
      runtime.appendActivity({
        source: "web",
        status: job.status === "completed" ? "completed" : job.status === "cancelled" ? "aborted" : "failed",
        type: job.operation === "install" ? `agent_install_${job.status}` : `agent_update_${job.status}`,
        agentId: job.agentId,
        threadId: null,
        workspace: runtime.config.workspace,
        actor,
        detail: job.error ?? `${job.agentLabel} ${job.operation} ${job.status}.`,
        durationMs: Math.max(0, Date.parse(job.finishedAt ?? job.updatedAt) - Date.parse(job.startedAt)),
      });
      runtime.agentUpdateActors.delete(job.id);
    }
    runtime.agentUpdateStates.set(job.id, { status: job.status, needsInput: job.needsInput });
  }
