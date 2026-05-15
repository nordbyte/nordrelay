import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
      workspaceAliases: { app: "/work/project" },
    });

    expect(created.invitation).toMatchObject({
      name: "Laptop",
      scopes: ["inspect", "prompt.send"],
      allowedAgents: ["codex"],
      allowedWorkspaceRoots: ["/work/project"],
      workspaceAliases: { app: "/work/project" },
    });
    expect(created.invitation).not.toHaveProperty("codeHash");
    expect(created.code).toHaveLength(24);

    const consumed = store.consumeInvitation(created.code, "node-2");
    expect(consumed.usedByNodeId).toBe("node-2");
    expect(() => store.consumeInvitation(created.code, "node-3")).toThrow(/Invalid or already used/);
  });

  it("rejects expired invitations", () => {
    const store = newStore();
    const created = store.createInvitation({ expiresInMs: 60_000 });
    const payload = JSON.parse(readFileSync(store.filePath, "utf8"));
    payload.invitations[0].expiresAt = new Date(Date.now() - 1_000).toISOString();
    writeFileSync(store.filePath, `${JSON.stringify(payload, null, 2)}\n`);

    expect(() => store.consumeInvitation(created.code, "node-2")).toThrow(/expired/);
  });

  it("returns public peer snapshots without shared secrets", () => {
    const store = newStore();
    const peer = store.upsertPeer({
      name: "Remote",
      url: "https://remote.example:31979",
      nodeId: "node-remote",
      publicKey: "public-key",
      fingerprint: "sha256:abc",
      tlsFingerprint: "aa:bb",
      secret: "shared-secret",
      scopes: ["inspect"],
      allowedAgents: ["pi"],
      workspaceAliases: { demo: "/srv/demo" },
    });

    store.markSeen(peer.id, { latencyMs: 42, remoteVersion: "0.6.0", remoteStatus: "online" });

    const [updated] = store.listPublic();
    expect(updated).toMatchObject({
      name: "Remote",
      nodeId: "node-remote",
      fingerprint: "sha256:abc",
      tlsFingerprint: "aa:bb",
      scopes: ["inspect"],
      allowedAgents: ["pi"],
      workspaceAliases: { demo: "/srv/demo" },
      lastLatencyMs: 42,
      remoteVersion: "0.6.0",
      remoteStatus: "online",
    });
    expect(updated).not.toHaveProperty("secret");
  });

  it("caps invitation lifetime at 24 hours", () => {
    const store = newStore();
    const before = Date.now();
    const created = store.createInvitation({ expiresInMs: 7 * 24 * 60 * 60 * 1000 });
    const ttl = Date.parse(created.invitation.expiresAt) - before;
    expect(ttl).toBeGreaterThan(23 * 60 * 60 * 1000);
    expect(ttl).toBeLessThanOrEqual(24 * 60 * 60 * 1000 + 1000);
  });
});

function newStore(): PeerStore {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nordrelay-peers-"));
  tmpDirs.push(dir);
  return new PeerStore(dir);
}
