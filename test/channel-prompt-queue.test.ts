import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { queueChannelPromptIfBusy } from "../src/channels/shared/channel-prompt-queue.js";
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
});
