import { randomUUID } from "node:crypto";

import type { TurnProgress } from "./bot-rendering.js";

export interface ChannelTurnLifecycle {
  turnId: string;
  startedAt: number;
  progress: TurnProgress;
  touch(): void;
  recordTextDelta(characters: number): void;
  recordToolStart(toolName: string): void;
  recordToolUpdate(): void;
  recordToolEnd(): void;
  recordCompleted(): void;
  recordFailed(error?: string): void;
}

export interface ChannelTypingLoop {
  start(): void;
  stop(): void;
}

export function createChannelTurnLifecycle(promptDescription: string): ChannelTurnLifecycle {
  const startedAt = Date.now();
  const turnId = randomUUID().slice(0, 12);
  const progress: TurnProgress = {
    status: "running",
    promptDescription,
    startedAt,
    updatedAt: startedAt,
    toolCounts: new Map<string, number>(),
    textCharacters: 0,
  };

  const touch = (): void => {
    progress.updatedAt = Date.now();
  };

  return {
    turnId,
    startedAt,
    progress,
    touch,
    recordTextDelta: (characters: number) => {
      progress.textCharacters += Math.max(0, characters);
      touch();
    },
    recordToolStart: (toolName: string) => {
      progress.currentTool = toolName;
      progress.lastTool = toolName;
      progress.toolCounts.set(toolName, (progress.toolCounts.get(toolName) ?? 0) + 1);
      touch();
    },
    recordToolUpdate: touch,
    recordToolEnd: () => {
      progress.currentTool = undefined;
      touch();
    },
    recordCompleted: () => {
      progress.status = "completed";
      progress.completedAt = Date.now();
      progress.updatedAt = progress.completedAt;
    },
    recordFailed: (error?: string) => {
      progress.status = "failed";
      progress.error = error;
      progress.completedAt = Date.now();
      progress.updatedAt = progress.completedAt;
    },
  };
}

export function createChannelTypingLoop(options: {
  intervalMs: number;
  sendTyping: () => Promise<void>;
}): ChannelTypingLoop {
  let timer: NodeJS.Timeout | undefined;
  let running = false;

  const sendTyping = (): void => {
    void options.sendTyping().catch(() => {});
  };

  return {
    start: () => {
      if (running) {
        return;
      }
      running = true;
      timer = setInterval(sendTyping, options.intervalMs);
      timer.unref?.();
      sendTyping();
    },
    stop: () => {
      running = false;
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    },
  };
}
