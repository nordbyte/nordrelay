import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Permission } from "../src/access/access-control.js";
import { PeerStore } from "../src/peers/peer-store.js";
import { BotPreferencesStore } from "../src/state/bot-preferences.js";
import {
  renderNodeTargetAction,
  renderNodeTargetPicker,
} from "../src/channels/shared/channel-node-targets.js";

const REQUIRED_SCOPES: Permission[] = ["sessions.read", "sessions.write", "prompt.send", "settings.write"];

describe("channel node target helpers", () => {
  let workspace: string;
  let peerStore: PeerStore;
  let preferencesStore: BotPreferencesStore;

  beforeEach(() => {
    workspace = mkdtempSync(path.join(tmpdir(), "nordrelay-node-targets-"));
    peerStore = new PeerStore(workspace);
    preferencesStore = new BotPreferencesStore(workspace);
    peerStore.upsertPeer({
      id: "peer-a",
      name: "Server A",
      url: "https://server-a.example",
      nodeId: "node-a",
      publicKey: "public-key-a",
      fingerprint: "fingerprint-a",
      secret: "secret-a",
      scopes: REQUIRED_SCOPES,
      enabled: true,
    });
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("renders local and peer nodes with selectable actions", () => {
    const response = renderNodeTargetPicker({
      contextKey: "telegram:1",
      preferencesStore,
      peerStore,
    });

    expect(response.plain).toContain("Selected node: Local node");
    expect(response.plain).toContain("Server A (peer-a)");
    expect(response.buttons?.flat().map((button) => button.action)).toContain("node_target:peer:peer-a");
  });

  it("updates the channel node target", () => {
    const selected = renderNodeTargetAction({
      contextKey: "telegram:1",
      preferencesStore,
      peerStore,
      action: "node_target:peer:peer-a",
    });
    expect(preferencesStore.get("telegram:1").targetPeerId).toBe("peer-a");
    expect(selected.plain).toContain("Selected node: Server A (peer-a)");

    renderNodeTargetAction({
      contextKey: "telegram:1",
      preferencesStore,
      peerStore,
      action: "node_target:local",
    });
    expect(preferencesStore.get("telegram:1").targetPeerId).toBeNull();
  });
});
