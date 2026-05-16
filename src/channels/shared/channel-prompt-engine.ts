import type { AgentSessionCallbacks } from "../../agents/shared/agent.js";
import type { TurnProgress } from "./bot-rendering.js";
import type { ChannelContext, ChannelRuntime } from "./channel-adapter.js";
import { createChannelTurnLifecycle, createChannelTypingLoop } from "./channel-turn-lifecycle.js";
import type { ToolVerbosity } from "../../core/config.js";

export interface ChannelPromptEngineOptions {
  runtime: ChannelRuntime;
  context: ChannelContext;
  contextKey: string;
  promptDescription: string;
  abortAction?: string;
  trimMessage: (text: string) => string;
  splitMessage: (text: string) => string[];
  editDebounceMs: number;
  typingIntervalMs: number;
  toolVerbosity: ToolVerbosity;
  logPrefix: string;
  onResponseMessage?: (messageId: string) => void;
  onToolStart?: (toolName: string) => void;
  onToolEnd?: (isError: boolean) => void;
}

export interface ChannelPromptEngine {
  turnId: string;
  startedAt: number;
  progress: TurnProgress;
  callbacks: AgentSessionCallbacks;
  accumulatedText(): string;
  start(): void;
  stop(): void;
  finalize(): Promise<void>;
  fail(text: string): Promise<void>;
}

export function createChannelPromptEngine(options: ChannelPromptEngineOptions): ChannelPromptEngine {
  const lifecycle = createChannelTurnLifecycle(options.promptDescription);
  const { progress, startedAt, turnId } = lifecycle;

  let accumulated = "";
  let responseMessageId: string | undefined;
  let planMessageId: string | undefined;
  let flushTimer: NodeJS.Timeout | undefined;
  const typingLoop = createChannelTypingLoop({
    intervalMs: options.typingIntervalMs,
    sendTyping: () => options.runtime.sendTyping(options.context),
  });
  let lastEditAt = 0;
  let running = false;
  let finalized = false;

  const buttons = options.abortAction
    ? [[{ label: "Abort", action: options.abortAction }]]
    : undefined;

  const clearFlushTimer = (): void => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
  };

  const ensureResponse = async (): Promise<void> => {
    if (responseMessageId) {
      return;
    }
    const preview = options.trimMessage(accumulated || "Working...");
    const sent = await options.runtime.sendMessage(options.context, {
      text: preview,
      fallbackText: preview,
      buttons,
    });
    responseMessageId = sent.messageId;
    options.onResponseMessage?.(responseMessageId);
    lastEditAt = Date.now();
  };

  const flushResponse = async (force = false): Promise<void> => {
    if (!accumulated.trim()) {
      return;
    }
    await ensureResponse();
    if (!responseMessageId) {
      return;
    }
    const now = Date.now();
    if (!force && now - lastEditAt < options.editDebounceMs) {
      return;
    }
    const rendered = options.trimMessage(accumulated);
    await options.runtime.editMessage(options.context, responseMessageId, {
      text: rendered,
      fallbackText: rendered,
      buttons,
    });
    lastEditAt = Date.now();
  };

  const scheduleFlush = (): void => {
    if (flushTimer || !running) {
      return;
    }
    const delay = Math.max(0, options.editDebounceMs - (Date.now() - lastEditAt));
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      void flushResponse().catch((error) => console.error(`Failed to edit ${options.logPrefix} response:`, error));
    }, delay);
    flushTimer.unref?.();
  };

  const stop = (): void => {
    running = false;
    typingLoop.stop();
    clearFlushTimer();
  };

  const finalize = async (): Promise<void> => {
    if (finalized) {
      return;
    }
    finalized = true;
    lifecycle.recordCompleted();
    stop();
    const finalText = accumulated.trim() || "Done.";
    const chunks = options.splitMessage(finalText);
    if (responseMessageId) {
      const [first, ...rest] = chunks;
      await options.runtime.editMessage(options.context, responseMessageId, {
        text: first ?? "Done.",
        fallbackText: first ?? "Done.",
      });
      for (const chunk of rest) {
        await options.runtime.sendMessage(options.context, { text: chunk, fallbackText: chunk });
      }
      return;
    }
    for (const chunk of chunks) {
      await options.runtime.sendMessage(options.context, { text: chunk, fallbackText: chunk });
    }
  };

  const fail = async (text: string): Promise<void> => {
    finalized = true;
    lifecycle.recordFailed(text);
    stop();
    const rendered = options.trimMessage(text);
    if (responseMessageId) {
      await options.runtime.editMessage(options.context, responseMessageId, {
        text: rendered,
        fallbackText: rendered,
      }).catch(() => {});
      return;
    }
    await options.runtime.sendMessage(options.context, {
      text: rendered,
      fallbackText: rendered,
    }).catch(() => {});
  };

  const callbacks: AgentSessionCallbacks = {
    onTextDelta: (delta) => {
      accumulated += delta;
      lifecycle.recordTextDelta(delta.length);
      void ensureResponse()
        .then(() => scheduleFlush())
        .catch((error) => console.error(`Failed to send ${options.logPrefix} response:`, error));
    },
    onToolStart: (toolName) => {
      lifecycle.recordToolStart(toolName);
      options.onToolStart?.(toolName);
      if (options.toolVerbosity === "all") {
        const text = `Tool started: ${toolName}`;
        void options.runtime.sendMessage(options.context, { text, fallbackText: text }).catch(() => {});
      }
    },
    onToolUpdate: () => {
      lifecycle.recordToolUpdate();
    },
    onToolEnd: (_toolCallId, isError) => {
      lifecycle.recordToolEnd();
      options.onToolEnd?.(isError);
    },
    onTodoUpdate: (items) => {
      lifecycle.touch();
      const text = [
        "Plan:",
        ...items.map((item) => `${item.completed ? "[x]" : "[ ]"} ${item.text}`),
      ].join("\n");
      if (!planMessageId) {
        void options.runtime.sendMessage(options.context, { text, fallbackText: text }).then((result) => {
          planMessageId = result.messageId;
        }).catch(() => {});
      } else {
        void options.runtime.editMessage(options.context, planMessageId, { text, fallbackText: text }).catch(() => {});
      }
    },
    onTurnComplete: () => {},
    onAgentEnd: () => {
      lifecycle.recordCompleted();
      void finalize().catch((error) => console.error(`Failed to finalize ${options.logPrefix} response:`, error));
    },
  };

  return {
    turnId,
    startedAt,
    progress,
    callbacks,
    accumulatedText: () => accumulated,
    start: () => {
      if (running) {
        return;
      }
      running = true;
      typingLoop.start();
    },
    stop,
    finalize,
    fail,
  };
}
