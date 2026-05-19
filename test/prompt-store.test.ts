import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ensurePromptCorrelationId, PromptStore, toPromptEnvelope } from "../src/state/prompt-store.js";

describe("PromptStore", () => {
  it("persists last prompts and queues", () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "prompt-store-"));
    try {
      const store = new PromptStore(workspace);
      store.setLastPrompt("123", toPromptEnvelope("hello"));
      const queued = store.enqueue("123", toPromptEnvelope({ text: "queued", imagePaths: ["/tmp/a.png"] }));

      const loaded = new PromptStore(workspace);

      expect(loaded.getLastPrompt("123")?.input).toBe("hello");
      expect(loaded.list("123")).toEqual([
        expect.objectContaining({
          id: queued.id,
          description: "queued · 1 image",
          displayText: "queued",
          displayMeta: ["1 image"],
        }),
      ]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("adds stable correlation ids to prompt envelopes and queued prompts", () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "prompt-store-"));
    try {
      const store = new PromptStore(workspace);
      const envelope = ensurePromptCorrelationId(toPromptEnvelope("trace me"));
      const queued = store.enqueue("123", envelope);
      const loaded = new PromptStore(workspace);

      expect(envelope.correlationId).toMatch(/^[a-f0-9]{12}$/);
      expect(queued.correlationId).toBe(envelope.correlationId);
      expect(loaded.list("123")[0]?.correlationId).toBe(envelope.correlationId);
      expect(ensurePromptCorrelationId(envelope).correlationId).toBe(envelope.correlationId);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("removes and clears queued prompts", () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "prompt-store-"));
    try {
      const store = new PromptStore(workspace);
      const first = store.enqueue("123", toPromptEnvelope("first"));
      store.enqueue("123", toPromptEnvelope("second"));

      expect(store.remove("123", first.id)?.description).toBe("first");
      expect(store.list("123")).toHaveLength(1);
      expect(store.clear("123")).toBe(1);
      expect(store.list("123")).toEqual([]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("moves prompts, pauses contexts, and persists queue control state", () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "prompt-store-"));
    try {
      const store = new PromptStore(workspace);
      const first = store.enqueue("123", toPromptEnvelope("first"));
      const second = store.enqueue("123", toPromptEnvelope("second"));
      store.pause("123");

      expect(store.moveToTop("123", second.id)?.id).toBe(second.id);
      expect(store.list("123").map((item) => item.id)).toEqual([second.id, first.id]);
      expect(store.listContextKeys()).toEqual(["123"]);
      expect(store.isPaused("123")).toBe(true);

      const loaded = new PromptStore(workspace);
      expect(loaded.list("123").map((item) => item.id)).toEqual([second.id, first.id]);
      expect(loaded.isPaused("123")).toBe(true);

      loaded.resume("123");
      expect(loaded.isPaused("123")).toBe(false);
      loaded.enqueueFront("123", first);
      expect(loaded.list("123")[0]?.id).toBe(first.id);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("skips scheduled prompts until they are due", () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "prompt-store-"));
    try {
      const store = new PromptStore(workspace);
      const scheduled = store.enqueue("123", toPromptEnvelope("later"), { notBefore: Date.now() + 60_000 });
      const ready = store.enqueue("123", toPromptEnvelope("now"));

      expect(store.nextRunnableAt("123")).toBe(scheduled.notBefore);
      expect(store.get("123", scheduled.id)?.description).toBe("later");
      expect(store.dequeue("123")?.id).toBe(ready.id);
      expect(store.dequeue("123")).toBeUndefined();
      expect(store.list("123").map((item) => item.id)).toEqual([scheduled.id]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("recovers persisted prompts from the atomic-write backup", () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "prompt-store-"));
    try {
      const store = new PromptStore(workspace);
      store.setLastPrompt("123", toPromptEnvelope("first"));
      store.setLastPrompt("123", toPromptEnvelope("second"));

      const persistPath = path.join(workspace, ".nordrelay", "prompts.json");
      writeFileSync(persistPath, "{not-json", "utf8");

      const loaded = new PromptStore(workspace);

      expect(loaded.getLastPrompt("123")?.input).toBe("first");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
