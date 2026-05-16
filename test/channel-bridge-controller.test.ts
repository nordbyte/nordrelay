import { describe, expect, it } from "vitest";

import {
  createChannelActivityRecorder,
  createChannelAuditRecorder,
  createChannelBusyStore,
  createChannelPermissionChecker,
  createChannelQueueStatusController,
} from "../src/channel-bridge-controller.js";

describe("channel bridge controller helpers", () => {
  it("creates and reuses busy state entries", () => {
    const store = createChannelBusyStore<string, { processing: boolean; switching: boolean; transcribing: boolean }>(() => ({
      processing: false,
      switching: false,
      transcribing: false,
    }));

    const state = store.get("discord:1");
    state.transcribing = true;

    expect(store.get("discord:1")).toBe(state);
    expect(store.peek("discord:1")?.transcribing).toBe(true);
    store.delete("discord:1");
    expect(store.peek("discord:1")).toBeUndefined();
  });

  it("sends a queue status once and edits subsequent changes", async () => {
    const sends: string[] = [];
    const edits: Array<{ id: string; text: string }> = [];
    const controller = createChannelQueueStatusController<string, string>({
      send: async (_contextKey, _context, text) => {
        sends.push(text);
        return "m1";
      },
      edit: async (_contextKey, _context, messageId, text) => {
        edits.push({ id: messageId, text });
      },
    });

    await controller.update("slack:1", { source: "slack", chatId: "C1" }, "Waiting...");
    await controller.update("slack:1", { source: "slack", chatId: "C1" }, "Waiting...");
    await controller.update("slack:1", { source: "slack", chatId: "C1" }, "Running...");

    expect(sends).toEqual(["Waiting..."]);
    expect(edits).toEqual([{ id: "m1", text: "Running..." }]);
  });

  it("records channel activity and audit events with authenticated user context", () => {
    const activityEvents: unknown[] = [];
    const auditEvents: unknown[] = [];
    const request = {
      contextKey: "discord:g:c",
      context: { source: "discord", chatId: "c" },
      authUser: {
        user: { id: "u1", email: "dev@example.test", displayName: "Dev" },
        groups: [{ id: "admin", name: "Admin", permissions: [] }],
      },
    };
    const actorFor = () => ({ channel: "discord" as const, id: "u1", label: "Dev" });

    const appendActivity = createChannelActivityRecorder({
      source: "discord",
      workspace: "/repo",
      activityStore: { append: (event: unknown) => activityEvents.push(event) } as any,
      actorFor,
    });
    const audit = createChannelAuditRecorder({
      channelId: "discord",
      auditLog: { append: (event: unknown) => auditEvents.push(event) } as any,
      actorFor,
      actorIdFor: () => "discord-user",
    });

    appendActivity(request, { status: "info", type: "command", threadId: null });
    audit(request, { action: "command", status: "ok" });

    expect(activityEvents[0]).toMatchObject({ source: "discord", contextKey: "discord:g:c", workspace: "/repo" });
    expect(auditEvents[0]).toMatchObject({ channelId: "discord", contextKey: "discord:g:c", actorId: "u1", actorRole: "Admin" });
  });

  it("delegates permission checks to the user store", () => {
    const checker = createChannelPermissionChecker({
      hasPermission: (authUser: unknown, permission: unknown) => Boolean(authUser) && permission === "sessions.read",
    } as any);

    expect(checker({ contextKey: "slack:t:c", context: { source: "slack", chatId: "c" }, authUser: {} } as any, "sessions.read" as any)).toBe(true);
    expect(checker({ contextKey: "slack:t:c", context: { source: "slack", chatId: "c" } } as any, "sessions.read" as any)).toBe(false);
  });
});
