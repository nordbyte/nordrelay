import { friendlyErrorText } from "../../core/error-messages.js";
import { RemoteRelayClient } from "../../peers/peer-client.js";
import type { PromptEnvelope } from "../../state/prompt-store.js";
import { peerPromptProxyPayload } from "../../runtime/remote-prompt.js";
import type { PeerEventEnvelope } from "../../peers/peer-types.js";
import type { ChannelMirrorMode } from "../../state/bot-preferences.js";
import type { WebActivityActor } from "../../web/web-state.js";

export interface RemotePromptClient {
  subscribe(
    peerId: string,
    onEvent: (event: PeerEventEnvelope) => void,
    onError?: (error: Error) => void,
    sourceContextKey?: string,
  ): { close: () => void };
  webProxy(peerId: string, payload: Awaited<ReturnType<typeof peerPromptProxyPayload>>, actor?: WebActivityActor, sourceContextKey?: string): Promise<unknown>;
}

export interface ChannelPeerPromptOptions<MessageId> {
  targetPeerId?: string;
  contextKey: string;
  prompt: PromptEnvelope;
  remoteClient?: RemotePromptClient;
  mirrorMode?: ChannelMirrorMode | (() => ChannelMirrorMode);
  editMinIntervalMs: number;
  typingIntervalMs: number;
  sendTyping(): Promise<void>;
  sendResponse(text: string): Promise<MessageId>;
  editResponse(messageId: MessageId, text: string): Promise<void>;
  sendTurnStart(prompt: string): Promise<void>;
  sendToolStart(toolName: string): Promise<void>;
  sendQueued(queueId: string): Promise<void>;
  sendCompleted(): Promise<void>;
  sendFailure(message: string): Promise<void>;
  canUsePeer?: (peerId: string) => boolean;
}

export async function runChannelPeerPrompt<MessageId>(options: ChannelPeerPromptOptions<MessageId>): Promise<boolean> {
  if (!options.targetPeerId) {
    return false;
  }
  if (options.canUsePeer && !options.canUsePeer(options.targetPeerId)) {
    await options.sendFailure(`Access denied for peer target: ${options.targetPeerId}.`);
    return true;
  }

  const client = options.remoteClient ?? new RemoteRelayClient();
  let responseMessageId: MessageId | undefined;
  let accumulated = "";
  let lastEditAt = 0;
  let completed = false;
  let closeSubscription = (): void => {};
  const typing = setInterval(() => {
    void options.sendTyping().catch(() => {});
  }, options.typingIntervalMs);
  typing.unref?.();
  void options.sendTyping().catch(() => {});

  const flush = async (force = false): Promise<void> => {
    if (!accumulated.trim()) {
      return;
    }
    const now = Date.now();
    if (!force && now - lastEditAt < options.editMinIntervalMs) {
      return;
    }
    if (responseMessageId === undefined) {
      responseMessageId = await options.sendResponse(accumulated);
    } else {
      await options.editResponse(responseMessageId, accumulated);
    }
    lastEditAt = now;
  };

  const done = new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, 30 * 60 * 1000);
    timeout.unref?.();
    let subscription: { close: () => void } | undefined;
    const finish = (): void => {
      clearTimeout(timeout);
      subscription?.close();
      resolve();
    };
    subscription = client.subscribe(options.targetPeerId!, (event) => {
      if (event.type === "turn_start") {
        void options.sendTurnStart(event.prompt).catch(() => {});
      } else if (event.type === "text_delta") {
        accumulated += event.delta;
        void flush(false).catch(() => {});
      } else if (event.type === "tool_start") {
        if (currentMirrorMode(options) === "full") {
          void options.sendToolStart(event.toolName).catch(() => {});
        }
      } else if (event.type === "turn_complete") {
        completed = true;
        finish();
      } else if (event.type === "turn_error") {
        accumulated += `\n\nError: ${event.error}`;
        completed = true;
        finish();
      }
    }, (error) => {
      accumulated += `\n\nRemote event stream failed: ${error.message}`;
      finish();
    }, options.contextKey);
    closeSubscription = () => subscription?.close();
  });

  try {
    const result = await client.webProxy(
      options.targetPeerId,
      await peerPromptProxyPayload(options.prompt),
      options.prompt.activityActor,
      options.contextKey,
    );
    if (isQueuedRemoteResult(result)) {
      closeSubscription();
      await options.sendQueued(String(result.queueId ?? ""));
      return true;
    }
    await done;
    await flush(true);
    if (!accumulated.trim() && completed) {
      await options.sendCompleted();
    }
    return true;
  } catch (error) {
    await options.sendFailure(friendlyErrorText(error));
    return true;
  } finally {
    clearInterval(typing);
    closeSubscription();
  }
}

function isQueuedRemoteResult(value: unknown): value is { queued: true; queueId?: unknown } {
  return Boolean(value && typeof value === "object" && "queued" in value && (value as { queued?: unknown }).queued);
}

function currentMirrorMode<MessageId>(options: ChannelPeerPromptOptions<MessageId>): ChannelMirrorMode {
  if (typeof options.mirrorMode === "function") {
    return options.mirrorMode();
  }
  return options.mirrorMode ?? "full";
}
