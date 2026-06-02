import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { PromptStore, toPromptEnvelope } from "../src/state/prompt-store.js";
import { RelayQueueService } from "../src/runtime/relay-queue-service.js";

describe("RelayQueueService", () => {
  it("counts only waiting prompts as queue items", () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "nordrelay-relay-queue-"));
    try {
      const store = new PromptStore(workspace);
      const service = new RelayQueueService(store, "web:dashboard");
      const first = service.enqueue(toPromptEnvelope("first"));
      const second = service.enqueue(toPromptEnvelope("second"));

      expect(service.length()).toBe(2);
      expect(service.list().map((item) => item.id)).toEqual([first.id, second.id]);

      const leased = service.leaseNext("owner-a", 60_000);

      expect(leased?.id).toBe(first.id);
      expect(service.length()).toBe(1);
      expect(service.list().map((item) => item.id)).toEqual([second.id]);
      expect(service.rawList().map((item) => [item.id, item.status])).toEqual([
        [first.id, "running"],
        [second.id, "queued"],
      ]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
