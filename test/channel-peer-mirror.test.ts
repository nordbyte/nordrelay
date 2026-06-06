import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createChannelPeerMirrorController, type ChannelPeerMirrorRemoteClient } from "../src/channels/shared/channel-peer-mirror.js";
import type { ChannelContext, ChannelRuntime } from "../src/channels/shared/channel-adapter.js";
import type { PeerEventEnvelope } from "../src/peers/peer-types.js";
import type { ActiveSessionDto, RelaySnapshot } from "../src/runtime/relay-runtime-types.js";
import { BotPreferencesStore } from "../src/state/bot-preferences.js";

class FakeRemoteClient implements ChannelPeerMirrorRemoteClient {
  callback: ((event: PeerEventEnvelope) => void) | null = null;
  closed = false;

  subscribe(
    _peerId: string,
    onEvent: (event: PeerEventEnvelope) => void,
  ): { close: () => void } {
    this.callback = onEvent;
    return {
      close: () => {
        this.closed = true;
      },
    };
  }

  emit(event: PeerEventEnvelope): void {
    this.callback?.(event);
  }
}

describe("ChannelPeerMirrorController", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(path.join(tmpdir(), "nordrelay-peer-mirror-"));
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("mirrors remote active session status updates for status mode", async () => {
    const preferences = new BotPreferencesStore(workspace);
    preferences.update("123", { targetPeerId: "peer-1", mirrorMode: "status" });
    const client = new FakeRemoteClient();
    const sent: string[] = [];
    const edited: string[] = [];
    let typing = 0;
    const runtime = fakeRuntime({
      sendMessage: async (_context, message) => {
        sent.push(message.text);
        return { messageId: `message-${sent.length}` };
      },
      editMessage: async (_context, _messageId, message) => {
        edited.push(message.text);
      },
      sendTyping: async () => {
        typing++;
      },
    });
    const controller = createChannelPeerMirrorController({
      label: "Telegram",
      runtime,
      preferencesStore: preferences,
      remoteClient: client,
      contextForKey: () => context(),
      defaultMirrorMode: () => "status",
      mirrorMinUpdateMs: 0,
      typingIntervalMs: 1000,
    });

    controller.sync("123", context());
    client.emit(snapshot("thread-a"));
    client.emit({
      type: "active_sessions_update",
      active: {
        updatedAt: new Date().toISOString(),
        sessions: [
          activeSession("thread-b", "wrong prompt"),
          activeSession("thread-a", "target prompt"),
        ],
      },
    });
    await flushAsync();

    expect(typing).toBeGreaterThan(0);
    expect(sent.at(-1)).toContain("Remote info");
    expect(sent.at(-1)).toContain("target prompt");
    expect(sent.at(-1)).not.toContain("wrong prompt");

    client.emit({ type: "active_sessions_update", active: { updatedAt: new Date().toISOString(), sessions: [] } });
    await flushAsync();

    expect(edited.at(-1)).toContain("Codex CLI task finished.");
  });

  it("uses the persisted remote target thread for peer typing and status updates", async () => {
    const preferences = new BotPreferencesStore(workspace);
    preferences.update("123:456", {
      targetPeerId: "peer-1",
      targetThreadId: "thread-gitstars",
      targetAgentId: "codex",
      mirrorMode: "status",
    });
    const client = new FakeRemoteClient();
    const sent: string[] = [];
    let typing = 0;
    const runtime = fakeRuntime({
      sendMessage: async (_context, message) => {
        sent.push(message.text);
        return { messageId: `message-${sent.length}` };
      },
      sendTyping: async () => {
        typing++;
      },
    });
    const controller = createChannelPeerMirrorController({
      label: "Telegram",
      runtime,
      preferencesStore: preferences,
      remoteClient: client,
      contextForKey: () => context({ topicId: "456" }),
      defaultMirrorMode: () => "status",
      mirrorMinUpdateMs: 0,
      typingIntervalMs: 1000,
    });

    controller.sync("123:456", context({ topicId: "456" }));
    client.emit(snapshot("thread-other"));
    client.emit({
      type: "active_sessions_update",
      active: {
        updatedAt: new Date().toISOString(),
        sessions: [
          activeSession("thread-other", "wrong prompt"),
          activeSession("thread-gitstars", "target prompt"),
        ],
      },
    });
    await flushAsync();

    expect(typing).toBeGreaterThan(0);
    expect(sent.at(-1)).toContain("target prompt");
    expect(sent.at(-1)).not.toContain("wrong prompt");
  });

  it("does not type for unrelated remote active sessions when a target thread is selected", async () => {
    const preferences = new BotPreferencesStore(workspace);
    preferences.update("123:456", {
      targetPeerId: "peer-1",
      targetThreadId: "thread-gitstars",
      targetAgentId: "codex",
      mirrorMode: "status",
    });
    const client = new FakeRemoteClient();
    let typing = 0;
    const runtime = fakeRuntime({
      sendTyping: async () => {
        typing++;
      },
    });
    const controller = createChannelPeerMirrorController({
      label: "Telegram",
      runtime,
      preferencesStore: preferences,
      remoteClient: client,
      contextForKey: () => context({ topicId: "456" }),
      defaultMirrorMode: () => "status",
      mirrorMinUpdateMs: 0,
      typingIntervalMs: 1000,
    });

    controller.sync("123:456", context({ topicId: "456" }));
    client.emit(snapshot("thread-other"));
    client.emit({
      type: "active_sessions_update",
      active: {
        updatedAt: new Date().toISOString(),
        sessions: [activeSession("thread-other", "wrong prompt")],
      },
    });
    await flushAsync();

    expect(typing).toBe(0);
  });

  it("keeps typing active for remote peer sessions until the session finishes", async () => {
    const preferences = new BotPreferencesStore(workspace);
    preferences.update("123:456", { targetPeerId: "peer-1", mirrorMode: "final" });
    const client = new FakeRemoteClient();
    const typingContexts: ChannelContext[] = [];
    const runtime = fakeRuntime({
      sendTyping: async (target) => {
        typingContexts.push({ ...target });
      },
    });
    const topicContext = context({ topicId: "456" });
    const controller = createChannelPeerMirrorController({
      label: "Telegram",
      runtime,
      preferencesStore: preferences,
      remoteClient: client,
      contextForKey: () => topicContext,
      defaultMirrorMode: () => "final",
      mirrorMinUpdateMs: 0,
      typingIntervalMs: 20,
    });

    controller.sync("123:456", topicContext);
    client.emit(snapshot("thread-a"));
    client.emit({
      type: "active_sessions_update",
      active: {
        updatedAt: new Date().toISOString(),
        sessions: [activeSession("thread-a", "target prompt")],
      },
    });
    await sleep(75);

    expect(typingContexts.length).toBeGreaterThanOrEqual(3);
    expect(typingContexts.every((target) => target.topicId === "456")).toBe(true);

    client.emit({ type: "active_sessions_update", active: { updatedAt: new Date().toISOString(), sessions: [] } });
    await flushAsync();
    const stoppedAt = typingContexts.length;
    await sleep(60);

    expect(typingContexts).toHaveLength(stoppedAt);
    controller.close("123:456");
  });

  it("sends a working notice for already-running remote CLI sessions in final mode", async () => {
    const preferences = new BotPreferencesStore(workspace);
    preferences.update("123", { targetPeerId: "peer-1", mirrorMode: "final" });
    const client = new FakeRemoteClient();
    const sent: string[] = [];
    const runtime = fakeRuntime({
      sendMessage: async (_context, message) => {
        sent.push(message.text);
        return { messageId: `message-${sent.length}` };
      },
    });
    const controller = createChannelPeerMirrorController({
      label: "Telegram",
      runtime,
      preferencesStore: preferences,
      remoteClient: client,
      contextForKey: () => context(),
      defaultMirrorMode: () => "final",
      mirrorMinUpdateMs: 0,
      typingIntervalMs: 1000,
    });

    controller.sync("123", context());
    client.emit(snapshot("thread-a"));
    client.emit({
      type: "active_sessions_update",
      active: {
        updatedAt: new Date().toISOString(),
        sessions: [activeSession("thread-a", "target prompt")],
      },
    });
    await flushAsync();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("<b>Working on</b>");
    expect(sent[0]).toContain("target prompt");

    client.emit({
      type: "active_sessions_update",
      active: {
        updatedAt: new Date().toISOString(),
        sessions: [activeSession("thread-a", "target prompt")],
      },
    });
    await flushAsync();

    expect(sent).toHaveLength(1);
    controller.close("123");
  });

  it("mirrors web-origin remote final answers but suppresses same-channel echoes", async () => {
    const preferences = new BotPreferencesStore(workspace);
    preferences.update("123", { targetPeerId: "peer-1", mirrorMode: "final" });
    const client = new FakeRemoteClient();
    const sent: string[] = [];
    const runtime = fakeRuntime({
      sendMessage: async (_context, message) => {
        sent.push(message.text);
        return { messageId: `message-${sent.length}` };
      },
    });
    const controller = createChannelPeerMirrorController({
      label: "Telegram",
      runtime,
      preferencesStore: preferences,
      remoteClient: client,
      contextForKey: () => context(),
      defaultMirrorMode: () => "final",
      mirrorMinUpdateMs: 0,
      typingIntervalMs: 1000,
    });

    controller.sync("123", context());
    client.emit(snapshot("thread-a"));
    client.emit({ type: "chat_history", messages: [] });
    client.emit({
      type: "chat_history",
      messages: [
        webMessage("thread-a", "agent", "web", "web final"),
        webMessage("thread-a", "agent", "telegram", "telegram echo"),
      ],
    });
    await flushAsync();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("web final");
    expect(sent[0]).not.toContain("telegram echo");
  });

  it("mirrors remote turn starts from other channels only", async () => {
    const preferences = new BotPreferencesStore(workspace);
    preferences.update("123", { targetPeerId: "peer-1", mirrorMode: "final" });
    const client = new FakeRemoteClient();
    const sent: string[] = [];
    const runtime = fakeRuntime({
      sendMessage: async (_context, message) => {
        sent.push(message.text);
        return { messageId: `message-${sent.length}` };
      },
    });
    const controller = createChannelPeerMirrorController({
      label: "Telegram",
      runtime,
      preferencesStore: preferences,
      remoteClient: client,
      contextForKey: () => context(),
      defaultMirrorMode: () => "final",
      mirrorMinUpdateMs: 0,
      typingIntervalMs: 1000,
    });

    controller.sync("123", context());
    client.emit(snapshot("thread-a"));
    client.emit({
      type: "turn_start",
      id: "turn-web",
      prompt: "from web",
      text: "from web",
      at: new Date().toISOString(),
      source: "web",
    });
    client.emit({
      type: "turn_start",
      id: "turn-telegram",
      prompt: "from telegram",
      text: "from telegram",
      at: new Date().toISOString(),
      source: "telegram",
    });
    await flushAsync();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("from web");
    expect(sent[0]).not.toContain("from telegram");
    client.emit({ type: "turn_complete", id: "turn-web", at: new Date().toISOString(), threadId: "thread-a" });
    await flushAsync();
    controller.close("123");
  });

  it("keeps typing active for selected remote peer turns without active session updates", async () => {
    const preferences = new BotPreferencesStore(workspace);
    preferences.update("123:456", {
      targetPeerId: "peer-1",
      targetThreadId: "thread-purestats",
      targetAgentId: "codex",
      mirrorMode: "final",
    });
    const client = new FakeRemoteClient();
    const typingContexts: ChannelContext[] = [];
    const runtime = fakeRuntime({
      sendTyping: async (target) => {
        typingContexts.push({ ...target });
      },
    });
    const topicContext = context({ topicId: "456" });
    const controller = createChannelPeerMirrorController({
      label: "Telegram",
      runtime,
      preferencesStore: preferences,
      remoteClient: client,
      contextForKey: () => topicContext,
      defaultMirrorMode: () => "final",
      mirrorMinUpdateMs: 0,
      typingIntervalMs: 20,
    });

    controller.sync("123:456", topicContext);
    client.emit(snapshot("thread-other"));
    client.emit({
      type: "turn_start",
      id: "turn-unrelated",
      prompt: "wrong",
      text: "wrong",
      at: new Date().toISOString(),
      source: "web",
      agentId: "codex",
      threadId: "thread-other",
    });
    await sleep(40);

    expect(typingContexts).toHaveLength(0);

    client.emit({
      type: "turn_start",
      id: "turn-purestats",
      prompt: "target",
      text: "target",
      at: new Date().toISOString(),
      source: "web",
      agentId: "codex",
      threadId: "thread-purestats",
    });
    await sleep(75);

    expect(typingContexts.length).toBeGreaterThanOrEqual(3);
    expect(typingContexts.every((target) => target.topicId === "456")).toBe(true);

    client.emit({
      type: "turn_complete",
      id: "turn-purestats",
      at: new Date().toISOString(),
      agentId: "codex",
      threadId: "thread-purestats",
    });
    await flushAsync();
    const stoppedAt = typingContexts.length;
    await sleep(60);

    expect(typingContexts).toHaveLength(stoppedAt);
    controller.close("123:456");
  });

  it("keeps startup alive when a stored remote mirror target cannot be subscribed", async () => {
    const preferences = new BotPreferencesStore(workspace);
    preferences.update("123", { targetPeerId: "disabled-peer", mirrorMode: "status" });
    const sent: string[] = [];
    const runtime = fakeRuntime({
      sendMessage: async (_context, message) => {
        sent.push(message.text);
        return { messageId: `message-${sent.length}` };
      },
    });
    const remoteClient: ChannelPeerMirrorRemoteClient = {
      subscribe: () => {
        throw new Error("Peer is disabled.");
      },
    };
    const controller = createChannelPeerMirrorController({
      label: "Telegram",
      runtime,
      preferencesStore: preferences,
      remoteClient,
      contextForKey: () => context(),
      defaultMirrorMode: () => "status",
      mirrorMinUpdateMs: 0,
      typingIntervalMs: 1000,
    });

    expect(() => controller.startStoredContexts()).not.toThrow();
    await flushAsync();

    expect(sent.at(-1)).toContain("Telegram remote mirror stream failed: Peer is disabled.");
  });
});

function context(overrides: Partial<ChannelContext> = {}): ChannelContext {
  return {
    channelId: "telegram",
    chatId: "123",
    ...overrides,
  };
}

function fakeRuntime(overrides: Partial<ChannelRuntime>): ChannelRuntime {
  return {
    id: "telegram",
    label: "Telegram",
    capabilities: new Set(),
    describe: () => ({ id: "telegram", label: "Telegram", capabilities: [], status: "available" }),
    sendMessage: async () => ({ messageId: "message" }),
    editMessage: async () => {},
    sendTyping: async () => {},
    ...overrides,
  };
}

function snapshot(threadId: string): PeerEventEnvelope {
  return {
    type: "snapshot",
    data: {
      session: {
        agentId: "codex",
        agentLabel: "Codex",
        threadId,
        workspace: "/repo",
      },
      sessionText: "",
      queue: [],
      queuePaused: false,
      processing: false,
      enabledAgents: ["codex"],
      workspaces: [],
    } as RelaySnapshot,
  };
}

function activeSession(threadId: string, prompt: string): ActiveSessionDto {
  return {
    id: `cli:codex:${threadId}`,
    contextKey: `cli:codex:${threadId}`,
    source: "cli",
    status: "external",
    agentId: "codex",
    agentLabel: "Codex",
    threadId,
    workspace: "/repo",
    prompt,
    currentTool: "exec_command",
    startedAt: new Date(Date.now() - 62_000).toISOString(),
    updatedAt: new Date().toISOString(),
    durationMs: 62_000,
    queueLength: 0,
    queuePaused: false,
  };
}

function webMessage(
  threadId: string,
  role: "agent" | "user" | "system" | "tool",
  source: "web" | "telegram" | "discord" | "slack" | "matrix" | "cli",
  text: string,
) {
  return {
    id: `${source}-${role}-${text}`,
    timestamp: new Date().toISOString(),
    threadId,
    role,
    source,
    text,
  };
}

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
