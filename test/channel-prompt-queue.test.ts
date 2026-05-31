import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { drainOneQueuedChannelPrompt, queueChannelPromptIfBusy } from "../src/channels/shared/channel-prompt-queue.js";
import { PromptStore, toPromptEnvelope } from "../src/state/prompt-store.js";

describe("channel prompt queue", () => {
  it("requeues a dequeued prompt when a queued turn races with busy state", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "channel-prompt-queue-"));
    try {
      const promptStore = new PromptStore(workspace);
      const contextKey = "discord:test";
      const queued = promptStore.enqueue(contextKey, toPromptEnvelope("queued prompt"));
      const dequeued = promptStore.dequeue(contextKey);
      expect(dequeued?.id).toBe(queued.id);

      const replies: string[] = [];
      const wasQueued = await queueChannelPromptIfBusy({
        request: { contextKey, context: { channelId: "discord", chatId: "channel" } },
        envelope: dequeued!,
        fromQueue: true,
        promptStore,
        busy: { busy: true, kind: "internal", agentLabel: "Codex" },
        actionPrefix: "discord",
        reply: async (_request, text) => {
          replies.push(text);
        },
        appendActivity: () => undefined,
        audit: () => undefined,
      });

      expect(wasQueued).toBe(true);
      expect(replies[0]).toContain("position 1");
      expect(promptStore.list(contextKey).map((item) => item.id)).toEqual([queued.id]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("drains only one queued prompt per drain cycle", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "channel-prompt-queue-"));
    try {
      const promptStore = new PromptStore(workspace);
      const contextKey = "discord:test";
      const first = promptStore.enqueue(contextKey, toPromptEnvelope("first queued"));
      const second = promptStore.enqueue(contextKey, toPromptEnvelope("second queued"));
      const draining = new Set<string>();
      const processed: string[] = [];
      let followUpScheduled = 0;

      await drainOneQueuedChannelPrompt({
        request: { contextKey, context: { channelId: "discord", chatId: "channel" } },
        promptStore,
        draining,
        isBusy: () => false,
        onProcessing: async () => undefined,
        runPrompt: async (_request, item) => {
          processed.push(item.id);
        },
        scheduleNext: () => {
          followUpScheduled += 1;
        },
      });

      expect(processed).toEqual([first.id]);
      expect(promptStore.list(contextKey).map((item) => item.id)).toEqual([second.id]);
      expect(followUpScheduled).toBe(1);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("does not dequeue a prompt while the channel is busy", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "channel-prompt-queue-"));
    try {
      const promptStore = new PromptStore(workspace);
      const contextKey = "discord:test";
      const queued = promptStore.enqueue(contextKey, toPromptEnvelope("queued"));
      const processed: string[] = [];

      await drainOneQueuedChannelPrompt({
        request: { contextKey, context: { channelId: "discord", chatId: "channel" } },
        promptStore,
        draining: new Set<string>(),
        isBusy: () => true,
        onProcessing: async () => undefined,
        runPrompt: async (_request, item) => {
          processed.push(item.id);
        },
      });

      expect(processed).toEqual([]);
      expect(promptStore.list(contextKey).map((item) => item.id)).toEqual([queued.id]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("returns a leased prompt to the queue when processing fails", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "channel-prompt-queue-"));
    try {
      const promptStore = new PromptStore(workspace);
      const contextKey = "discord:test";
      const queued = promptStore.enqueue(contextKey, toPromptEnvelope("queued"));

      await expect(drainOneQueuedChannelPrompt({
        request: { contextKey, context: { channelId: "discord", chatId: "channel" } },
        promptStore,
        draining: new Set<string>(),
        isBusy: () => false,
        onProcessing: async () => undefined,
        runPrompt: async () => {
          throw new Error("turn failed");
        },
      })).rejects.toThrow("turn failed");

      expect(promptStore.list(contextKey)).toEqual([
        expect.objectContaining({ id: queued.id, status: "queued", attempts: 1, lastError: "turn failed" }),
      ]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
