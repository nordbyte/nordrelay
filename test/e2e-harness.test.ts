import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { listAgentAdapterDescriptors } from "../src/agent-adapter.js";
import { TelegramChannelAdapter, listChannelDescriptors, type ChannelInboundMessage } from "../src/channel-adapter.js";
import { ChannelCommandRouter, InMemoryChannelRuntime, deliverChannelAction } from "../src/channel-runtime.js";
import { AuditLogStore } from "../src/audit-log.js";
import { SessionLockStore, canWriteWithLock } from "../src/session-locks.js";
import { createDocumentStore } from "../src/state-backend.js";

const require = createRequire(import.meta.url);
const sqliteAvailable = (() => {
  try {
    require("better-sqlite3");
    return true;
  } catch {
    return false;
  }
})();

describe("adapter and e2e harness primitives", () => {
  it("exposes Telegram as the available channel and future channels as planned adapters", () => {
    const channels = listChannelDescriptors();

    expect(channels.find((channel) => channel.id === "telegram")?.status).toBe("available");
    expect(channels.find((channel) => channel.id === "discord")?.status).toBe("planned");
    expect(new TelegramChannelAdapter().capabilities.has("typing")).toBe(true);
  });

  it("exposes Codex, Pi, Hermes, OpenClaw, and Claude Code agent adapter descriptors", () => {
    const agents = listAgentAdapterDescriptors();

    expect(agents.find((agent) => agent.id === "codex")?.status).toBe("available");
    expect(agents.find((agent) => agent.id === "pi")?.status).toBe("available");
    expect(agents.find((agent) => agent.id === "hermes")?.status).toBe("available");
    expect(agents.find((agent) => agent.id === "openclaw")?.status).toBe("available");
    expect(agents.find((agent) => agent.id === "claude-code")?.status).toBe("available");
  });

  it("can run a fake channel message through an end-to-end harness", async () => {
    const harness = new FakeRelayHarness();
    await harness.receive({
      id: "m1",
      context: { channelId: "telegram", chatId: "123", userId: "42" },
      text: "hello",
    });

    expect(harness.outbox).toEqual(["typing:123", "reply:HELLO"]);
  });

  it("routes a generic channel command to a generic channel runtime", async () => {
    const runtime = new InMemoryChannelRuntime({
      id: "matrix",
      label: "Matrix",
      capabilities: ["text", "inline-buttons"],
      status: "planned",
    });
    const router = new ChannelCommandRouter().command("channels", () => ({
      plain: "Channels listed",
      html: "<b>Channels listed</b>",
    }));

    const result = await router.dispatch({
      id: "m2",
      context: { channelId: "matrix", chatId: "!room" },
      text: "/channels",
    });
    if (result.response) {
      await deliverChannelAction(runtime, { channelId: "matrix", chatId: "!room" }, result.response);
    }

    expect(runtime.sentMessages[0]?.message.fallbackText).toBe("Channels listed");
  });
});

describe("state, audit, and lock stores", () => {
  it("persists JSON documents through the document store", () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "nordrelay-state-"));
    try {
      const store = createDocumentStore<{ value: number }>({
        workspace,
        fileName: "sample.json",
        sqliteKey: "sample",
        backend: "json",
      });

      store.write({ value: 7 });
      expect(store.read()).toEqual({ value: 7 });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  (sqliteAvailable ? it : it.skip)("creates the SQLite state directory before opening the database", () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "nordrelay-sqlite-state-"));
    const stateDir = path.join(workspace, ".nordrelay");
    let store: ReturnType<typeof createDocumentStore<{ value: number }>> | undefined;
    try {
      store = createDocumentStore<{ value: number }>({
        workspace,
        fileName: "sample.json",
        sqliteKey: "sample",
        backend: "sqlite",
      });

      expect(store.kind).toBe("sqlite");
      expect(existsSync(stateDir)).toBe(true);
      store.write({ value: 9 });
      expect(store.read()).toEqual({ value: 9 });
    } finally {
      store?.close?.();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("records audit events and enforces session locks", () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "nordrelay-audit-"));
    try {
      const audit = new AuditLogStore(workspace, "json", 5);
      const event = audit.append({
        action: "prompt_started",
        status: "ok",
        contextKey: "123",
        actorId: 42,
        description: "test",
      });
      expect(event.id).toHaveLength(12);
      expect(event.channelId).toBe("telegram");
      const webEvent = audit.append({
        action: "command",
        status: "ok",
        contextKey: "web:dashboard",
        channelId: "web",
        description: "dashboard",
      });
      expect(webEvent.channelId).toBe("web");
      expect(audit.list(2).map((item) => item.description)).toEqual(["dashboard", "test"]);

      const locks = new SessionLockStore(workspace, "json");
      const lock = locks.set("123", 42, "Ricardo", 60_000);
      expect(canWriteWithLock(lock, 42, false)).toBe(true);
      expect(canWriteWithLock(lock, 7, false)).toBe(false);
      expect(canWriteWithLock(lock, 7, true)).toBe(true);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

class FakeRelayHarness {
  readonly outbox: string[] = [];

  async receive(message: ChannelInboundMessage): Promise<void> {
    this.outbox.push(`typing:${message.context.chatId}`);
    const text = message.text ?? "";
    this.outbox.push(`reply:${text.toUpperCase()}`);
  }
}
