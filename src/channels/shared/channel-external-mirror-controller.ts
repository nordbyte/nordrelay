import type { AgentActivityEvent, AgentApprovalRequest, AgentExternalSnapshot, AgentSessionService } from "../../agents/shared/agent.js";
import type { ConnectorConfig } from "../../core/config.js";
import type { WebActivityActor, WebActivityEvent } from "../../web/web-state.js";
import type { ChannelContext } from "./channel-adapter.js";
import type { ChannelExternalMirrorState } from "./channel-bridge-state.js";
import type { ChannelContextKey } from "./context-key.js";
import { renderExternalApprovalRequest, renderExternalMirrorEvent, renderExternalMirrorStatus, trimLine } from "./bot-rendering.js";

export type ChannelMirrorMode = "off" | "status" | "final" | "full";

export interface ChannelExternalMirrorRenderedText {
  plain: string;
  html: string;
}

export interface ChannelExternalMirrorControllerOptions<MessageId extends string | number> {
  config: ConnectorConfig;
  states: Map<ChannelContextKey, ChannelExternalMirrorState<MessageId>>;
  typingIntervalMs: number;
  minUpdateMs(contextKey: ChannelContextKey): number;
  mirrorMode(contextKey: ChannelContextKey): ChannelMirrorMode;
  queueLength(contextKey: ChannelContextKey): number;
  activityActor(snapshot: AgentExternalSnapshot): WebActivityActor;
  appendActivity(input: Omit<WebActivityEvent, "id" | "timestamp"> & { timestamp?: string }): void;
  sendTyping(contextKey: ChannelContextKey, context: ChannelContext, state: ChannelExternalMirrorState<MessageId>): Promise<void>;
  sendWorkingNotice(
    contextKey: ChannelContextKey,
    context: ChannelContext,
    state: ChannelExternalMirrorState<MessageId>,
    snapshot: AgentExternalSnapshot,
    prompt: string,
  ): Promise<void>;
  sendStatus(
    contextKey: ChannelContextKey,
    context: ChannelContext,
    state: ChannelExternalMirrorState<MessageId>,
    rendered: ChannelExternalMirrorRenderedText,
  ): Promise<MessageId>;
  editStatus(
    contextKey: ChannelContextKey,
    context: ChannelContext,
    state: ChannelExternalMirrorState<MessageId>,
    messageId: MessageId,
    rendered: ChannelExternalMirrorRenderedText,
  ): Promise<void>;
  sendEvent(
    contextKey: ChannelContextKey,
    context: ChannelContext,
    state: ChannelExternalMirrorState<MessageId>,
    rendered: ChannelExternalMirrorRenderedText,
  ): Promise<void>;
  sendApprovalRequest?(
    contextKey: ChannelContextKey,
    context: ChannelContext,
    state: ChannelExternalMirrorState<MessageId>,
    snapshot: AgentExternalSnapshot,
    approval: AgentApprovalRequest,
    rendered: ChannelExternalMirrorRenderedText,
  ): Promise<void>;
  sendDone(
    contextKey: ChannelContextKey,
    context: ChannelContext,
    state: ChannelExternalMirrorState<MessageId>,
    text: string,
  ): Promise<void>;
  sendFinalAnswer(
    contextKey: ChannelContextKey,
    context: ChannelContext,
    state: ChannelExternalMirrorState<MessageId>,
    snapshot: AgentExternalSnapshot,
    text: string,
  ): Promise<void>;
  deliverArtifacts(
    contextKey: ChannelContextKey,
    context: ChannelContext,
    session: AgentSessionService,
    state: ChannelExternalMirrorState<MessageId>,
    turnId: string | null,
  ): Promise<void>;
  shouldSendDone?(contextKey: ChannelContextKey): boolean;
  fullEventFilter?(event: AgentActivityEvent): boolean;
  fullEventLimit?: number;
  requirePreviousForTerminal?: boolean;
}

export interface ChannelExternalMirrorController<MessageId extends string | number> {
  mirror(
    contextKey: ChannelContextKey,
    context: ChannelContext,
    session: AgentSessionService,
    snapshot: AgentExternalSnapshot,
  ): Promise<void>;
  get(contextKey: ChannelContextKey): ChannelExternalMirrorState<MessageId> | undefined;
  delete(contextKey: ChannelContextKey): void;
}

export function createChannelExternalMirrorController<MessageId extends string | number>(
  options: ChannelExternalMirrorControllerOptions<MessageId>,
): ChannelExternalMirrorController<MessageId> {
  const fullEventFilter = options.fullEventFilter ?? ((event: AgentActivityEvent) => event.kind === "tool" || event.kind === "task");
  const fullEventLimit = options.fullEventLimit ?? 4;
  const requirePreviousForTerminal = options.requirePreviousForTerminal ?? true;

  const ensureState = (
    contextKey: ChannelContextKey,
    snapshot: AgentExternalSnapshot,
  ): { state: ChannelExternalMirrorState<MessageId>; previous: ChannelExternalMirrorState<MessageId> | undefined } => {
    const previous = options.states.get(contextKey);
    if (previous && previous.threadId === snapshot.threadId && previous.rolloutPath === snapshot.sourcePath) {
      return { state: previous, previous };
    }

    const state: ChannelExternalMirrorState<MessageId> = {
      threadId: snapshot.threadId,
      rolloutPath: snapshot.sourcePath,
      lastLine: snapshot.lineCount,
      turnId: snapshot.activity.turnId,
      startedAt: snapshot.activity.startedAt,
    };
    options.states.set(contextKey, state);
    return { state, previous: undefined };
  };

  const maybeSendTyping = async (
    contextKey: ChannelContextKey,
    context: ChannelContext,
    state: ChannelExternalMirrorState<MessageId>,
  ): Promise<void> => {
    const now = Date.now();
    if (state.lastTypingAt && now - state.lastTypingAt < options.typingIntervalMs) {
      return;
    }
    state.lastTypingAt = now;
    await options.sendTyping(contextKey, context, state);
  };

  const recordTurnStart = (
    contextKey: ChannelContextKey,
    session: AgentSessionService,
    state: ChannelExternalMirrorState<MessageId>,
    snapshot: AgentExternalSnapshot,
  ): void => {
    const turnKey = snapshot.activity.turnId ?? snapshot.activity.startedAt?.toISOString() ?? "unknown";
    if (state.activityStartedTurnKey === turnKey) {
      return;
    }
    const info = session.getInfo();
    options.appendActivity({
      source: "cli",
      status: "running",
      type: "cli_turn_started",
      contextKey,
      threadId: snapshot.threadId,
      workspace: info.workspace,
      agentId: info.agentId,
      actor: options.activityActor(snapshot),
      prompt: snapshot.latestUserMessage ?? `${snapshot.agentLabel} CLI task`,
      detail: `${snapshot.sourceLabel}: ${snapshot.sourcePath}`,
    });
    state.activityStartedTurnKey = turnKey;
    state.activityFinishedTurnKey = undefined;
    state.activityToolStartLines = [];
    state.activityToolEndLines = [];
  };

  const recordToolEvents = (
    contextKey: ChannelContextKey,
    session: AgentSessionService,
    state: ChannelExternalMirrorState<MessageId>,
    snapshot: AgentExternalSnapshot,
  ): void => {
    const info = session.getInfo();
    const loggedStartLines = new Set(state.activityToolStartLines ?? []);
    const loggedEndLines = new Set(state.activityToolEndLines ?? []);
    for (const event of snapshot.events.filter((event) => event.lineNumber > state.lastLine && event.kind === "tool")) {
      if (event.status === "started" && !loggedStartLines.has(event.lineNumber)) {
        options.appendActivity({
          source: "cli",
          status: "running",
          type: "cli_tool_started",
          contextKey,
          threadId: snapshot.threadId,
          workspace: info.workspace,
          agentId: info.agentId,
          actor: options.activityActor(snapshot),
          prompt: snapshot.latestUserMessage ?? undefined,
          detail: event.toolName ?? "tool",
        });
        loggedStartLines.add(event.lineNumber);
      }
      if ((event.status === "finished" || event.status === "failed") && !loggedEndLines.has(event.lineNumber)) {
        options.appendActivity({
          source: "cli",
          status: event.status === "failed" ? "failed" : "completed",
          type: event.status === "failed" ? "cli_tool_failed" : "cli_tool_completed",
          contextKey,
          threadId: snapshot.threadId,
          workspace: info.workspace,
          agentId: info.agentId,
          actor: options.activityActor(snapshot),
          prompt: snapshot.latestUserMessage ?? undefined,
          detail: event.toolName ?? "tool",
        });
        loggedEndLines.add(event.lineNumber);
      }
    }
    state.activityToolStartLines = [...loggedStartLines].slice(-200);
    state.activityToolEndLines = [...loggedEndLines].slice(-200);
  };

  const recordTurnFinished = (
    contextKey: ChannelContextKey,
    session: AgentSessionService,
    state: ChannelExternalMirrorState<MessageId>,
    snapshot: AgentExternalSnapshot,
    terminalEvent: AgentActivityEvent,
  ): void => {
    const turnKey = terminalEvent.turnId ?? snapshot.activity.turnId ?? state.startedAt?.toString() ?? "unknown";
    if (state.activityFinishedTurnKey === turnKey) {
      return;
    }
    const info = session.getInfo();
    const startedAt = state.startedAt instanceof Date ? state.startedAt : state.startedAt ? new Date(state.startedAt) : snapshot.activity.startedAt;
    options.appendActivity({
      source: "cli",
      status: terminalEvent.status === "aborted" ? "aborted" : terminalEvent.status === "failed" ? "failed" : "completed",
      type: "cli_turn_finished",
      contextKey,
      threadId: snapshot.threadId,
      workspace: info.workspace,
      agentId: info.agentId,
      actor: options.activityActor(snapshot),
      prompt: snapshot.latestUserMessage ?? undefined,
      detail: `${snapshot.agentLabel} CLI task ${terminalEvent.status ?? "finished"}.`,
      durationMs: startedAt && terminalEvent.timestamp ? Math.max(0, terminalEvent.timestamp.getTime() - startedAt.getTime()) : undefined,
    });
    state.activityFinishedTurnKey = turnKey;
  };

  const maybeSendApprovals = async (contextKey: ChannelContextKey, context: ChannelContext, session: AgentSessionService, state: ChannelExternalMirrorState<MessageId>, snapshot: AgentExternalSnapshot): Promise<void> => {
    const approvals = snapshot.pendingApprovals ?? [];
    if (!approvals.length || !options.sendApprovalRequest) {
      return;
    }
    const sent = new Set(state.approvalRequestIds ?? []);
    for (const approval of approvals) {
      if (sent.has(approval.id)) {
        continue;
      }
      const rendered = renderExternalApprovalRequest(snapshot.agentLabel, approval);
      await options.sendApprovalRequest(contextKey, context, state, snapshot, approval, rendered);
      const info = session.getInfo();
      options.appendActivity({ source: "cli", status: "running", type: "cli_action_required", contextKey, threadId: snapshot.threadId, workspace: info.workspace, agentId: info.agentId, actor: options.activityActor(snapshot), prompt: snapshot.latestUserMessage ?? undefined, detail: `${approval.toolName}: ${approval.command}` });
      sent.add(approval.id);
    }
    state.approvalRequestIds = [...sent].slice(-50);
  };

  return {
    async mirror(contextKey, context, session, snapshot) {
      const { state, previous } = ensureState(contextKey, snapshot);
      const mirrorMode = options.mirrorMode(contextKey);

      if (snapshot.activity.active) {
        state.turnId = snapshot.activity.turnId;
        state.startedAt = snapshot.activity.startedAt;
        recordTurnStart(contextKey, session, state, snapshot);
        await maybeSendApprovals(contextKey, context, session, state, snapshot);

        if (mirrorMode !== "off") {
          await maybeSendTyping(contextKey, context, state);
        }
        if (mirrorMode === "final") {
          await options.sendWorkingNotice(contextKey, context, state, snapshot, trimLine(snapshot.latestUserMessage ?? "", 250));
          state.lastLine = Math.max(state.lastLine, snapshot.lineCount);
          return;
        }
        if (mirrorMode === "off") {
          state.lastLine = Math.max(state.lastLine, snapshot.lineCount);
          return;
        }

        const status = renderExternalMirrorStatus(snapshot, options.queueLength(contextKey));
        const now = Date.now();
        const canUpdateStatus = !state.latestStatusAt || now - state.latestStatusAt >= options.minUpdateMs(contextKey);
        if (!state.statusMessageId) {
          state.statusMessageId = await options.sendStatus(contextKey, context, state, status);
          state.latestStatusAt = now;
        } else if (state.latestStatus !== status.plain && canUpdateStatus) {
          await options.editStatus(contextKey, context, state, state.statusMessageId, status);
          state.latestStatusAt = now;
        }
        state.latestStatus = status.plain;

        if (mirrorMode === "full") {
          const newEvents = snapshot.events
            .filter((event) => event.lineNumber > (state.latestMirroredEventLine ?? state.lastLine))
            .filter(fullEventFilter)
            .slice(-fullEventLimit);
          for (const event of newEvents) {
            const rendered = renderExternalMirrorEvent(event);
            if (!rendered) {
              continue;
            }
            await options.sendEvent(contextKey, context, state, rendered);
            state.latestMirroredEventLine = event.lineNumber;
          }
        }

        recordToolEvents(contextKey, session, state, snapshot);
        state.lastLine = Math.max(state.lastLine, snapshot.lineCount);
        return;
      }

      if (requirePreviousForTerminal && !previous) {
        state.lastLine = Math.max(state.lastLine, snapshot.lineCount);
        return;
      }

      const terminalEvent = [...snapshot.events].reverse().find((event) => event.kind === "task" && event.status && event.status !== "started");
      if (terminalEvent) {
        recordTurnFinished(contextKey, session, state, snapshot, terminalEvent);
        if (mirrorMode !== "off") {
          const doneText = `${snapshot.agentLabel} CLI task ${terminalEvent.status}.`;
          if (state.statusMessageId || options.shouldSendDone?.(contextKey) !== false) {
            await options.sendDone(contextKey, context, state, doneText);
          }
        }

        const finalAgent = snapshot.events.filter((event) => event.kind === "agent" && event.text).at(-1);
        if (mirrorMode !== "off" && mirrorMode !== "status" && finalAgent?.text && finalAgent.lineNumber !== state.latestAgentLine) {
          await options.sendFinalAnswer(contextKey, context, state, snapshot, finalAgent.text);
          state.latestAgentLine = finalAgent.lineNumber;
        }

        await options.deliverArtifacts(contextKey, context, session, state, terminalEvent.turnId);
      }

      state.workingNoticeTurnKey = undefined;
      state.lastLine = Math.max(state.lastLine, snapshot.lineCount);
    },
    get(contextKey) {
      return options.states.get(contextKey);
    },
    delete(contextKey) {
      options.states.delete(contextKey);
    },
  };
}
