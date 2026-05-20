import { describe, expect, it } from "vitest";

import { createChannelPromptEngine } from "../src/channels/shared/channel-prompt-engine.js";
import { InMemoryChannelRuntime } from "../src/channels/shared/channel-runtime.js";

describe("channel prompt engine", () => {
  const context = { channelId: "discord" as const, chatId: "room-1", userId: "user-1" };

  it("streams text, tracks progress, and finalizes through a channel runtime", async () => {
    const runtime = new InMemoryChannelRuntime({
      id: "discord",
      label: "Discord",
      capabilities: ["text", "streaming-edits", "typing", "inline-buttons"],
      status: "available",
    });
    const responseOwners = new Map<string, string>();
    const engine = createChannelPromptEngine({
      runtime,
      context,
      contextKey: "discord:room-1",
      promptDescription: "hello",
      abortAction: "discord_abort:discord:room-1",
      trimMessage: (text) => text,
      splitMessage: (text) => [text],
      editDebounceMs: 0,
      typingIntervalMs: 10_000,
      toolVerbosity: "summary",
      logPrefix: "Discord",
      onResponseMessage: (messageId) => responseOwners.set(messageId, "discord:room-1"),
    });

    engine.start();
    await Promise.resolve();
    engine.callbacks.onTextDelta("hello");
    await Promise.resolve();
    await Promise.resolve();
    await engine.finalize();

    expect(runtime.typingContexts).toHaveLength(1);
    expect(runtime.sentMessages[0]?.message).toMatchObject({
      text: "hello",
      buttons: [[{ label: "Abort", action: "discord_abort:discord:room-1" }]],
    });
    expect(runtime.editedMessages.at(-1)?.message).toMatchObject({ text: "hello" });
    expect(responseOwners.get("discord-message-1")).toBe("discord:room-1");
    expect(engine.progress.status).toBe("completed");
    expect(engine.progress.textCharacters).toBe(5);
  });

  it("records tool progress, sends verbose tool messages, and renders plans", async () => {
    const runtime = new InMemoryChannelRuntime({
      id: "slack",
      label: "Slack",
      capabilities: ["text", "streaming-edits", "typing", "inline-buttons"],
      status: "available",
    });
    const toolEvents: string[] = [];
    const engine = createChannelPromptEngine({
      runtime,
      context: { ...context, channelId: "slack" },
      contextKey: "slack:room-1",
      promptDescription: "tools",
      trimMessage: (text) => text,
      splitMessage: (text) => [text],
      editDebounceMs: 0,
      typingIntervalMs: 10_000,
      toolVerbosity: "all",
      logPrefix: "Slack",
      onToolStart: (tool) => toolEvents.push(`start:${tool}`),
      onToolEnd: (failed) => toolEvents.push(failed ? "failed" : "completed"),
    });

    engine.start();
    engine.callbacks.onToolStart("exec_command", "tool-1");
    engine.callbacks.onTodoUpdate?.([{ text: "inspect", completed: false }]);
    engine.callbacks.onToolEnd("tool-1", false);
    await Promise.resolve();
    await Promise.resolve();
    engine.stop();

    expect(engine.progress.toolCounts.get("exec_command")).toBe(1);
    expect(toolEvents).toEqual(["start:exec_command", "completed"]);
    expect(runtime.sentMessages.map((item) => item.message.text)).toContain("Tool started: exec_command");
    expect(runtime.sentMessages.map((item) => item.message.text)).toContain("Plan:\n[ ] inspect");
  });

  it("edits the response with a failure when a response already exists", async () => {
    const runtime = new InMemoryChannelRuntime({
      id: "discord",
      label: "Discord",
      capabilities: ["text", "streaming-edits"],
      status: "available",
    });
    const engine = createChannelPromptEngine({
      runtime,
      context,
      contextKey: "discord:room-1",
      promptDescription: "fail",
      trimMessage: (text) => text,
      splitMessage: (text) => [text],
      editDebounceMs: 0,
      typingIntervalMs: 10_000,
      toolVerbosity: "summary",
      logPrefix: "Discord",
    });

    engine.start();
    engine.callbacks.onTextDelta("partial");
    await Promise.resolve();
    await Promise.resolve();
    await engine.fail("failed");

    expect(runtime.sentMessages[0]?.message.text).toBe("partial");
    expect(runtime.editedMessages.at(-1)?.message.text).toBe("failed");
  });
});
