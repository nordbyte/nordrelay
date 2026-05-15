import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadOrCreatePeerIdentity } from "../src/peer-identity.js";
import { pairPeer, RemoteRelayClient } from "../src/peer-client.js";
import { startPeerServer, type PeerServerHandle } from "../src/peer-server.js";
import { PeerStore } from "../src/peer-store.js";
import type { ConnectorConfig } from "../src/config.js";
import type { RelayRuntime } from "../src/relay-runtime.js";

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
