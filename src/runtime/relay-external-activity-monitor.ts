import {
  type AgentExternalSnapshot,
  type AgentApprovalRequest,
  type AgentSessionInfo,
  type AgentSessionService,
} from "../agents/shared/agent.js";
import { getExternalSnapshotForSession } from "../agents/shared/agent-activity.js";
import type { ChannelMirrorMode } from "../state/bot-preferences.js";
import {
  renderExternalMirrorEvent,
  renderExternalMirrorStatus,
  renderExternalApprovalRequest,
  trimLine,
} from "../channels/shared/bot-rendering.js";
import type { ConnectorConfig } from "../core/config.js";
import { friendlyErrorText } from "../core/error-messages.js";
import type {
  ExternalMirrorState,
  RelayEvent,
  WebTaskDto,
} from "./relay-runtime-types.js";
import type { ArtifactProvenance } from "../artifacts/artifacts.js";
import {
  type WebActivityEvent,
  type WebActivityActor,
  type WebChatMessage,
  type WebChatStore,
} from "../web/web-state.js";
import { isExternalSnapshotSuppressedByManagedAbort } from "./relay-runtime-helpers.js";

const CLI_ACTIVITY_ACTOR: WebActivityActor = {
  channel: "cli",
  label: "CLI",
};

export interface RelayExternalActivityMonitorOptions {
  config: ConnectorConfig;
  getSession: () => Promise<AgentSessionService>;
  publicInfo: (session: AgentSessionService) => AgentSessionInfo;
  queueLength: () => number;
  mirrorMode: () => ChannelMirrorMode;
  mirrorMinUpdateMs: () => number;
  chatStore: WebChatStore;
  chatHistory: () => Promise<WebChatMessage[]>;
  activity: (threadId: string) => WebActivityEvent[];
  persistWorkspaceArtifactsForTurn: (workspace: string, turnId: string, startedAt: Date, provenance?: ArtifactProvenance) => Promise<void>;
  drainQueue: () => Promise<void>;
  appendActivity: (input: Omit<WebActivityEvent, "id" | "timestamp"> & { timestamp?: string }) => WebActivityEvent;
  broadcast: (event: RelayEvent) => void;
  broadcastStatus: (message: string, level?: "info" | "warn" | "error") => void;
  scheduleActiveSessionsBroadcast: () => void;
}

export class RelayExternalActivityMonitor {
  private mirror: ExternalMirrorState | null = null;
  private running = false;
  private readonly ignoredTurns = new Set<string>();

  constructor(private readonly options: RelayExternalActivityMonitorOptions) {}

  snapshot(): ExternalMirrorState | null {
    return this.mirror ? { ...this.mirror } : null;
  }

  reset(): void {
    this.mirror = null;
  }

  task(): WebTaskDto | null {
    if (!this.mirror) {
      return null;
    }
    const startedAt = this.mirror.startedAt instanceof Date
      ? this.mirror.startedAt.toISOString()
      : this.mirror.startedAt ?? new Date().toISOString();
    const startedMs = new Date(startedAt).getTime();
    return {
      id: this.mirror.turnId ?? "cli",
      source: "cli",
      status: this.mirror.latestStatus?.includes("failed")
        ? "failed"
        : this.mirror.latestStatus?.includes("aborted")
          ? "aborted"
          : this.mirror.latestStatus?.includes("finished") || this.mirror.latestStatus?.includes("completed")
            ? "completed"
            : "running",
      threadId: this.mirror.threadId,
      startedAt,
      updatedAt: new Date().toISOString(),
      durationMs: Number.isFinite(startedMs) ? Math.max(0, Date.now() - startedMs) : 0,
      outputChars: 0,
      tools: [],
      detail: this.mirror.latestStatus ?? this.mirror.rolloutPath,
    };
  }

  async monitorSafe(): Promise<boolean> {
    if (this.running) {
      return false;
    }
    this.running = true;
    try {
      return await this.monitor();
    } catch (error) {
      this.options.broadcastStatus(friendlyErrorText(error), "error");
      return false;
    } finally {
      this.running = false;
    }
  }

  private async monitor(): Promise<boolean> {
    const session = await this.options.getSession();
    const info = this.options.publicInfo(session);
    if (!info.capabilities.externalActivity || !info.threadId || session.isProcessing()) {
      return false;
    }

    const snapshot = getExternalSnapshotForSession(session, this.options.config, {
      afterLine: this.mirror?.threadId === info.threadId ? this.mirror.lastLine : Number.MAX_SAFE_INTEGER,
    }) ?? getExternalSnapshotForSession(session, this.options.config, {
      maxEvents: 0,
    });
    if (!snapshot) {
      return false;
    }

    if (!this.mirror || this.mirror.threadId !== snapshot.threadId || this.mirror.rolloutPath !== snapshot.sourcePath) {
      this.mirror = {
        threadId: snapshot.threadId,
        rolloutPath: snapshot.sourcePath,
        lastLine: snapshot.lineCount,
        turnId: snapshot.activity.turnId,
        startedAt: snapshot.activity.startedAt?.toISOString() ?? null,
      };
      if (snapshot.activity.active) {
        if (await this.shouldIgnoreExternalTurn(snapshot)) {
          this.ignoredTurns.add(externalTurnKey(snapshot));
          this.mirror.lastLine = Math.max(this.mirror.lastLine, snapshot.lineCount);
          return true;
        }
        await this.startExternalTurn(snapshot, info);
        await this.handlePendingApprovals(snapshot, info, this.mirror);
      }
      return snapshot.activity.active;
    }

    const mirror = this.mirror;
    if (snapshot.activity.active) {
      if (mirror.turnId !== snapshot.activity.turnId) {
        mirror.turnId = snapshot.activity.turnId;
        mirror.startedAt = snapshot.activity.startedAt?.toISOString() ?? null;
        mirror.latestAgentLine = undefined;
        mirror.latestStatusAt = undefined;
        mirror.latestMirroredEventLine = undefined;
        if (await this.shouldIgnoreExternalTurn(snapshot)) {
          this.ignoredTurns.add(externalTurnKey(snapshot));
          mirror.lastLine = Math.max(mirror.lastLine, snapshot.lineCount);
          return true;
        }
        await this.startExternalTurn(snapshot, info);
      }
      if (this.ignoredTurns.has(externalTurnKey(snapshot))) {
        mirror.lastLine = Math.max(mirror.lastLine, snapshot.lineCount);
        return true;
      }
      const mirrorMode = this.options.mirrorMode();
      const newEvents = snapshot.events.filter((event) => event.lineNumber > mirror.lastLine);
      this.broadcastExternalEvents(snapshot, newEvents, info, mirrorMode === "full");
      await this.handlePendingApprovals(snapshot, info, mirror);
      if (mirrorMode === "full") {
        await this.appendExternalEventMessages(snapshot, newEvents, mirror);
      }
      mirror.lastLine = Math.max(mirror.lastLine, snapshot.lineCount);
      mirror.latestStatus = externalStatusLine(snapshot, this.options.queueLength());
      if (mirrorMode === "status" || mirrorMode === "full") {
        await this.updateExternalStatusMessage(snapshot, mirror);
      }
      if (mirrorMode !== "off") {
        this.options.broadcastStatus(mirror.latestStatus, "info");
      }
      this.options.scheduleActiveSessionsBroadcast();
      return true;
    }

    const terminalEvent = [...snapshot.events].reverse().find((event) => event.kind === "task" && event.status && event.status !== "started");
    if (this.ignoredTurns.has(externalTurnKey(snapshot))) {
      if (terminalEvent && terminalEvent.lineNumber > mirror.lastLine) {
        this.ignoredTurns.delete(externalTurnKey(snapshot));
        this.options.scheduleActiveSessionsBroadcast();
        await this.options.drainQueue();
      }
      mirror.lastLine = Math.max(mirror.lastLine, snapshot.lineCount);
      return false;
    }
    if (terminalEvent && terminalEvent.lineNumber > mirror.lastLine) {
      const mirrorMode = this.options.mirrorMode();
      const finalAgent = snapshot.events.filter((event) => event.kind === "agent" && event.text).at(-1);
      const finalText = finalAgent?.text ?? snapshot.latestAgentMessage;
      const finalLine = finalAgent?.lineNumber ?? snapshot.lineCount;
      if ((mirrorMode === "final" || mirrorMode === "full") && finalText && finalLine !== mirror.latestAgentLine) {
        this.options.chatStore.appendWithResult({
          threadId: snapshot.threadId,
          role: "agent",
          text: finalText,
          source: "cli",
          correlationId: externalCorrelationId(snapshot),
          turnId: terminalEvent.turnId ?? undefined,
          key: externalMessageKey("final", snapshot, terminalEvent.lineNumber),
        });
        mirror.latestAgentLine = finalLine;
      }
      const externalStartedAt = mirror.startedAt ? new Date(mirror.startedAt) : snapshot.activity.startedAt;
      if (mirrorMode !== "off") {
        this.options.broadcast({
          type: "turn_complete",
          id: terminalEvent.turnId ?? "cli",
          at: terminalEvent.timestamp?.toISOString() ?? new Date().toISOString(),
          correlationId: externalCorrelationId(snapshot),
        });
      }
      this.options.appendActivity({
        source: "cli",
        status: terminalEvent.status === "aborted" ? "aborted" : terminalEvent.status === "failed" ? "failed" : "completed",
        type: "cli_turn_finished",
        threadId: snapshot.threadId,
        workspace: info.workspace,
        agentId: info.agentId,
        actor: CLI_ACTIVITY_ACTOR,
        correlationId: externalCorrelationId(snapshot),
        prompt: snapshot.latestUserMessage ?? undefined,
        detail: `${snapshot.agentLabel} CLI task ${terminalEvent.status ?? "finished"}.`,
        durationMs: durationFromDates(externalStartedAt, terminalEvent.timestamp),
      });
      if (externalStartedAt && terminalEvent.turnId) {
        await this.options.persistWorkspaceArtifactsForTurn(info.workspace, terminalEvent.turnId, externalStartedAt, {
          source: "cli",
          agentId: info.agentId,
          threadId: snapshot.threadId,
          workspace: info.workspace,
          contextKey: `cli:${snapshot.threadId}`,
          correlationId: externalCorrelationId(snapshot),
          prompt: snapshot.latestUserMessage ?? undefined,
          actor: CLI_ACTIVITY_ACTOR,
          turnStartedAt: externalStartedAt.toISOString(),
        });
      }
      mirror.latestStatus = `${snapshot.agentLabel} CLI task ${terminalEvent.status ?? "finished"}.`;
      if (mirrorMode === "status" || mirrorMode === "full") {
        await this.updateExternalStatusMessage(snapshot, mirror, mirror.latestStatus);
      }
      if (mirrorMode !== "off") {
        this.options.broadcastStatus(
          `${snapshot.agentLabel} CLI task ${terminalEvent.status ?? "finished"}.`,
          terminalEvent.status === "failed" ? "error" : terminalEvent.status === "aborted" ? "warn" : "info",
        );
      }
      await this.broadcastChatHistory();
      this.options.scheduleActiveSessionsBroadcast();
      await this.options.drainQueue();
    }
    mirror.lastLine = Math.max(mirror.lastLine, snapshot.lineCount);
    return false;
  }

  private async startExternalTurn(snapshot: AgentExternalSnapshot, info: AgentSessionInfo): Promise<void> {
    const prompt = snapshot.latestUserMessage ?? `${snapshot.agentLabel} CLI task`;
    const mode = this.options.mirrorMode();
    let broadcastedChatHistory = false;
    if (mode === "final" || mode === "full") {
      this.options.chatStore.appendWithResult({
        threadId: snapshot.threadId,
        role: "system",
        text: `Working on ${trimLine(prompt, 500)}`,
        source: "cli",
        correlationId: externalCorrelationId(snapshot),
        turnId: snapshot.activity.turnId ?? undefined,
        timestamp: snapshot.activity.startedAt?.toISOString(),
        key: externalMessageKey("working", snapshot),
      });
      await this.broadcastChatHistory();
      broadcastedChatHistory = true;
    }
    if (!broadcastedChatHistory) {
      await this.broadcastChatHistory();
    }
    if ((mode === "status" || mode === "full") && this.mirror) {
      await this.updateExternalStatusMessage(snapshot, this.mirror);
    }
    this.options.appendActivity({
      source: "cli",
      status: "running",
      type: "cli_turn_started",
      threadId: snapshot.threadId,
      workspace: info.workspace,
      agentId: info.agentId,
      actor: CLI_ACTIVITY_ACTOR,
      correlationId: externalCorrelationId(snapshot),
      prompt,
      detail: `${snapshot.sourceLabel}: ${snapshot.sourcePath}`,
    });
  }

  private async shouldIgnoreExternalTurn(snapshot: AgentExternalSnapshot): Promise<boolean> {
    if (this.ignoredTurns.has(externalTurnKey(snapshot))) {
      return true;
    }
    if (isExternalSnapshotSuppressedByManagedAbort(snapshot, this.options.activity(snapshot.threadId))) {
      return true;
    }
    const startedAtMs = snapshot.activity.startedAt?.getTime();
    if (!Number.isFinite(startedAtMs)) {
      return false;
    }
    const recentChannelUserMessage = (await this.options.chatHistory()).some((message) => {
      if (message.threadId !== snapshot.threadId || message.role !== "user" || message.source === "cli") {
        return false;
      }
      const messageAtMs = Date.parse(message.timestamp);
      return Number.isFinite(messageAtMs) && Math.abs(messageAtMs - startedAtMs!) <= 45_000;
    });
    return recentChannelUserMessage;
  }

  private broadcastExternalEvents(snapshot: AgentExternalSnapshot, events: AgentExternalSnapshot["events"], info: AgentSessionInfo, broadcastTools: boolean): void {
    for (const event of events) {
      if (event.kind === "tool" && event.status === "started") {
        if (broadcastTools) {
          this.options.broadcast({
            type: "tool_start",
            id: snapshot.activity.turnId ?? "cli",
            toolCallId: `cli-${event.lineNumber}`,
            toolName: event.toolName ?? "tool",
            correlationId: externalCorrelationId(snapshot),
          });
        }
        this.options.appendActivity({
          source: "cli",
          status: "running",
          type: "cli_tool_started",
          threadId: snapshot.threadId,
          workspace: info.workspace,
          agentId: info.agentId,
          actor: CLI_ACTIVITY_ACTOR,
          correlationId: externalCorrelationId(snapshot),
          detail: event.toolName ?? "tool",
        });
      }
      if (event.kind === "tool" && event.status === "finished") {
        if (broadcastTools) {
          this.options.broadcast({
            type: "tool_end",
            id: snapshot.activity.turnId ?? "cli",
            toolCallId: `cli-${event.lineNumber}`,
            isError: false,
            correlationId: externalCorrelationId(snapshot),
          });
        }
        this.options.appendActivity({
          source: "cli",
          status: "completed",
          type: "cli_tool_completed",
          threadId: snapshot.threadId,
          workspace: info.workspace,
          agentId: info.agentId,
          actor: CLI_ACTIVITY_ACTOR,
          correlationId: externalCorrelationId(snapshot),
          detail: event.toolName ?? "tool",
        });
      }
      if (event.kind === "tool" && event.status === "failed") {
        if (broadcastTools) {
          this.options.broadcast({
            type: "tool_end",
            id: snapshot.activity.turnId ?? "cli",
            toolCallId: `cli-${event.lineNumber}`,
            isError: true,
            correlationId: externalCorrelationId(snapshot),
          });
        }
        this.options.appendActivity({
          source: "cli",
          status: "failed",
          type: "cli_tool_failed",
          threadId: snapshot.threadId,
          workspace: info.workspace,
          agentId: info.agentId,
          actor: CLI_ACTIVITY_ACTOR,
          detail: event.toolName ?? "tool",
        });
      }
    }
  }

  private async appendExternalEventMessages(snapshot: AgentExternalSnapshot, events: AgentExternalSnapshot["events"], mirror: ExternalMirrorState): Promise<void> {
    let changed = false;
    for (const event of events) {
      if (event.lineNumber <= (mirror.latestMirroredEventLine ?? mirror.lastLine)) {
        continue;
      }
      const rendered = renderExternalMirrorEvent(event);
      if (!rendered) {
        continue;
      }
      const stored = this.options.chatStore.appendWithResult({
        threadId: snapshot.threadId,
        role: event.kind === "tool" ? "tool" : "system",
        text: rendered.plain,
        source: "cli",
        correlationId: externalCorrelationId(snapshot),
        turnId: event.turnId ?? snapshot.activity.turnId ?? undefined,
        timestamp: event.timestamp?.toISOString(),
        key: externalMessageKey("event", snapshot, event.lineNumber),
      });
      changed = changed || stored.inserted;
      mirror.latestMirroredEventLine = event.lineNumber;
    }
    if (changed) {
      await this.broadcastChatHistory();
    }
  }

  private async updateExternalStatusMessage(snapshot: AgentExternalSnapshot, mirror: ExternalMirrorState, text?: string): Promise<void> {
    const now = Date.now();
    const minInterval = this.options.mirrorMinUpdateMs();
    if (!text && mirror.latestStatusAt && now - mirror.latestStatusAt < minInterval) {
      return;
    }
    const stored = this.options.chatStore.appendWithResult({
      threadId: snapshot.threadId,
      role: "system",
      text: text ?? renderExternalMirrorStatus(snapshot, this.options.queueLength()).plain,
      source: "cli",
      correlationId: externalCorrelationId(snapshot),
      turnId: snapshot.activity.turnId ?? undefined,
      key: externalMessageKey(text ? "status-terminal" : "status", snapshot, snapshot.lineCount),
    });
    mirror.latestStatusAt = now;
    if (stored.inserted) {
      await this.broadcastChatHistory();
    }
  }

  private async handlePendingApprovals(
    snapshot: AgentExternalSnapshot,
    info: AgentSessionInfo,
    mirror: ExternalMirrorState | null,
  ): Promise<void> {
    const approvals = snapshot.pendingApprovals ?? [];
    if (!approvals.length) {
      return;
    }
    if (!mirror) {
      return;
    }
    const seen = new Set(mirror.approvalRequestIds ?? []);
    let changed = false;
    for (const approval of approvals) {
      const rendered = renderExternalApprovalRequest(snapshot.agentLabel, approval);
      const result = this.options.chatStore.upsertByKey({
        threadId: snapshot.threadId,
        role: "system",
        text: rendered.plain,
        source: "cli",
        correlationId: externalCorrelationId(snapshot),
        turnId: approval.turnId ?? snapshot.activity.turnId ?? undefined,
        timestamp: approval.requestedAt?.toISOString(),
        key: externalMessageKey("approval", snapshot, approval.lineNumber),
        actions: approvalActions(approval),
      });
      changed = changed || result.inserted || result.updated;
      if (!seen.has(approval.id)) {
        this.options.appendActivity({
          source: "cli",
          status: "running",
          type: "cli_action_required",
          threadId: snapshot.threadId,
          workspace: info.workspace,
          agentId: info.agentId,
          actor: CLI_ACTIVITY_ACTOR,
          correlationId: externalCorrelationId(snapshot),
          prompt: snapshot.latestUserMessage ?? undefined,
          detail: `${approval.toolName}: ${approval.command}`,
        });
        seen.add(approval.id);
      }
    }
    mirror.approvalRequestIds = [...seen].slice(-50);
    if (changed) {
      await this.broadcastChatHistory();
    }
  }

  private async broadcastChatHistory(): Promise<void> {
    this.options.broadcast({ type: "chat_history", messages: await this.options.chatHistory() });
  }
}

function externalMessageKey(kind: string, snapshot: AgentExternalSnapshot, lineNumber?: number): string {
  return [
    "external",
    kind,
    snapshot.agentId,
    snapshot.threadId,
    snapshot.activity.turnId ?? "turn",
    lineNumber ?? "",
  ].join(":");
}

function externalTurnKey(snapshot: AgentExternalSnapshot): string {
  return [
    snapshot.agentId,
    snapshot.threadId,
    snapshot.activity.turnId ?? "turn",
  ].join(":");
}

function externalCorrelationId(snapshot: AgentExternalSnapshot): string {
  return `cli:${snapshot.agentId}:${snapshot.activity.turnId ?? snapshot.threadId}`;
}

function externalStatusLine(snapshot: AgentExternalSnapshot, queueLength: number): string {
  const approval = snapshot.pendingApprovals?.[0];
  if (approval) {
    return `${snapshot.agentLabel} action required · ${trimLine(approval.command, 120)} · ${queueLength} queued`;
  }
  const elapsed = snapshot.activity.startedAt
    ? formatDuration((Date.now() - snapshot.activity.startedAt.getTime()) / 1000)
    : "-";
  const tool = snapshot.latestToolName ?? "-";
  return `${snapshot.agentLabel} CLI running · ${elapsed} · tool ${tool} · ${queueLength} queued`;
}

function approvalActions(approval: AgentApprovalRequest): WebChatMessage["actions"] {
  const actions: NonNullable<WebChatMessage["actions"]> = [
    { label: "Proceed", action: `approval:yes:${approval.id}`, style: "primary" },
  ];
  if (approval.prefixRule.length > 0) {
    actions.push({
      label: "Proceed and remember",
      action: `approval:persist:${approval.id}`,
      style: "secondary",
      title: `Remember ${approval.prefixRule.join(" ")}`,
    });
  }
  actions.push({ label: "Deny", action: `approval:no:${approval.id}`, style: "danger" });
  return actions;
}

function durationFromDates(start: Date | null, end: Date | null): number | undefined {
  if (!start || !end) {
    return undefined;
  }
  return Math.max(0, end.getTime() - start.getTime());
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "-";
  }
  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${minutes}m ${remainder}s`;
}
