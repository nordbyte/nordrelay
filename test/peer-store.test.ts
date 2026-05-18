import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PeerStore } from "../src/peers/peer-store.js";

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
      group: "LAN",
      scopes: ["inspect", "prompt.send"],
      allowedAgents: ["codex"],
      allowedWorkspaceRoots: ["/work/project"],
      workspaceAliases: { app: "/work/project" },
    });

    expect(created.invitation).toMatchObject({
      name: "Laptop",
      group: "LAN",
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

  it("deletes invitations by id", () => {
    const store = newStore();
    const created = store.createInvitation({ name: "Temporary laptop" });

    expect(store.snapshot(localIdentity(), { enabled: true, listenUrl: "https://local", requireTls: true }).invitations).toHaveLength(1);
    const removed = store.deleteInvitation(created.invitation.id);

    expect(removed).toMatchObject({ id: created.invitation.id, name: "Temporary laptop" });
    expect(store.deleteInvitation(created.invitation.id)).toBeNull();
    expect(store.snapshot(localIdentity(), { enabled: true, listenUrl: "https://local", requireTls: true }).invitations).toHaveLength(0);
  });

  it("returns public peer snapshots without shared secrets", () => {
    const store = newStore();
    const peer = store.upsertPeer({
      name: "Remote",
      group: "Servers",
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
      group: "Servers",
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
    expect(updated.healthHistory?.at(-1)).toMatchObject({ status: "online", latencyMs: 42 });
    expect(updated.effectiveAccess).toMatchObject({
      scopes: ["inspect"],
      allowedAgents: ["pi"],
      allowedWorkspaceRoots: [],
      workspaceAliases: { demo: "/srv/demo" },
    });
    expect(updated).not.toHaveProperty("secret");
  });

  it("reports peer trust and creates rotation invitations from existing access", () => {
    const store = newStore();
    const peer = store.upsertPeer({
      name: "Remote",
      group: "LAN",
      url: "https://remote.example:31979",
      nodeId: "node-remote",
      publicKey: "public-key",
      fingerprint: "sha256:abc",
      secret: "shared-secret",
      scopes: ["inspect", "sessions.read"],
      allowedAgents: ["codex"],
      allowedWorkspaceRoots: ["/srv/app"],
      workspaceAliases: { app: "/srv/app" },
    });

    expect(store.listPublic()[0]).toMatchObject({
      trustStatus: "tls-unpinned",
      trustWarnings: expect.arrayContaining([expect.stringContaining("TLS fingerprint")]),
    });

    const trusted = store.updatePeerTlsFingerprint(peer.id, "aa:bb");
    expect(trusted.tlsFingerprint).toBe("aa:bb");
    expect(store.listPublic()[0]).toMatchObject({ trustStatus: "trusted" });

    const rotation = store.createRotationInvitation(peer.id, { expiresInMs: 60_000 });
    expect(rotation.peer.id).toBe(peer.id);
    expect(rotation.invitation).toMatchObject({
      group: "LAN",
      scopes: ["inspect", "sessions.read"],
      allowedAgents: ["codex"],
      allowedWorkspaceRoots: ["/srv/app"],
      workspaceAliases: { app: "/srv/app" },
    });
    expect(rotation.code).toHaveLength(24);
  });

  it("tracks peer groups and bounded health history", () => {
    const store = newStore();
    const peer = store.upsertPeer({
      name: "Remote",
      group: "Servers",
      url: "https://remote.example:31979",
      nodeId: "node-remote",
      publicKey: "public-key",
      fingerprint: "sha256:abc",
      secret: "shared-secret",
    });

    for (let index = 0; index < 25; index += 1) {
      store.markError(peer.id, `offline ${index}`);
    }
    const snapshot = store.snapshot(localIdentity(), { enabled: true, listenUrl: "https://local", requireTls: true });

    expect(snapshot.groups).toEqual(["Servers"]);
    expect(snapshot.peers[0].healthHistory).toHaveLength(25);
    expect(snapshot.peers[0].healthHistory?.at(-1)).toMatchObject({ status: "offline", error: "offline 24" });
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

function localIdentity() {
  return { nodeId: "local", name: "Local", publicKey: "public", fingerprint: "fp", createdAt: new Date().toISOString() };
}
