import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PeerStore } from "../src/peer-store.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("PeerStore", () => {
  it("creates one-time invitations without exposing the pairing secret hash", () => {
    const store = newStore();
    const created = store.createInvitation({
      name: "Laptop",
      scopes: ["inspect", "prompt.send"],
      allowedAgents: ["codex"],
      allowedWorkspaceRoots: ["/work/project"],
    });

    expect(created.invitation).toMatchObject({
      name: "Laptop",
      scopes: ["inspect", "prompt.send"],
      allowedAgents: ["codex"],
      allowedWorkspaceRoots: ["/work/project"],
    });
    expect(created.invitation).not.toHaveProperty("codeHash");
    expect(created.code).toHaveLength(24);

    const consumed = store.consumeInvitation(created.code, "node-2");
    expect(consumed.usedByNodeId).toBe("node-2");
    expect(() => store.consumeInvitation(created.code, "node-3")).toThrow(/Invalid or already used/);
  });

  it("rejects expired invitations", () => {
    const store = newStore();
    const created = store.createInvitation({ expiresInMs: -1 });

    expect(() => store.consumeInvitation(created.code, "node-2")).toThrow(/expired/);
  });

  it("returns public peer snapshots without shared secrets", () => {
    const store = newStore();
    store.upsertPeer({
      name: "Remote",
      url: "https://remote.example:31979",
      nodeId: "node-remote",
      publicKey: "public-key",
      fingerprint: "sha256:abc",
      tlsFingerprint: "aa:bb",
      secret: "shared-secret",
      scopes: ["inspect"],
      allowedAgents: ["pi"],
    });

    const [peer] = store.listPublic();
    expect(peer).toMatchObject({
      name: "Remote",
      nodeId: "node-remote",
      fingerprint: "sha256:abc",
      tlsFingerprint: "aa:bb",
      scopes: ["inspect"],
      allowedAgents: ["pi"],
    });
    expect(peer).not.toHaveProperty("secret");
  });
});

function newStore(): PeerStore {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nordrelay-peers-"));
  tmpDirs.push(dir);
  return new PeerStore(dir);
}
