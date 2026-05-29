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
});

function context(): ChannelContext {
  return {
    channelId: "telegram",
    chatId: "123",
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

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}
