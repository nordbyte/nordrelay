import type { AgentSessionInfo } from "../agents/shared/agent.js";
import type { QueuedPrompt } from "../state/prompt-store.js";
import type { RelayRuntimeDelegate } from "./relay-runtime-delegate.js";

export function broadcastChatHistory(runtime: RelayRuntimeDelegate): void {
  void runtime.chatHistory().then((messages) => runtime.broadcast({ type: "chat_history", messages })).catch(() => {});
}

export function appendQueuedPromptChatMessage(runtime: RelayRuntimeDelegate, info: AgentSessionInfo, queued: QueuedPrompt, position: number): void {
  runtime.chatStore.append({
    threadId: info.threadId ?? "pending",
    role: "system",
    text: `Queued prompt ${queued.id} at position ${position}.\n${queued.description}`,
    source: "web",
    correlationId: queued.correlationId,
    actions: [{ label: "Cancel queued message", action: `queue:cancel:${queued.id}`, style: "danger", title: "Remove this prompt from the queue" }],
  });
  broadcastChatHistory(runtime);
}

export function resolveQueuedPromptChatAction(runtime: RelayRuntimeDelegate, queueId: string, label: string): void {
  if (runtime.chatStore.resolveAction({ actionId: queueId, actionPrefix: "queue:cancel", label }) > 0) {
    broadcastChatHistory(runtime);
  }
}
