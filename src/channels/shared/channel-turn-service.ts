import { randomUUID } from "node:crypto";

import {
  CODEX_AGENT_CAPABILITIES,
  agentLabel,
  type AgentPromptInput,
  type AgentSessionCallbacks,
  type AgentSessionInfo,
  type AgentSessionService,
} from "../../agents/shared/agent.js";
import type { AuditEvent } from "../../access/audit-log.js";
import { friendlyErrorText } from "../../core/error-messages.js";
import {
  displayMetaForPromptEnvelope,
  displayTextForPromptEnvelope,
  type PromptEnvelope,
} from "../../state/prompt-store.js";
import type { RelayArtifactService } from "../../runtime/relay-artifact-service.js";
import type { RelayEvent, WebTaskDto } from "../../runtime/relay-runtime-types.js";
import type { WebActivityActor, WebActivityEvent, WebChatStore } from "../../web/web-state.js";

export interface ChannelTurnServiceOptions {
  source: WebActivityEvent["source"];
  contextKey: string;
  chatStore: WebChatStore;
  artifactService: RelayArtifactService;
  checkAuth: (info: AgentSessionInfo) => Promise<{ authenticated: boolean; detail: string }>;
  ensureActiveThread: (session: AgentSessionService) => Promise<void>;
  updateSession: (session: AgentSessionService) => void;
  appendActivity: (input: Omit<WebActivityEvent, "id" | "timestamp"> & { timestamp?: string }) => WebActivityEvent;
  appendAudit: (input: Omit<AuditEvent, "id" | "timestamp" | "channelId">) => AuditEvent;
  broadcast: (event: RelayEvent) => void;
  chatHistory: () => Promise<ReturnType<WebChatStore["list"]>>;
  setLastPrompt: (envelope: PromptEnvelope) => void;
  getCurrentProgress: () => WebTaskDto | null;
  setCurrentProgress: (progress: WebTaskDto | null) => void;
  setCurrentTurn: (id: string | null, startedAt?: number, accumulatedText?: string) => void;
  getCurrentTurnStartedAt: () => number;
  getAccumulatedText: () => string;
  setAccumulatedText: (text: string) => void;
}

export class ChannelTurnService {
  constructor(private readonly options: ChannelTurnServiceOptions) {}

  async run(session: AgentSessionService, envelope: PromptEnvelope): Promise<void> {
    const actor = envelope.activityActor;
    await this.options.ensureActiveThread(session);
    const sync = session.syncFromAgentState({ reattach: true });
    if (sync.changed || sync.reattached) {
      this.options.updateSession(session);
    }
    const info = session.getInfo();
    if ((info.capabilities ?? CODEX_AGENT_CAPABILITIES).auth) {
      const auth = await this.options.checkAuth(info);
      if (!auth.authenticated) {
        throw new Error(`${agentLabel(info.agentId)} is not authenticated: ${auth.detail}`);
      }
    }
    const turnId = randomUUID().slice(0, 12);
    const correlationId = envelope.correlationId ?? turnId;
    const startedMs = Date.now();
    this.options.setCurrentTurn(turnId, startedMs, "");
    this.options.setCurrentProgress({
      id: turnId,
      source: this.options.source,
      status: "running",
      correlationId,
      prompt: envelope.description,
      agentId: info.agentId,
      agentLabel: info.agentLabel,
      threadId: info.threadId,
      workspace: info.workspace,
      startedAt: new Date(startedMs).toISOString(),
      updatedAt: new Date(startedMs).toISOString(),
      durationMs: 0,
      outputChars: 0,
      tools: [],
    });
    this.options.setLastPrompt(envelope);
    const startedDate = new Date();
    const startedAt = startedDate.toISOString();
    const displayText = displayTextForPromptEnvelope(envelope);
    const displayMeta = displayMetaForPromptEnvelope(envelope);

    const userMessage = this.options.chatStore.append({
      threadId: info.threadId ?? "pending",
      role: "user",
      text: displayText,
      meta: displayMeta,
      attachments: envelope.attachments,
      source: this.options.source,
      correlationId,
      turnId,
      timestamp: startedAt,
    });
    this.options.appendActivity({
      source: this.options.source,
      status: "running",
      type: "prompt_started",
      threadId: info.threadId,
      workspace: info.workspace,
      agentId: info.agentId,
      actor,
      correlationId,
      prompt: envelope.description,
    });
    this.options.appendAudit({
      action: "prompt_started",
      status: "ok",
      contextKey: this.options.contextKey,
      agentId: info.agentId,
      threadId: info.threadId,
      workspace: info.workspace,
      actor,
      correlationId,
      description: envelope.description,
    });
    this.options.broadcast({
      type: "turn_start",
      id: turnId,
      messageId: userMessage.id,
      prompt: envelope.description,
      text: displayText,
      meta: displayMeta,
      attachments: envelope.attachments,
      at: startedAt,
      source: this.options.source,
      correlationId,
    });
    void this.options.chatHistory().then((messages) => this.options.broadcast({ type: "chat_history", messages })).catch(() => {});

    try {
      await session.prompt(envelope.input as AgentPromptInput, this.callbacks(turnId, info, envelope, actor));
      this.options.updateSession(session);
      const artifactInfo = session.getInfo();
      await this.options.artifactService.persistWorkspaceArtifactsForTurn(artifactInfo.workspace, turnId, startedDate, {
        source: this.options.source,
        agentId: artifactInfo.agentId,
        threadId: artifactInfo.threadId,
        workspace: artifactInfo.workspace,
        contextKey: this.options.contextKey,
        correlationId,
        prompt: envelope.description,
        actor,
        turnStartedAt: startedAt,
      });
      const text = this.options.getAccumulatedText();
      if (text.trim()) {
        this.options.chatStore.append({
          threadId: info.threadId ?? "pending",
          role: "agent",
          text,
          source: this.options.source,
          correlationId,
          turnId,
        });
      }
      this.options.appendActivity({
        source: this.options.source,
        status: "completed",
        type: "prompt_completed",
        threadId: info.threadId,
        workspace: info.workspace,
        agentId: info.agentId,
        actor,
        correlationId,
        prompt: envelope.description,
        durationMs: Date.now() - this.options.getCurrentTurnStartedAt(),
      });
      this.options.appendAudit({
        action: "prompt_completed",
        status: "ok",
        contextKey: this.options.contextKey,
        agentId: info.agentId,
        threadId: info.threadId,
        workspace: info.workspace,
        actor,
        correlationId,
        description: envelope.description,
      });
      this.updateCurrentProgress({ status: "completed" });
      this.options.broadcast({ type: "turn_complete", id: turnId, at: new Date().toISOString(), correlationId });
      this.options.broadcast({ type: "chat_history", messages: await this.options.chatHistory() });
    } catch (error) {
      const errorText = friendlyErrorText(error);
      this.options.chatStore.append({
        threadId: info.threadId ?? "pending",
        role: "system",
        text: `Error: ${errorText}`,
        source: this.options.source,
        correlationId,
        turnId,
      });
      this.options.appendActivity({
        source: this.options.source,
        status: "failed",
        type: "prompt_failed",
        threadId: info.threadId,
        workspace: info.workspace,
        agentId: info.agentId,
        actor,
        correlationId,
        prompt: envelope.description,
        detail: errorText,
        durationMs: Date.now() - this.options.getCurrentTurnStartedAt(),
      });
      this.options.appendAudit({
        action: "prompt_failed",
        status: "failed",
        contextKey: this.options.contextKey,
        agentId: info.agentId,
        threadId: info.threadId,
        workspace: info.workspace,
        actor,
        correlationId,
        description: envelope.description,
        detail: errorText,
      });
      this.updateCurrentProgress({ status: "failed", detail: errorText });
      this.options.broadcast({ type: "turn_error", id: turnId, error: errorText, at: new Date().toISOString(), correlationId });
      this.options.broadcast({ type: "chat_history", messages: await this.options.chatHistory() });
      throw error;
    } finally {
      const progress = this.options.getCurrentProgress();
      if (progress) {
        progress.durationMs = Date.now() - this.options.getCurrentTurnStartedAt();
        progress.updatedAt = new Date().toISOString();
      }
      this.options.setCurrentTurn(null);
    }
  }

  private callbacks(
    turnId: string,
    info: AgentSessionInfo,
    envelope: PromptEnvelope,
    actor: WebActivityActor | undefined,
  ): AgentSessionCallbacks {
    const correlationId = envelope.correlationId ?? turnId;
    return {
      onTextDelta: (delta) => {
        const nextText = this.options.getAccumulatedText() + delta;
        this.options.setAccumulatedText(nextText);
        this.updateCurrentProgress({ outputChars: nextText.length });
        this.options.broadcast({ type: "text_delta", id: turnId, delta, correlationId });
      },
      onToolStart: (toolName, toolCallId) => {
        this.addCurrentTool(toolName);
        this.options.appendActivity({
          source: this.options.source,
          status: "running",
          type: "tool_started",
          threadId: info.threadId,
          workspace: info.workspace,
          agentId: info.agentId,
          actor,
          correlationId,
          prompt: envelope.description,
          detail: toolName,
        });
        this.options.broadcast({ type: "tool_start", id: turnId, toolCallId, toolName, correlationId });
      },
      onToolUpdate: (toolCallId, partialResult) => {
        this.updateCurrentProgress();
        this.options.broadcast({ type: "tool_update", id: turnId, toolCallId, partialResult, correlationId });
      },
      onToolEnd: (toolCallId, isError) => {
        const progress = this.options.getCurrentProgress();
        const toolName = progress?.currentTool ?? progress?.lastTool ?? toolCallId;
        this.updateCurrentProgress({ currentTool: undefined });
        this.options.appendActivity({
          source: this.options.source,
          status: isError ? "failed" : "completed",
          type: isError ? "tool_failed" : "tool_completed",
          threadId: info.threadId,
          workspace: info.workspace,
          agentId: info.agentId,
          actor,
          correlationId,
          prompt: envelope.description,
          detail: toolName,
        });
        this.options.broadcast({ type: "tool_end", id: turnId, toolCallId, isError, correlationId });
      },
      onTodoUpdate: (items) => {
        this.updateCurrentProgress({ detail: `Plan: ${items.filter((item) => item.completed).length}/${items.length} done` });
        this.options.broadcast({ type: "todo_update", id: turnId, items, correlationId });
      },
      onTurnComplete: () => {},
      onAgentEnd: () => this.options.broadcast({ type: "turn_complete", id: turnId, at: new Date().toISOString(), correlationId }),
    };
  }

  private updateCurrentProgress(patch: Partial<WebTaskDto> = {}): void {
    const progress = this.options.getCurrentProgress();
    if (!progress) {
      return;
    }
    if ("currentTool" in patch) {
      progress.currentTool = patch.currentTool;
      const { currentTool: _currentTool, ...rest } = patch;
      Object.assign(progress, rest);
    } else {
      Object.assign(progress, patch);
    }
    progress.durationMs = Date.now() - this.options.getCurrentTurnStartedAt();
    progress.updatedAt = new Date().toISOString();
    this.options.setCurrentProgress(progress);
  }

  private addCurrentTool(toolName: string): void {
    const progress = this.options.getCurrentProgress();
    if (!progress) {
      return;
    }
    const existing = progress.tools.find((tool) => tool.name === toolName);
    if (existing) {
      existing.count += 1;
    } else {
      progress.tools.push({ name: toolName, count: 1 });
    }
    this.updateCurrentProgress({ currentTool: toolName, lastTool: toolName });
  }
}
