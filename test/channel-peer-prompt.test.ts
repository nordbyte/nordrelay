import { describe, expect, it } from "vitest";

import { runChannelPeerPrompt, type RemotePromptClient } from "../src/channels/shared/channel-peer-prompt.js";
import type { PeerEventEnvelope } from "../src/peers/peer-types.js";

class FakeRemotePromptClient implements RemotePromptClient {
  closed = false;
  events: PeerEventEnvelope[] = [];
  result: unknown = {};

  subscribe(
    _peerId: string,
    onEvent: (event: PeerEventEnvelope) => void,
    _onError?: (error: Error) => void,
    _sourceContextKey?: string,
  ): { close: () => void } {
    void Promise.resolve().then(() => {
      for (const event of this.events) {
        onEvent(event);
      }
    });
    return {
      close: () => {
        this.closed = true;
      },
    };
  }

  async webProxy(): Promise<unknown> {
    await Promise.resolve();
    return this.result;
  }
}

describe("runChannelPeerPrompt", () => {
  it("streams remote peer events through a channel transport", async () => {
    const client = new FakeRemotePromptClient();
    client.events = [
      { type: "turn_start", prompt: "build it" },
      { type: "text_delta", delta: "hello" },
      { type: "tool_start", toolName: "exec_command" },
      { type: "text_delta", delta: " world" },
      { type: "turn_complete" },
    ];
    const statuses: string[] = [];
    const responses: string[] = [];

    const handled = await runChannelPeerPrompt<string>({
      targetPeerId: "peer-1",
      contextKey: "web:dashboard",
      prompt: { input: "build it", description: "build it" },
      remoteClient: client,
      mirrorMode: "full",
      editMinIntervalMs: 0,
      typingIntervalMs: 10_000,
      sendTyping: async () => {},
      sendResponse: async (text) => {
        responses.push(text);
        return "message-1";
      },
      editResponse: async (_messageId, text) => {
        responses.push(text);
      },
      sendTurnStart: async (prompt) => {
        statuses.push(`start:${prompt}`);
      },
      sendToolStart: async (toolName) => {
        statuses.push(`tool:${toolName}`);
      },
      sendQueued: async (queueId) => {
        statuses.push(`queued:${queueId}`);
      },
      sendCompleted: async () => {
        statuses.push("completed");
      },
      sendFailure: async (message) => {
        statuses.push(`failed:${message}`);
      },
    });

    expect(handled).toBe(true);
    expect(statuses).toContain("start:build it");
    expect(statuses).toContain("tool:exec_command");
    expect(statuses).not.toContain("completed");
    expect(responses.at(-1)).toBe("hello world");
    expect(client.closed).toBe(true);
  });

  it("suppresses remote peer tool messages unless mirror mode is full", async () => {
    const client = new FakeRemotePromptClient();
    client.events = [
      { type: "turn_start", prompt: "build it" },
      { type: "text_delta", delta: "hello" },
      { type: "tool_start", toolName: "exec_command" },
      { type: "text_delta", delta: " world" },
      { type: "turn_complete" },
    ];
    const statuses: string[] = [];
    const responses: string[] = [];

    const handled = await runChannelPeerPrompt<string>({
      targetPeerId: "peer-1",
      contextKey: "web:dashboard",
      prompt: { input: "build it", description: "build it" },
      remoteClient: client,
      mirrorMode: () => "status",
      editMinIntervalMs: 0,
      typingIntervalMs: 10_000,
      sendTyping: async () => {},
      sendResponse: async (text) => {
        responses.push(text);
        return "message-1";
      },
      editResponse: async (_messageId, text) => {
        responses.push(text);
      },
      sendTurnStart: async (prompt) => {
        statuses.push(`start:${prompt}`);
      },
      sendToolStart: async (toolName) => {
        statuses.push(`tool:${toolName}`);
      },
      sendQueued: async (queueId) => {
        statuses.push(`queued:${queueId}`);
      },
      sendCompleted: async () => {
        statuses.push("completed");
      },
      sendFailure: async (message) => {
        statuses.push(`failed:${message}`);
      },
    });

    expect(handled).toBe(true);
    expect(statuses).toContain("start:build it");
    expect(statuses).not.toContain("tool:exec_command");
    expect(statuses).not.toContain("completed");
    expect(responses.at(-1)).toBe("hello world");
    expect(client.closed).toBe(true);
  });

  it("closes the event subscription when the remote prompt is queued", async () => {
    const client = new FakeRemotePromptClient();
    client.result = { queued: true, queueId: "queue-1" };
    const statuses: string[] = [];

    const handled = await runChannelPeerPrompt<string>({
      targetPeerId: "peer-1",
      contextKey: "web:dashboard",
      prompt: { input: "wait", description: "wait" },
      remoteClient: client,
      editMinIntervalMs: 0,
      typingIntervalMs: 10_000,
      sendTyping: async () => {},
      sendResponse: async () => "message-1",
      editResponse: async () => {},
      sendTurnStart: async () => {},
      sendToolStart: async () => {},
      sendQueued: async (queueId) => {
        statuses.push(`queued:${queueId}`);
      },
      sendCompleted: async () => {},
      sendFailure: async (message) => {
        statuses.push(`failed:${message}`);
      },
    });

    expect(handled).toBe(true);
    expect(statuses).toEqual(["queued:queue-1"]);
    expect(client.closed).toBe(true);
  });
});
