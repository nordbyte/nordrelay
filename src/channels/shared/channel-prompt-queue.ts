import type { AuditEvent } from "../../access/audit-log.js";
import type { PromptStore, PromptEnvelope, QueuedPrompt } from "../../state/prompt-store.js";
import type { ChannelBusyReason } from "./channel-bridge-state.js";
import type { ChannelActivityInput, ChannelAuditInput, ChannelBridgeRequestBase } from "./channel-bridge-controller.js";

export async function queueChannelPromptIfBusy<Request extends ChannelBridgeRequestBase>(options: {
  request: Request;
  envelope: PromptEnvelope;
  fromQueue?: boolean;
  promptStore: PromptStore;
  busy: ChannelBusyReason<{ agentLabel: string }>;
  actionPrefix: string;
  reply: (request: Request, text: string, options?: { buttons?: Array<Array<{ label: string; action: string }>> }) => Promise<unknown>;
  appendActivity: (request: Request, input: ChannelActivityInput) => unknown;
  audit: (request: Request, input: ChannelAuditInput) => unknown;
}): Promise<boolean> {
  if (!options.busy.busy) {
    return false;
  }
  const item = options.fromQueue && isQueuedPrompt(options.envelope)
    ? options.envelope
    : options.promptStore.enqueue(options.request.contextKey, options.envelope);
  if (options.fromQueue && isQueuedPrompt(options.envelope)) {
    options.promptStore.enqueueFront(options.request.contextKey, options.envelope);
  }
  const position = options.promptStore.list(options.request.contextKey).findIndex((queued) => queued.id === item.id) + 1;
  const text = options.busy.kind === "external"
    ? `Queued prompt ${item.id} at position ${position}. The ${options.busy.agentLabel} session is still active and is processing a previous task.`
    : `Queued prompt ${item.id} at position ${position}.`;
  await options.reply(options.request, text, {
    buttons: [[{ label: "Cancel queued message", action: `${options.actionPrefix}_queue_cancel:${options.request.contextKey}:${item.id}` }]],
  });
  options.appendActivity(options.request, {
    status: "queued",
    type: "prompt_queued",
    prompt: item.description,
    detail: text,
    correlationId: item.correlationId,
  });
  options.audit(options.request, {
    action: "prompt_queued" as AuditEvent["action"],
    status: "ok",
    promptId: item.id,
    correlationId: item.correlationId,
    description: item.description,
  });
  return true;
}

function isQueuedPrompt(value: unknown): value is QueuedPrompt {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as QueuedPrompt;
  return typeof candidate.id === "string" && typeof candidate.createdAt === "number" && typeof candidate.description === "string";
}
