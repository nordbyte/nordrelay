import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { WebActivityStore, WebChatStore } from "../src/web/web-state.js";

describe("web dashboard state stores", () => {
  it("persists chat messages per thread", () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "nordrelay-web-chat-"));
    try {
      const store = new WebChatStore(workspace, "json", 5);
      store.append({
        threadId: "thread-a",
        role: "user",
        text: "hello",
        meta: ["1 image", "staged file input"],
        attachments: [{
          id: "screenshot.png",
          kind: "image",
          name: "screenshot.png",
          mimeType: "image/png",
          sizeBytes: 123,
          turnId: "turn-a",
        }],
        source: "web",
      });
      store.append({
        threadId: "thread-b",
        role: "user",
        text: "other",
        source: "cli",
      });

      const reloaded = new WebChatStore(workspace, "json", 5);
      expect(reloaded.list("thread-a")).toMatchObject([{
        text: "hello",
        meta: ["1 image", "staged file input"],
        attachments: [{
          id: "screenshot.png",
          kind: "image",
          name: "screenshot.png",
          mimeType: "image/png",
          sizeBytes: 123,
          turnId: "turn-a",
        }],
        source: "web",
      }]);
      expect(reloaded.list("thread-b")).toMatchObject([{ text: "other", source: "cli" }]);
      expect(reloaded.clear("thread-a")).toBe(1);
      expect(reloaded.list("thread-a")).toEqual([]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("deduplicates repeated chat messages for the same turn", () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "nordrelay-web-chat-dedupe-"));
    try {
      const store = new WebChatStore(workspace, "json", 10);
      const first = store.appendWithResult({
        threadId: "thread-a",
        role: "user",
        text: "same prompt",
        source: "cli",
        turnId: "turn-1",
        timestamp: "2026-05-15T16:23:03.000Z",
      });
      const second = store.appendWithResult({
        threadId: "thread-a",
        role: "user",
        text: "same prompt",
        source: "cli",
        turnId: "turn-1",
        timestamp: "2026-05-15T16:23:03.000Z",
      });

      expect(first.inserted).toBe(true);
      expect(second.inserted).toBe(false);
      expect(second.message.id).toBe(first.message.id);
      expect(store.list("thread-a")).toHaveLength(1);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("deduplicates CLI mirror finals already included in a channel response", () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "nordrelay-web-chat-mirror-dedupe-"));
    try {
      const store = new WebChatStore(workspace, "json", 10);
      const finalText = [
        "Empfohlene Prioritaeten",
        "1. Command Palette fuer schnelle Navigation.",
        "2. Workflow Engine mit Approval Steps.",
        "3. Peer Scheduler fuer entfernte Hosts.",
      ].join("\n");
      store.append({
        threadId: "thread-a",
        role: "agent",
        text: `Ich pruefe die Codebase.\n${finalText}`,
        source: "web",
        turnId: "web-turn",
        timestamp: "2026-05-17T10:17:32.000Z",
      });
      const mirrored = store.appendWithResult({
        threadId: "thread-a",
        role: "agent",
        text: finalText,
        source: "cli",
        turnId: "cli-turn",
        timestamp: "2026-05-17T10:17:35.000Z",
      });

      expect(mirrored.inserted).toBe(false);
      expect(store.list("thread-a")).toHaveLength(1);
      expect(store.list("thread-a")[0]).toMatchObject({ source: "web" });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("deduplicates CLI mirror finals already captured as live CLI agent messages", () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "nordrelay-web-chat-cli-final-dedupe-"));
    try {
      const store = new WebChatStore(workspace, "json", 10);
      const liveText = "Ich pruefe die Dateien und entferne die doppelte finale Mirror-Nachricht aus dem Web-Chat, damit derselbe CLI-Turn nicht als zweite zusammengefasste Antwort sichtbar wird.";
      const finalText = [
        liveText,
        "Danach validiere ich die Aenderung mit einem fokussierten Testlauf.",
        "Damit bleibt nur eine Agent-Nachricht fuer denselben CLI-Turn sichtbar.",
      ].join("\n");
      store.append({
        threadId: "thread-a",
        role: "agent",
        text: liveText,
        source: "cli",
        correlationId: "external-correlation",
        turnId: "turn-1",
        timestamp: "2026-05-17T10:17:32.000Z",
      });
      const mirrored = store.appendWithResult({
        threadId: "thread-a",
        role: "agent",
        text: finalText,
        source: "cli",
        correlationId: "external-correlation",
        turnId: "turn-1",
        timestamp: "2026-05-17T10:17:35.000Z",
      });

      expect(mirrored.inserted).toBe(false);
      expect(store.list("thread-a")).toHaveLength(1);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("upserts keyed chat messages for live status rows", () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "nordrelay-web-chat-upsert-"));
    try {
      const store = new WebChatStore(workspace, "json", 10);
      const first = store.upsertByKey({
        threadId: "thread-a",
        role: "system",
        text: "running 1s",
        source: "cli",
        key: "status:turn-1",
      });
      const second = store.upsertByKey({
        threadId: "thread-a",
        role: "system",
        text: "running 2s",
        source: "cli",
        key: "status:turn-1",
      });

      expect(first.inserted).toBe(true);
      expect(second.updated).toBe(true);
      expect(second.message.id).toBe(first.message.id);
      expect(store.list("thread-a")).toMatchObject([{ text: "running 2s", key: "status:turn-1" }]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("replaces resolved approval actions with the selected option", () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "nordrelay-web-chat-approval-"));
    try {
      const store = new WebChatStore(workspace, "json", 10);
      store.upsertByKey({
        threadId: "thread-a",
        role: "system",
        text: "Action required",
        source: "cli",
        key: "approval:1",
        actions: [
          { label: "Proceed", action: "approval:yes:abc123", style: "primary" },
          { label: "Proceed and remember", action: "approval:persist:abc123" },
          { label: "Deny", action: "approval:no:abc123", style: "danger" },
        ],
      });

      expect(store.resolveAction({
        threadId: "thread-a",
        actionPrefix: "approval:",
        actionId: "abc123",
        label: "Selected: Proceed",
        resolvedAt: "2026-05-21T08:30:00.000Z",
      })).toBe(1);

      const resolved = store.list("thread-a")[0];
      expect(resolved?.actions).toBeUndefined();
      expect(resolved).toMatchObject({
        actionResolution: {
          actionId: "abc123",
          label: "Selected: Proceed",
          resolvedAt: "2026-05-21T08:30:00.000Z",
        },
      });

      store.upsertByKey({
        threadId: "thread-a",
        role: "system",
        text: "Action required",
        source: "cli",
        key: "approval:1",
        actions: [
          { label: "Proceed", action: "approval:yes:abc123", style: "primary" },
          { label: "Deny", action: "approval:no:abc123", style: "danger" },
        ],
      });

      const preserved = store.list("thread-a")[0];
      expect(preserved?.actions).toBeUndefined();
      expect(preserved).toMatchObject({
        actionResolution: {
          actionId: "abc123",
          label: "Selected: Proceed",
        },
      });
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
      const firstPage = store.listPage({ limit: 1 });
      expect(firstPage.items).toHaveLength(1);
      expect(firstPage.pagination.hasNext).toBe(true);
      const secondPage = store.listPage({ limit: 1, cursor: firstPage.pagination.nextCursor ?? undefined });
      expect(secondPage.items).toHaveLength(1);
      expect(secondPage.items[0]?.id).not.toBe(firstPage.items[0]?.id);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("finds chat and activity events by correlation id", () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "nordrelay-web-trace-"));
    try {
      const chat = new WebChatStore(workspace, "json", 10);
      const activity = new WebActivityStore(workspace, "json", 10);
      chat.append({ threadId: "thread-a", role: "user", text: "trace me", source: "web", correlationId: "cid-1" });
      chat.append({ threadId: "thread-a", role: "agent", text: "other", source: "web", correlationId: "cid-2" });
      activity.append({ source: "web", status: "running", type: "prompt_started", threadId: "thread-a", correlationId: "cid-1" });

      expect(chat.findByCorrelationId("cid-1")).toMatchObject([{ text: "trace me" }]);
      expect(activity.findByCorrelationId("cid-1")).toMatchObject([{ type: "prompt_started" }]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
