import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { WebActivityStore, WebChatStore } from "../src/web-state.js";

describe("web dashboard state stores", () => {
  it("persists chat messages per thread", () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "nordrelay-web-chat-"));
    try {
      const store = new WebChatStore(workspace, "json", 5);
      store.append({
        threadId: "thread-a",
        role: "user",
        text: "hello",
        source: "web",
      });
      store.append({
        threadId: "thread-b",
        role: "user",
        text: "other",
        source: "cli",
      });

      const reloaded = new WebChatStore(workspace, "json", 5);
      expect(reloaded.list("thread-a")).toMatchObject([{ text: "hello", source: "web" }]);
      expect(reloaded.list("thread-b")).toMatchObject([{ text: "other", source: "cli" }]);
      expect(reloaded.clear("thread-a")).toBe(1);
      expect(reloaded.list("thread-a")).toEqual([]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("filters activity timeline events", () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "nordrelay-web-activity-"));
    try {
      const store = new WebActivityStore(workspace, "json", 10);
      store.append({
        source: "web",
        status: "queued",
        type: "prompt_queued",
        threadId: "thread-a",
      });
      store.append({
        source: "cli",
        status: "completed",
        type: "cli_turn_finished",
        threadId: "thread-a",
      });

      expect(store.list({ source: "web" })).toHaveLength(1);
      expect(store.list({ status: "completed" })[0]?.source).toBe("cli");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
