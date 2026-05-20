import { describe, expect, it } from "vitest";

import { InMemoryChannelRuntime, ChannelCommandRouter, deliverChannelAction, parseChannelCommand } from "../src/channels/shared/channel-runtime.js";
import { actionFromDiscordCustomId, discordActionId, discordMessageText, splitDiscordMessage } from "../src/channels/discord/discord-channel-runtime.js";
import { actionFromSlackActionId, slackActionId, slackMessageText, splitSlackMessage } from "../src/channels/slack/slack-channel-runtime.js";

describe("channel runtime abstraction", () => {
  it("parses channel commands independently from Telegram", () => {
    expect(parseChannelCommand("/logs update 20")).toEqual({ command: "logs", argument: "update 20" });
    expect(parseChannelCommand("/agent@NordRelayBot pi")).toEqual({ command: "agent", argument: "pi" });
    expect(parseChannelCommand("/agent@NordRelayBot pi", { allowBotMention: false })).toBeNull();
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

  it("dispatches command aliases through one generic handler", async () => {
    const router = new ChannelCommandRouter()
      .commands(["abort", "stop"], (message) => ({
        plain: `Abort ${message.text}`,
        html: `<b>Abort ${message.text}</b>`,
      }));

    const result = await router.dispatch({
      id: "msg-2",
      context: { channelId: "telegram", chatId: "room-1", userId: "user-1" },
      text: "/stop now",
    });

    expect(result).toMatchObject({
      matched: true,
      command: "stop",
      response: { plain: "Abort now" },
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

  it("maps Discord message formatting and component actions safely", () => {
    expect(discordMessageText({
      text: "<b>Working</b> &amp; done",
      fallbackText: "Working & done",
      parseMode: "html",
    })).toBe("Working & done");

    const actionId = discordActionId("discord_queue_cancel:ctx:abc");
    expect(actionFromDiscordCustomId(actionId)).toBe("discord_queue_cancel:ctx:abc");
    expect(actionId.length).toBeLessThanOrEqual(100);
    expect(splitDiscordMessage("x".repeat(4000)).length).toBeGreaterThan(1);
  });

  it("maps Slack message formatting and component actions safely", () => {
    expect(slackMessageText({
      text: "<b>Working</b> &amp; done",
      fallbackText: "Working & done",
      parseMode: "html",
    })).toBe("Working & done");

    const actionId = slackActionId("slack_queue_cancel:ctx:abc");
    expect(actionFromSlackActionId(actionId)).toBe("slack_queue_cancel:ctx:abc");
    expect(actionId.length).toBeLessThanOrEqual(255);
    expect(splitSlackMessage("x".repeat(9000)).length).toBeGreaterThan(1);
  });
});
