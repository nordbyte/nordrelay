import { randomUUID } from "node:crypto";

import type { AgentSessionCallbacks } from "./agent.js";
import type { TurnProgress } from "./bot-rendering.js";
import type { ChannelContext, ChannelRuntime } from "./channel-adapter.js";
import type { ToolVerbosity } from "./config.js";

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
  const toolCounts = new Map<string, number>();
  const startedAt = Date.now();
  const turnId = randomUUID().slice(0, 12);
  const progress: TurnProgress = {
    status: "running",
    promptDescription: options.promptDescription,
    startedAt,
    updatedAt: startedAt,
    toolCounts,
    textCharacters: 0,
  };

  let accumulated = "";
  let responseMessageId: string | undefined;
  let planMessageId: string | undefined;
  let flushTimer: NodeJS.Timeout | undefined;
  let typingTimer: NodeJS.Timeout | undefined;
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
    if (typingTimer) {
      clearInterval(typingTimer);
      typingTimer = undefined;
    }
    clearFlushTimer();
  };

  const finalize = async (): Promise<void> => {
    if (finalized) {
      return;
    }
    finalized = true;
    progress.status = "completed";
    progress.completedAt = Date.now();
    progress.updatedAt = progress.completedAt;
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
    progress.status = "failed";
    progress.completedAt = Date.now();
    progress.updatedAt = progress.completedAt;
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
      progress.textCharacters = accumulated.length;
      progress.updatedAt = Date.now();
      void ensureResponse()
        .then(() => scheduleFlush())
        .catch((error) => console.error(`Failed to send ${options.logPrefix} response:`, error));
    },
    onToolStart: (toolName) => {
      toolCounts.set(toolName, (toolCounts.get(toolName) ?? 0) + 1);
      progress.currentTool = toolName;
      progress.lastTool = toolName;
      progress.updatedAt = Date.now();
      options.onToolStart?.(toolName);
      if (options.toolVerbosity === "all") {
        const text = `Tool started: ${toolName}`;
        void options.runtime.sendMessage(options.context, { text, fallbackText: text }).catch(() => {});
      }
    },
    onToolUpdate: () => {
      progress.updatedAt = Date.now();
    },
    onToolEnd: (_toolCallId, isError) => {
      progress.currentTool = undefined;
      progress.updatedAt = Date.now();
      options.onToolEnd?.(isError);
    },
    onTodoUpdate: (items) => {
      progress.updatedAt = Date.now();
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
      progress.status = "completed";
      progress.completedAt = Date.now();
      progress.updatedAt = progress.completedAt;
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
      typingTimer = setInterval(() => {
        void options.runtime.sendTyping(options.context).catch(() => {});
      }, options.typingIntervalMs);
      typingTimer.unref?.();
      void options.runtime.sendTyping(options.context).catch(() => {});
    },
    stop,
    finalize,
    fail,
  };
}
