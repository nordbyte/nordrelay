import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildPeerAccessReport, buildPeerDebugReport, classifyPeerError, runPeerRepairAction } from "../src/peers/peer-diagnostics.js";
import { PeerStore } from "../src/peers/peer-store.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("peer diagnostics", () => {
  it("classifies common peer failures with remediation hints", () => {
    expect(classifyPeerError(new Error("Peer request timed out after 4000ms."))).toMatchObject({
      code: "peer.network.timeout",
    });
    expect(classifyPeerError(new Error("Peer TLS certificate fingerprint mismatch."))).toMatchObject({
      code: "peer.tls.fingerprint_mismatch",
    });
    expect(classifyPeerError(new Error("Peer permission denied: sessions.read"))).toMatchObject({
      code: "peer.scope.missing",
      remediation: expect.stringContaining("sessions.read"),
    });
  });

  it("explains effective user and peer access", () => {
    const peer = peerStore().upsertPeer({
      name: "Remote",
      url: "https://remote.example:31979",
      nodeId: "node-remote",
      publicKey: "public-key",
      fingerprint: "sha256:abc",
      secret: "shared-secret",
      scopes: ["inspect"],
      allowedAgents: ["codex"],
      allowedWorkspaceRoots: ["/srv/app"],
      workspaceAliases: { app: "/srv/app" },
    });
    const users = {
      canUsePeerStrict: () => true,
      hasPermission: (_user: unknown, permission: string) => permission === "inspect" || permission === "sessions.read",
    };
    const authUser = {
      user: { id: "user-1", email: "admin@example.test", displayName: "Admin", active: true },
      groups: [{ id: "admin" }],
      permissions: ["inspect", "sessions.read"],
    };

    const report = buildPeerAccessReport({ peer, users: users as never, authUser: authUser as never });

    expect(report.allowed).toBe(false);
    expect(report.checks.find((check) => check.id === "inspect")).toMatchObject({ allowed: true });
    expect(report.checks.find((check) => check.id === "sessions-read")).toMatchObject({
      allowed: false,
      reason: expect.stringContaining("peer is missing sessions.read"),
    });
    expect(report.checks.find((check) => check.id === "prompt-send")).toMatchObject({
      allowed: false,
      reason: expect.stringContaining("authenticated user is missing prompt.send"),
    });
    expect(report.checks.find((check) => check.id === "plugins-read")).toMatchObject({
      allowed: false,
      reason: expect.stringContaining("authenticated user is missing plugins.read"),
    });
  });

  it("builds a lightweight debug report and repair actions without running network probes", async () => {
    const store = peerStore();
    const peer = store.upsertPeer({
      name: "Remote",
      nodeId: "node-remote",
      publicKey: "public-key",
      fingerprint: "sha256:abc",
      secret: "shared-secret",
      enabled: false,
      scopes: ["inspect"],
    });
    store.markError(peer.id, "previous failure", { check: "test", code: "peer.network.unreachable" });

    const report = await buildPeerDebugReport({ peerId: peer.id, store, runProbes: false });

    expect(report.summary.status).toBe("error");
    expect(report.repairActions).toEqual(expect.arrayContaining(["enable", "clear-error", "rotate-pairing"]));

    const repaired = await runPeerRepairAction({ peerId: peer.id, store, action: "clear-error" });
    expect(repaired.peer?.lastError).toBeUndefined();
  });
});

function peerStore(): PeerStore {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nordrelay-peer-diagnostics-"));
  tmpDirs.push(dir);
  return new PeerStore(dir);
}
