import type { ChannelActionButton } from "../shared/channel-actions.js";
import {
  MatrixChannelAdapter,
  type ChannelContext,
  type ChannelOutboundFile,
  type ChannelOutboundMessage,
  type ChannelOutboundResult,
  type ChannelRuntime,
} from "../shared/channel-adapter.js";
import { redactText } from "../../core/redaction.js";
import { matrixRateLimiter } from "./matrix-rate-limit.js";
import type { MatrixClient } from "./matrix-client.js";

const MATRIX_TEXT_LIMIT = 65000;
const MATRIX_SAFE_TEXT_LIMIT = 3500;
export const MATRIX_ACTION_PREFIX = "nr:";

export class MatrixBotChannelRuntime implements ChannelRuntime {
  readonly id = "matrix" as const;
  readonly label = "Matrix";
  readonly capabilities = new MatrixChannelAdapter().capabilities;

  constructor(private readonly client: MatrixClient) {}

  describe() {
    return new MatrixChannelAdapter().describe();
  }

  async sendMessage(context: ChannelContext, message: ChannelOutboundMessage): Promise<ChannelOutboundResult> {
    const rendered = matrixMessageParts(message);
    const chunks = splitMatrixMessage(rendered.body);
    let firstEventId = "";
    for (const [index, chunk] of chunks.entries()) {
      const formattedBody = index === chunks.length - 1 ? rendered.formattedBody : undefined;
      const eventId = await matrixRateLimiter.run(matrixBucket(context), "sendMessage", () =>
        this.client.sendText(context.chatId, {
          body: chunk,
          formattedBody,
          threadId: message.threadId ?? context.topicId,
        }),
      );
      firstEventId ||= eventId;
    }
    return { messageId: firstEventId };
  }

  async editMessage(context: ChannelContext, messageId: string, message: ChannelOutboundMessage): Promise<void> {
    const rendered = matrixMessageParts(message);
    await matrixRateLimiter.run(matrixBucket(context), "editMessage", () =>
      this.client.editText(context.chatId, messageId, {
        body: trimMatrixMessage(rendered.body),
        formattedBody: rendered.formattedBody,
      }),
    ).catch(async () => {
      await this.sendMessage(context, message);
    });
  }

  async sendTyping(context: ChannelContext): Promise<void> {
    await matrixRateLimiter.run(matrixBucket(context), "typing", () =>
      this.client.setTyping(context.chatId, true, 10_000),
    ).catch(() => {});
  }

  async sendFile(context: ChannelContext, file: ChannelOutboundFile): Promise<ChannelOutboundResult> {
    const eventId = await matrixRateLimiter.run(matrixBucket(context), "sendFile", () =>
      this.client.sendFile(context.chatId, {
        localPath: file.localPath,
        name: file.name,
        caption: file.caption ? trimMatrixMessage(redactText(file.caption)) : undefined,
        threadId: file.threadId ?? context.topicId,
      }),
    );
    return { messageId: eventId };
  }
}

export function matrixMessageText(message: ChannelOutboundMessage): string {
  const text = message.fallbackText?.trim() || stripHtml(message.text).trim() || ".";
  const withActions = appendButtonFallback(text, message.buttons);
  return withActions.length <= MATRIX_TEXT_LIMIT ? withActions : `${withActions.slice(0, MATRIX_TEXT_LIMIT - 1)}...`;
}

export function matrixActionId(action: string): string {
  const raw = `${MATRIX_ACTION_PREFIX}${action}`;
  return raw.length <= 255 ? raw : `${MATRIX_ACTION_PREFIX}${action.slice(0, 255 - MATRIX_ACTION_PREFIX.length)}`;
}

export function actionFromMatrixActionId(actionId: string): string | null {
  return actionId.startsWith(MATRIX_ACTION_PREFIX) ? actionId.slice(MATRIX_ACTION_PREFIX.length) : null;
}

export function splitMatrixMessage(text: string): string[] {
  const normalized = text || ".";
  if (normalized.length <= MATRIX_SAFE_TEXT_LIMIT) {
    return [normalized];
  }
  const chunks: string[] = [];
  let remaining = normalized;
  while (remaining.length > 0) {
    const slice = remaining.slice(0, MATRIX_SAFE_TEXT_LIMIT);
    const breakAt = Math.max(slice.lastIndexOf("\n"), slice.lastIndexOf(" "));
    const length = breakAt > 400 ? breakAt : MATRIX_SAFE_TEXT_LIMIT;
    chunks.push(remaining.slice(0, length).trimEnd() || ".");
    remaining = remaining.slice(length).trimStart();
  }
  return chunks;
}

export function trimMatrixMessage(text: string): string {
  return text.length <= MATRIX_SAFE_TEXT_LIMIT ? text : `${text.slice(0, MATRIX_SAFE_TEXT_LIMIT - 3)}...`;
}

function matrixMessageParts(message: ChannelOutboundMessage): { body: string; formattedBody?: string } {
  const body = matrixMessageText(message);
  const formattedBody = message.parseMode === "html"
    ? appendButtonFallback(sanitizeMatrixHtml(message.text), message.buttons, true)
    : undefined;
  return {
    body,
    formattedBody: formattedBody ? trimMatrixMessage(formattedBody) : undefined,
  };
}

function appendButtonFallback(
  text: string,
  buttons: Array<Array<ChannelActionButton>> | undefined,
  html = false,
): string {
  const actions = (buttons ?? []).flat().slice(0, 10);
  if (actions.length === 0) {
    return text;
  }
  const lines = actions.map((button) => {
    const label = trimButtonLabel(button.label);
    const action = actionFromMatrixActionId(matrixActionId(button.action)) ?? button.action;
    return html
      ? `<li><b>${escapeHtml(label)}</b>: <code>${escapeHtml(action)}</code></li>`
      : `- ${label}: ${action}`;
  });
  return html
    ? `${text}<br><br><b>Actions</b><ul>${lines.join("")}</ul>`
    : `${text}\n\nActions:\n${lines.join("\n")}`;
}

function matrixBucket(context: ChannelContext): string {
  return context.topicId ?? context.chatId;
}

function stripHtml(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|pre)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function sanitizeMatrixHtml(text: string): string {
  return text
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/\son[a-z]+="[^"]*"/gi, "")
    .replace(/\son[a-z]+='[^']*'/gi, "");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function trimButtonLabel(label: string): string {
  const trimmed = label.trim() || "Action";
  return trimmed.length <= 75 ? trimmed : trimmed.slice(0, 75);
}
