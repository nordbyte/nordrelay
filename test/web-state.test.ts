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
        source: "telegram",
        status: "queued",
        type: "prompt_queued",
        threadId: "thread-a",
        workspace: "/repo/a",
        agentId: "codex",
        actor: {
          channel: "telegram",
          id: "user-1",
          label: "Ricardo",
          username: "ricardo@example.com",
          channelUserId: "123456789",
        },
      });
      store.append({
        source: "cli",
        status: "completed",
        type: "cli_tool_completed",
        threadId: "thread-a",
        workspace: "/repo/a",
        agentId: "codex",
        actor: {
          channel: "cli",
          label: "CLI",
        },
      });

      expect(store.list({ source: "telegram" })[0]).toMatchObject({
        category: "prompt",
        actor: { label: "Ricardo" },
      });
      expect(store.list({ category: "tool" })[0]).toMatchObject({
        source: "cli",
        type: "cli_tool_completed",
      });
      expect(store.list({ status: "completed" })[0]?.source).toBe("cli");
      expect(store.list({ actor: "ricardo@example.com" })[0]?.source).toBe("telegram");
      expect(store.list({ actor: "123456789" })[0]?.source).toBe("telegram");
      expect(store.list({ agentId: "codex", threadId: "thread-a", workspace: "/repo/a", type: "tool" })[0]?.source).toBe("cli");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
