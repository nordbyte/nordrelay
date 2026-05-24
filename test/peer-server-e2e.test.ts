import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadOrCreatePeerIdentity } from "../src/peers/peer-identity.js";
import { createPairingSignaturePayload, signPeerPayload } from "../src/peers/peer-identity.js";
import { signPeerRequest } from "../src/peers/peer-auth.js";
import { pairPeer, RemoteRelayClient } from "../src/peers/peer-client.js";
import { startPeerServer, type PeerServerHandle } from "../src/peers/peer-server.js";
import { PeerStore } from "../src/peers/peer-store.js";
import type { ConnectorConfig } from "../src/core/config.js";
import type { RelayRuntime } from "../src/runtime/relay-runtime.js";

const tmpDirs: string[] = [];
const handles: PeerServerHandle[] = [];

afterEach(async () => {
  for (const handle of handles.splice(0)) {
    await handle.close().catch(() => {});
  }
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("peer server pairing", () => {
  it("pairs two local NordRelay nodes and records ping health", async () => {
    const serverHome = tmpHome();
    const clientHome = tmpHome();
    const serverStore = new PeerStore(serverHome);
    const invite = serverStore.createInvitation({ scopes: ["inspect"], workspaceAliases: { app: "/srv/app" } });
    const handle = await startPeerServer({
      config: peerConfig(serverHome),
      runtime: fakeRuntime(),
      home: serverHome,
    });
    expect(handle).not.toBeNull();
    handles.push(handle!);
    expect(handle!.url).not.toContain(":0");

    const clientIdentity = loadOrCreatePeerIdentity(clientHome, "client");
    const clientStore = new PeerStore(clientHome);
    const paired = await pairPeer({ url: handle!.url, code: invite.code }, clientIdentity, clientStore);
    expect(paired.peer.workspaceAliases).toEqual({ app: "/srv/app" });

    const ping = await new RemoteRelayClient(clientStore).rpc(paired.peer.id, "peer.ping");
    expect(ping).toMatchObject({ ok: true, status: "online" });
    const stored = clientStore.get(paired.peer.id);
    expect(stored?.remoteStatus).toBe("online");
    expect(stored?.lastLatencyMs).toEqual(expect.any(Number));
  });

  it("rejects self-pairing", async () => {
    const home = tmpHome();
    const store = new PeerStore(home);
    const invite = store.createInvitation({ scopes: ["inspect"] });
    const handle = await startPeerServer({
      config: peerConfig(home),
      runtime: fakeRuntime(),
      home,
    });
    expect(handle).not.toBeNull();
    handles.push(handle!);

    const identity = loadOrCreatePeerIdentity(home, "same-node");
    await expect(pairPeer({ url: handle!.url, code: invite.code }, identity, store)).rejects.toThrow(/itself/);
  });

  it("stores the current public URL TLS fingerprint for bidirectional pairing", async () => {
    const serverHome = tmpHome();
    const clientHome = tmpHome();
    const serverStore = new PeerStore(serverHome);
    const invite = serverStore.createInvitation({ scopes: ["inspect"] });
    const serverHandle = await startPeerServer({
      config: peerConfig(serverHome, { tls: true, name: "server" }),
      runtime: fakeRuntime(),
      home: serverHome,
    });
    const clientHandle = await startPeerServer({
      config: peerConfig(clientHome, { tls: true, name: "client" }),
      runtime: fakeRuntime(),
      home: clientHome,
    });
    handles.push(serverHandle!, clientHandle!);

    const clientIdentity = loadOrCreatePeerIdentity(clientHome, "client");
    serverStore.upsertPeer({
      name: "client",
      url: clientHandle!.url,
      nodeId: clientIdentity.public.nodeId,
      publicKey: clientIdentity.public.publicKey,
      fingerprint: clientIdentity.public.fingerprint,
      tlsFingerprint: "00:00:00",
      secret: "old-secret",
      direction: "inbound",
      scopes: ["inspect"],
    });

    const clientStore = new PeerStore(clientHome);
    const paired = await pairPeer({
      url: serverHandle!.url,
      code: invite.code,
      publicUrl: clientHandle!.url,
    }, clientIdentity, clientStore);

    const storedOnServer = serverStore.get(clientIdentity.public.nodeId);
    expect(storedOnServer?.tlsFingerprint).toBe(clientHandle!.tlsFingerprint);
    expect(storedOnServer?.direction).toBe("bidirectional");

    const reverseProbe = await new RemoteRelayClient(clientStore).rpc(paired.peer.id, "peer.probe");
    expect(reverseProbe).toMatchObject({ ok: true, status: "reachable" });
  });

  it("rejects replayed signed peer RPC requests", async () => {
    const serverHome = tmpHome();
    const clientHome = tmpHome();
    const serverStore = new PeerStore(serverHome);
    const invite = serverStore.createInvitation({ scopes: ["inspect"] });
    const handle = await startPeerServer({
      config: peerConfig(serverHome),
      runtime: fakeRuntime(),
      home: serverHome,
    });
    handles.push(handle!);

    const clientIdentity = loadOrCreatePeerIdentity(clientHome, "client");
    const clientStore = new PeerStore(clientHome);
    const paired = await pairPeer({ url: handle!.url, code: invite.code }, clientIdentity, clientStore);
    const peer = clientStore.get(paired.peer.id);
    expect(peer).not.toBeNull();

    const bodyText = JSON.stringify({ protocolVersion: 1, type: "peer.ping" });
    const signed = signPeerRequest(peer!, "POST", "/peer/rpc", bodyText);
    const first = await fetch(`${handle!.url}/peer/rpc`, { method: "POST", headers: signed.headers, body: bodyText });
    const second = await fetch(`${handle!.url}/peer/rpc`, { method: "POST", headers: signed.headers, body: bodyText });

    expect(first.status).toBe(200);
    expect(second.status).toBe(403);
    await expect(second.json()).resolves.toMatchObject({ error: expect.stringMatching(/Replay/i) });
  });

  it("rejects RPC from disabled peers", async () => {
    const serverHome = tmpHome();
    const clientHome = tmpHome();
    const serverStore = new PeerStore(serverHome);
    const invite = serverStore.createInvitation({ scopes: ["inspect"] });
    const handle = await startPeerServer({
      config: peerConfig(serverHome),
      runtime: fakeRuntime(),
      home: serverHome,
    });
    handles.push(handle!);

    const clientIdentity = loadOrCreatePeerIdentity(clientHome, "client");
    const clientStore = new PeerStore(clientHome);
    const paired = await pairPeer({ url: handle!.url, code: invite.code }, clientIdentity, clientStore);
    serverStore.updatePeer(clientIdentity.public.nodeId, { enabled: false });

    await expect(new RemoteRelayClient(clientStore).rpc(paired.peer.id, "peer.ping")).rejects.toThrow(/disabled/i);
  });

  it("rejects stale pairing requests before consuming the invite", async () => {
    const serverHome = tmpHome();
    const clientHome = tmpHome();
    const serverStore = new PeerStore(serverHome);
    const invite = serverStore.createInvitation({ scopes: ["inspect"] });
    const handle = await startPeerServer({
      config: peerConfig(serverHome),
      runtime: fakeRuntime(),
      home: serverHome,
    });
    handles.push(handle!);

    const clientIdentity = loadOrCreatePeerIdentity(clientHome, "client");
    const timestamp = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const signaturePayload = createPairingSignaturePayload(clientIdentity.public.nodeId, timestamp, invite.code);
    const response = await fetch(`${handle!.url}/peer/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: invite.code,
        identity: clientIdentity.public,
        timestamp,
        signature: signPeerPayload(clientIdentity.privateKey, signaturePayload),
      }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringMatching(/clock skew/i) });
    expect(serverStore.listPublic().length).toBe(0);
  });

  it("denies web proxy calls outside the peer scopes", async () => {
    const serverHome = tmpHome();
    const clientHome = tmpHome();
    const serverStore = new PeerStore(serverHome);
    const invite = serverStore.createInvitation({ scopes: ["inspect"] });
    const handle = await startPeerServer({
      config: peerConfig(serverHome),
      runtime: fakeRuntime(),
      home: serverHome,
    });
    handles.push(handle!);

    const clientIdentity = loadOrCreatePeerIdentity(clientHome, "client");
    const clientStore = new PeerStore(clientHome);
    const paired = await pairPeer({ url: handle!.url, code: invite.code }, clientIdentity, clientStore);

    await expect(new RemoteRelayClient(clientStore).webProxy(paired.peer.id, {
      method: "POST",
      path: "/api/prompt",
      body: { text: "should be denied" },
    })).rejects.toThrow(/access denied|permission denied/i);
  });

  it("creates a transitive sync invite without copying peer secrets", async () => {
    const sourceHome = tmpHome();
    const targetHome = tmpHome();
    const localHome = tmpHome();
    const sourceHandle = await startPeerServer({
      config: peerConfig(sourceHome, { name: "source" }),
      runtime: fakeRuntime(),
      home: sourceHome,
    });
    const targetHandle = await startPeerServer({
      config: peerConfig(targetHome, { name: "target" }),
      runtime: fakeRuntime(),
      home: targetHome,
    });
    handles.push(sourceHandle!, targetHandle!);

    const sourceIdentity = loadOrCreatePeerIdentity(sourceHome, "source");
    const sourceStore = new PeerStore(sourceHome);
    const targetStore = new PeerStore(targetHome);
    const sourceToTargetInvite = targetStore.createInvitation({ scopes: ["inspect", "peers.read", "peers.write", "peers.connect"] });
    const sourceToTarget = await pairPeer({ url: targetHandle!.url, code: sourceToTargetInvite.code }, sourceIdentity, sourceStore);

    const localIdentity = loadOrCreatePeerIdentity(localHome, "local");
    const localStore = new PeerStore(localHome);
    const localToSourceInvite = sourceStore.createInvitation({ scopes: ["inspect", "peers.read", "peers.write", "peers.connect"] });
    const localToSource = await pairPeer({ url: sourceHandle!.url, code: localToSourceInvite.code }, localIdentity, localStore);

    const sourcePeers = await new RemoteRelayClient(localStore).webProxy(localToSource.peer.id, {
      method: "GET",
      path: "/api/peers",
      body: {},
    });
    expect(sourcePeers).toMatchObject({ peers: expect.arrayContaining([expect.objectContaining({ nodeId: sourceToTarget.peer.nodeId })]) });

    const syncInvite = await new RemoteRelayClient(localStore).webProxy(localToSource.peer.id, {
      method: "POST",
      path: `/api/peers/${encodeURIComponent(sourceToTarget.peer.id)}/sync-invite`,
      body: { expiresMinutes: 5 },
    });
    expect(syncInvite).toMatchObject({ code: expect.any(String), peer: expect.objectContaining({ nodeId: sourceToTarget.peer.nodeId }) });

    const localToTarget = await pairPeer({ url: targetHandle!.url, code: (syncInvite as { code: string }).code }, localIdentity, localStore);
    expect(localToTarget.peer.nodeId).toBe(sourceToTarget.peer.nodeId);
    expect(localToTarget.peer.secret).not.toBe(sourceToTarget.peer.secret);
    expect(localStore.get(localToTarget.peer.id)?.scopes).toEqual(expect.arrayContaining(["peers.read", "peers.write"]));
  });
});

function tmpHome(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nordrelay-peer-e2e-"));
  tmpDirs.push(dir);
  return dir;
}

function peerConfig(workspace: string, options: { tls?: boolean; name?: string } = {}): ConnectorConfig {
  return {
    peerEnabled: true,
    peerName: options.name ?? "server",
    peerHost: "127.0.0.1",
    peerPort: 0,
    peerTlsEnabled: options.tls ?? false,
    peerRequireTls: options.tls ?? false,
    workspace,
    stateBackend: "json",
    codexEnabled: true,
    piEnabled: false,
    hermesEnabled: false,
    openClawEnabled: false,
    claudeCodeEnabled: false,
    dashboardCacheTtlMs: 0,
    auditMaxEvents: 50,
    unifiedJobMaxItems: 20,
  } as ConnectorConfig;
}

function fakeRuntime(): RelayRuntime {
  return {
    subscribe: () => () => {},
  } as unknown as RelayRuntime;
}
