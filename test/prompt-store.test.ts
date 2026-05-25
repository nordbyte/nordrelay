import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ensurePromptCorrelationId, PromptStore, toPromptEnvelope } from "../src/state/prompt-store.js";
import { stateBackendPath } from "../src/state/state-backend.js";

describe("PromptStore", () => {
  it("persists last prompts and queues", () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "prompt-store-"));
    try {
      const store = new PromptStore(workspace);
      store.setLastPrompt("123", toPromptEnvelope("hello"));
      const envelope = toPromptEnvelope({ text: "queued", imagePaths: ["/tmp/a.png"] });
      envelope.attachments = [{
        id: "a.png",
        kind: "image",
        name: "a.png",
        mimeType: "image/png",
        sizeBytes: 42,
        turnId: "turn-a",
      }];
      const queued = store.enqueue("123", envelope);

      const loaded = new PromptStore(workspace);

      expect(loaded.getLastPrompt("123")?.input).toBe("hello");
      expect(loaded.list("123")).toEqual([
        expect.objectContaining({
          id: queued.id,
          description: "queued · 1 image",
          displayText: "queued",
          displayMeta: ["1 image"],
          attachments: envelope.attachments,
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

  it("preserves independent queue writes from multiple JSON store instances", () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "prompt-store-"));
    try {
      const first = new PromptStore(workspace);
      const second = new PromptStore(workspace);

      const queuedA = first.enqueue("ctx-a", toPromptEnvelope("from first"));
      const queuedB = second.enqueue("ctx-b", toPromptEnvelope("from second"));

      const loaded = new PromptStore(workspace);
      expect(loaded.list("ctx-a").map((item) => item.id)).toEqual([queuedA.id]);
      expect(loaded.list("ctx-b").map((item) => item.id)).toEqual([queuedB.id]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("requeues an in-flight queued prompt without duplicating it", () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "prompt-store-"));
    try {
      const store = new PromptStore(workspace);
      const queued = store.enqueue("ctx", toPromptEnvelope("queued"));
      const next = store.dequeue("ctx");
      expect(next?.id).toBe(queued.id);

      store.enqueueFront("ctx", next!);
      store.enqueueFront("ctx", next!);

      expect(store.list("ctx").map((item) => item.id)).toEqual([queued.id]);
      expect(store.list("ctx")[0]?.attempts).toBe(1);
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

      const persistPath = stateBackendPath(workspace, "json", "prompts.json");
      writeFileSync(persistPath, "{not-json", "utf8");

      const loaded = new PromptStore(workspace);

      expect(loaded.getLastPrompt("123")?.input).toBe("first");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
