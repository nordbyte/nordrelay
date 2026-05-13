import { describe, expect, it } from "vitest";

import { InMemoryChannelRuntime, ChannelCommandRouter, deliverChannelAction, parseChannelCommand } from "../src/channel-runtime.js";

describe("channel runtime abstraction", () => {
  it("parses channel commands independently from Telegram", () => {
    expect(parseChannelCommand("/logs update 20")).toEqual({ command: "logs", argument: "update 20" });
    expect(parseChannelCommand("/agent@NordRelayBot pi")).toEqual({ command: "agent", argument: "pi" });
    expect(parseChannelCommand("plain text")).toBeNull();
  });

  it("dispatches channel commands through a generic router", async () => {
    const router = new ChannelCommandRouter()
      .command("channels", () => ({
        plain: "Channels",
        html: "<b>Channels</b>",
      }));

    const result = await router.dispatch({
      id: "msg-1",
      context: { channelId: "discord", chatId: "room-1", userId: "user-1" },
      text: "/channels",
    });

    expect(result).toMatchObject({
      matched: true,
      command: "channels",
      response: { plain: "Channels" },
    });
  });

  it("delivers rendered actions through any channel runtime", async () => {
    const runtime = new InMemoryChannelRuntime({
      id: "slack",
      label: "Slack",
      capabilities: ["text", "inline-buttons"],
      status: "planned",
    });

    const result = await deliverChannelAction(runtime, { channelId: "slack", chatId: "C123" }, {
      plain: "Update Codex",
      html: "<b>Update Codex</b>",
      buttons: [[{ label: "Run", action: "agent-update:start:codex" }]],
    });

    expect(result.messageId).toBe("slack-message-1");
    expect(runtime.sentMessages[0]?.message).toMatchObject({
      text: "<b>Update Codex</b>",
      fallbackText: "Update Codex",
      parseMode: "html",
    });
    expect(runtime.sentMessages[0]?.message.buttons?.[0]?.[0]?.action).toBe("agent-update:start:codex");
  });
});
