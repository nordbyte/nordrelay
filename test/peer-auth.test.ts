import type { IncomingMessage } from "node:http";

import { describe, expect, it } from "vitest";

import { PeerNonceCache, signPeerRequest, verifyPeerRequest } from "../src/peer-auth.js";
import type { PeerRecord } from "../src/peer-types.js";

describe("peer request authentication", () => {
  it("accepts signed requests and rejects nonce replay", () => {
    const peer = testPeer();
    const body = JSON.stringify({ ok: true });
    const signed = signPeerRequest(peer, "POST", "/peer/rpc", body);
    const nonces = new PeerNonceCache();

    expect(() => verifyPeerRequest({
      req: reqWithHeaders(signed.headers),
      peer,
      method: "POST",
      pathname: "/peer/rpc",
      body,
      nonces,
    })).not.toThrow();

    expect(() => verifyPeerRequest({
      req: reqWithHeaders(signed.headers),
      peer,
      method: "POST",
      pathname: "/peer/rpc",
      body,
      nonces,
    })).toThrow(/Replay/);
  });

  it("rejects tampered request bodies and signatures", () => {
    const peer = testPeer();
    const signed = signPeerRequest(peer, "POST", "/peer/rpc", "{\"ok\":true}");

    expect(() => verifyPeerRequest({
      req: reqWithHeaders(signed.headers),
      peer,
      method: "POST",
      pathname: "/peer/rpc",
      body: "{\"ok\":false}",
      nonces: new PeerNonceCache(),
    })).toThrow(/body hash mismatch/);

    expect(() => verifyPeerRequest({
      req: reqWithHeaders({ ...signed.headers, "x-nordrelay-peer-signature": "invalid" }),
      peer,
      method: "POST",
      pathname: "/peer/rpc",
      body: "{\"ok\":true}",
      nonces: new PeerNonceCache(),
    })).toThrow(/Invalid peer request signature/);
  });
});

function testPeer(): PeerRecord {
  return {
    id: "peer-1",
    name: "Peer",
    url: "https://peer.example:31979",
    nodeId: "node-1",
    publicKey: "public-key",
    fingerprint: "fingerprint",
    secret: "shared-secret",
    enabled: true,
    direction: "outbound",
    scopes: ["inspect"],
    allowedAgents: [],
    allowedWorkspaceRoots: [],
    workspaceAliases: {},
    createdAt: "2026-05-15T10:00:00.000Z",
    updatedAt: "2026-05-15T10:00:00.000Z",
  };
}

function reqWithHeaders(headers: Record<string, string>): IncomingMessage {
  return { headers } as IncomingMessage;
}
