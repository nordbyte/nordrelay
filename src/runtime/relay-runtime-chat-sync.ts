import type { AgentSessionInfo } from "../agents/shared/agent.js";
import type { QueuedPrompt } from "../state/prompt-store.js";
import type { WebChatMessage } from "../web/web-state.js";
import type { RelayRuntimeDelegate } from "./relay-runtime-delegate.js";
import type { RelaySessionEventContext } from "./relay-runtime-types.js";

export function broadcastChatHistory(runtime: RelayRuntimeDelegate): void {
  void runtime.chatHistory().then((messages) => runtime.broadcast({ type: "chat_history", messages })).catch(() => {});
}

export function chatEventContextFromInfo(runtime: RelayRuntimeDelegate, info: AgentSessionInfo): RelaySessionEventContext {
  return {
    contextKey: runtime.contextKey,
    agentId: info.agentId,
    threadId: info.threadId,
    workspace: info.workspace,
  };
}

export function broadcastChatMessageAdded(runtime: RelayRuntimeDelegate, message: WebChatMessage, context: RelaySessionEventContext): void {
  runtime.broadcast({ type: "chat_message_added", message, ...context });
  runtime.broadcast({
    type: "message_status_changed",
    status: "added",
    messageId: message.id,
    role: message.role,
    source: message.source,
    correlationId: message.correlationId,
    at: message.timestamp,
    ...context,
    threadId: message.threadId || context.threadId,
  });
}

export function broadcastChatMessageUpdated(runtime: RelayRuntimeDelegate, message: WebChatMessage, context: RelaySessionEventContext): void {
  runtime.broadcast({ type: "chat_message_updated", message, ...context });
  runtime.broadcast({
    type: "message_status_changed",
    status: "updated",
    messageId: message.id,
    role: message.role,
    source: message.source,
    correlationId: message.correlationId,
    at: new Date().toISOString(),
    ...context,
    threadId: message.threadId || context.threadId,
  });
}

export function broadcastChatMessagesCleared(runtime: RelayRuntimeDelegate, threadId: string | null, removed: number, context: RelaySessionEventContext): void {
  runtime.broadcast({ type: "chat_messages_cleared", threadId, removed, ...context });
  runtime.broadcast({ type: "message_status_changed", status: "cleared", at: new Date().toISOString(), ...context, threadId });
}

export function appendQueuedPromptChatMessage(runtime: RelayRuntimeDelegate, info: AgentSessionInfo, queued: QueuedPrompt, position: number): void {
  const message = runtime.chatStore.append({
    threadId: info.threadId ?? "pending",
    role: "system",
    text: `Queued prompt ${queued.id} at position ${position}.\n${queued.description}`,
    source: "web",
    correlationId: queued.correlationId,
    actions: [{ label: "Cancel queued message", action: `queue:cancel:${queued.id}`, style: "danger", title: "Remove this prompt from the queue" }],
  });
  broadcastChatMessageAdded(runtime, message, chatEventContextFromInfo(runtime, info));
}

export function resolveQueuedPromptChatAction(runtime: RelayRuntimeDelegate, queueId: string, label: string, info?: AgentSessionInfo): void {
  const updated = runtime.chatStore.resolveActionWithMessages({ actionId: queueId, actionPrefix: "queue:cancel", label });
  if (!updated.length) {
    return;
  }
  if (!info) {
    broadcastChatHistory(runtime);
    return;
  }
  const context = chatEventContextFromInfo(runtime, info);
  for (const message of updated) {
    broadcastChatMessageUpdated(runtime, message, { ...context, threadId: message.threadId || context.threadId });
  }
}
