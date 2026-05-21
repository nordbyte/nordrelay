import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  canSendSystemMessagesToSlackContext,
} from "../src/channels/slack/slack-bot.js";
import {
  isUnauthenticatedSlackCommandAllowed,
  parseSlackMessageCommand,
  permissionForSlackAction,
  requiredPermissionForSlackCommand,
} from "../src/channels/slack/slack-command-surface.js";
import { CHANNEL_COMMANDS } from "../src/channels/shared/channel-command-catalog.js";
import { slackContextKey } from "../src/channels/shared/context-key.js";
import { UserStore } from "../src/access/user-management.js";

describe("Slack security boundaries", () => {
  let home: string;
  let store: UserStore;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "nordrelay-slack-security-"));
    store = new UserStore(home);
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("does not allow system mirror or typing messages before an admin exists", () => {
    const contextKey = slackContextKey({ teamId: "T123", channelId: "C123" });

    expect(canSendSystemMessagesToSlackContext(store, contextKey)).toBe(false);
  });

  it("allows Slack system messages only for registered enabled channels", () => {
    store.createAdmin({ email: "admin@example.com", displayName: "Admin", password: "password123" });
    const contextKey = slackContextKey({ teamId: "T123", channelId: "C123" });

    expect(canSendSystemMessagesToSlackContext(store, contextKey)).toBe(false);

    store.registerSlackChannel({ teamId: "T123", channelId: "C123", enabled: true });

    expect(canSendSystemMessagesToSlackContext(store, contextKey)).toBe(true);

    const registered = store.snapshot().slackChannels[0];
    store.updateSlackChannel(registered.id, { enabled: false });

    expect(canSendSystemMessagesToSlackContext(store, contextKey)).toBe(false);
  });

  it("keeps /link as the only unauthenticated Slack command", () => {
    expect(isUnauthenticatedSlackCommandAllowed("link")).toBe(true);
    for (const command of ["start", "help", "prompt", "session", "queue", "register_channel"]) {
      expect(isUnauthenticatedSlackCommandAllowed(command)).toBe(false);
    }
  });

  it("uses the shared channel parser without accepting Telegram bot mentions", () => {
    expect(parseSlackMessageCommand("/queue cancel abc")).toEqual({ command: "queue", argument: "cancel abc" });
    expect(parseSlackMessageCommand("/queue@NordRelayBot cancel abc")).toBeNull();
  });

  it("maps Slack commands and button actions to write permissions", () => {
    expect(requiredPermissionForSlackCommand("prompt", "")).toBe("prompt.send");
    expect(requiredPermissionForSlackCommand("queue", "")).toBe("queue.read");
    expect(requiredPermissionForSlackCommand("queue", "cancel abc")).toBe("queue.write");
    expect(permissionForSlackAction("slack_queue_cancel:ctx:abc")).toBe("queue.write");
    expect(permissionForSlackAction("slack_peer_queue_cancel:peer:abc")).toBe("queue.write");
    expect(permissionForSlackAction("slack_abort:ctx")).toBe("prompt.abort");
    expect(permissionForSlackAction("slack_external_approval:yes:abc123")).toBe("prompt.abort");
    expect(permissionForSlackAction("slack_artifact_send:ctx:turn")).toBe("files.read");
    expect(permissionForSlackAction("slack_artifact_delete:ctx:turn")).toBe("files.write");
    expect(permissionForSlackAction("agent-update:cancel:job")).toBe("updates.run");
    expect(permissionForSlackAction("slack_unknown:ctx")).toBeNull();
  });

  it("registers the shared Slack command surface for Telegram-parity commands", () => {
    const names = new Set(CHANNEL_COMMANDS.filter((command) => command.slack !== false).map((command) => command.name));

    for (const command of [
      "auth",
      "login",
      "logout",
      "restart",
      "audit",
      "workspaces",
      "pin",
      "unpin",
      "pinned",
      "handback",
      "progress",
      "launch_profiles",
    ]) {
      expect(names.has(command)).toBe(true);
    }
  });
});
