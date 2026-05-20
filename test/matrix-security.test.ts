import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { canSendSystemMessagesToMatrixContext } from "../src/channels/matrix/matrix-bot.js";
import {
  isUnauthenticatedMatrixCommandAllowed,
  parseMatrixMessageCommand,
  permissionForMatrixAction,
  requiredPermissionForMatrixCommand,
} from "../src/channels/matrix/matrix-command-surface.js";
import { CHANNEL_COMMANDS } from "../src/channels/shared/channel-command-catalog.js";
import { matrixContextKey } from "../src/channels/shared/context-key.js";
import { UserStore } from "../src/access/user-management.js";

describe("Matrix security boundaries", () => {
  let home: string;
  let store: UserStore;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "nordrelay-matrix-security-"));
    store = new UserStore(home);
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("does not allow system mirror or typing messages before an admin exists", () => {
    const contextKey = matrixContextKey({ homeserver: "example.com", roomId: "!room:example.com" });

    expect(canSendSystemMessagesToMatrixContext(store, contextKey)).toBe(false);
  });

  it("allows Matrix system messages only for registered enabled rooms", () => {
    store.createAdmin({ email: "admin@example.com", displayName: "Admin", password: "password123" });
    const contextKey = matrixContextKey({ homeserver: "example.com", roomId: "!room:example.com" });

    expect(canSendSystemMessagesToMatrixContext(store, contextKey)).toBe(false);

    store.registerMatrixRoom({ homeserver: "example.com", roomId: "!room:example.com", enabled: true });

    expect(canSendSystemMessagesToMatrixContext(store, contextKey)).toBe(true);

    const registered = store.snapshot().matrixRooms[0];
    store.updateMatrixRoom(registered.id, { enabled: false });

    expect(canSendSystemMessagesToMatrixContext(store, contextKey)).toBe(false);
  });

  it("keeps /link as the only unauthenticated Matrix command", () => {
    expect(isUnauthenticatedMatrixCommandAllowed("link")).toBe(true);
    for (const command of ["start", "help", "prompt", "session", "queue", "register_channel"]) {
      expect(isUnauthenticatedMatrixCommandAllowed(command)).toBe(false);
    }
  });

  it("uses slash, configured prefix, and bang command parsing without accepting Telegram bot mentions", () => {
    expect(parseMatrixMessageCommand("/queue cancel abc")).toEqual({ command: "queue", argument: "cancel abc" });
    expect(parseMatrixMessageCommand("!nr queue cancel abc")).toEqual({ command: "queue", argument: "cancel abc" });
    expect(parseMatrixMessageCommand("!queue cancel abc")).toEqual({ command: "queue", argument: "cancel abc" });
    expect(parseMatrixMessageCommand("/queue@NordRelayBot cancel abc")).toBeNull();
  });

  it("maps Matrix commands and text actions to write permissions", () => {
    expect(requiredPermissionForMatrixCommand("prompt", "")).toBe("prompt.send");
    expect(requiredPermissionForMatrixCommand("queue", "")).toBe("queue.read");
    expect(requiredPermissionForMatrixCommand("queue", "cancel abc")).toBe("queue.write");
    expect(permissionForMatrixAction("matrix_queue_cancel:ctx:abc")).toBe("queue.write");
    expect(permissionForMatrixAction("matrix_peer_queue_cancel:peer:abc")).toBe("queue.write");
    expect(permissionForMatrixAction("matrix_abort:ctx")).toBe("prompt.abort");
    expect(permissionForMatrixAction("matrix_artifact_send:ctx:turn")).toBe("files.read");
    expect(permissionForMatrixAction("matrix_artifact_delete:ctx:turn")).toBe("files.write");
    expect(permissionForMatrixAction("agent-update:cancel:job")).toBe("updates.run");
    expect(permissionForMatrixAction("matrix_unknown:ctx")).toBeNull();
  });

  it("registers the shared Matrix command surface for Telegram-parity commands", () => {
    const names = new Set(CHANNEL_COMMANDS.filter((command) => command.matrix !== false).map((command) => command.name));

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
