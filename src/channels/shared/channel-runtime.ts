import type {
  ChannelContext,
  ChannelDescriptor,
  ChannelId,
  ChannelInboundMessage,
  ChannelOutboundFile,
  ChannelOutboundMessage,
  ChannelOutboundResult,
  ChannelRuntime,
} from "./channel-adapter.js";
import type { ChannelActionResponse } from "./channel-actions.js";

export type ChannelCommandHandler = (message: ChannelInboundMessage) => Promise<ChannelActionResponse | void> | ChannelActionResponse | void;

export interface ParsedChannelCommand {
  command: string;
  argument: string;
}

export interface ChannelCommandParseOptions {
  allowBotMention?: boolean;
}

export interface ChannelCommandDispatchResult {
  matched: boolean;
  command?: string;
  response?: ChannelActionResponse;
}

export class ChannelCommandRouter {
  private readonly handlers = new Map<string, ChannelCommandHandler>();

  command(name: string, handler: ChannelCommandHandler): this {
    const normalized = normalizeChannelCommandName(name);
    if (!normalized) {
      throw new Error("Channel command name is required.");
    }
    this.handlers.set(normalized, handler);
    return this;
  }

  commands(names: string[], handler: ChannelCommandHandler): this {
    for (const name of names) {
      this.command(name, handler);
    }
    return this;
  }

  async dispatch(message: ChannelInboundMessage): Promise<ChannelCommandDispatchResult> {
    const parsed = parseChannelCommand(message.text ?? "");
    if (!parsed) {
      return { matched: false };
    }

    const handler = this.handlers.get(parsed.command);
    if (!handler) {
      return { matched: false, command: parsed.command };
    }

    const response = await handler({
      ...message,
      text: parsed.argument,
    });
    return {
      matched: true,
      command: parsed.command,
      response: response ?? undefined,
    };
  }
}

export async function deliverChannelAction(
  runtime: ChannelRuntime,
  context: ChannelContext,
  response: ChannelActionResponse,
): Promise<ChannelOutboundResult> {
  return runtime.sendMessage(context, {
    text: response.html,
    fallbackText: response.plain,
    parseMode: "html",
    buttons: response.buttons,
  });
}

export function parseChannelCommand(
  text: string,
  options: ChannelCommandParseOptions = {},
): ParsedChannelCommand | null {
  const mention = options.allowBotMention === false ? "" : "(?:@\\w+)?";
  const match = text.trimStart().match(new RegExp(`^/([a-zA-Z0-9_-]+)${mention}(?:\\s+([\\s\\S]*))?$`));
  if (!match?.[1]) {
    return null;
  }
  return {
    command: normalizeChannelCommandName(match[1]),
    argument: match[2]?.trim() ?? "",
  };
}

export class InMemoryChannelRuntime implements ChannelRuntime {
  readonly capabilities: Set<ChannelDescriptor["capabilities"][number]>;
  readonly id: ChannelId;
  readonly label: string;
  readonly sentMessages: Array<{ context: ChannelContext; message: ChannelOutboundMessage; messageId: string }> = [];
  readonly editedMessages: Array<{ context: ChannelContext; messageId: string; message: ChannelOutboundMessage }> = [];
  readonly typingContexts: ChannelContext[] = [];
  readonly sentFiles: Array<{ context: ChannelContext; file: ChannelOutboundFile; messageId: string }> = [];

  constructor(private readonly descriptor: ChannelDescriptor) {
    this.id = descriptor.id;
    this.label = descriptor.label;
    this.capabilities = new Set(descriptor.capabilities);
  }

  describe(): ChannelDescriptor {
    return {
      ...this.descriptor,
      capabilities: [...this.descriptor.capabilities],
    };
  }

  async sendMessage(context: ChannelContext, message: ChannelOutboundMessage): Promise<ChannelOutboundResult> {
    const messageId = `${this.id}-message-${this.sentMessages.length + 1}`;
    this.sentMessages.push({ context, message, messageId });
    return { messageId };
  }

  async editMessage(context: ChannelContext, messageId: string, message: ChannelOutboundMessage): Promise<void> {
    this.editedMessages.push({ context, messageId, message });
  }

  async sendTyping(context: ChannelContext): Promise<void> {
    this.typingContexts.push(context);
  }

  async sendFile(context: ChannelContext, file: ChannelOutboundFile): Promise<ChannelOutboundResult> {
    const messageId = `${this.id}-file-${this.sentFiles.length + 1}`;
    this.sentFiles.push({ context, file, messageId });
    return { messageId };
  }
}

export function normalizeChannelCommandName(name: string): string {
  return name.trim().replace(/^\//, "").toLowerCase();
}
