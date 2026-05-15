import { describe, expect, it } from "vitest";

import type { ConnectorConfig } from "../src/config.js";
import { PeerRuntimeService } from "../src/peer-runtime-service.js";
import type { PeerRecord } from "../src/peer-types.js";
import type { RelayRuntime } from "../src/relay-runtime.js";

describe("PeerRuntimeService", () => {
  it("denies proxied WebUI routes when the peer lacks the required scope", async () => {
    const service = new PeerRuntimeService(config(), runtime());

    await expect(service.handle(peer({ scopes: ["inspect"] }), {
      protocolVersion: 1,
      type: "web.proxy",
      payload: { method: "POST", path: "/api/prompt", body: { text: "hello" } },
    })).rejects.toThrow(/prompt.send/);
  });

  it("enforces peer agent and workspace scopes before starting remote sessions", async () => {
    const service = new PeerRuntimeService(config(), runtime());

    await expect(service.handle(peer({
      scopes: ["sessions.write"],
      allowedAgents: ["codex"],
      allowedWorkspaceRoots: ["/allowed"],
    }), {
      protocolVersion: 1,
      type: "web.proxy",
      payload: { method: "POST", path: "/api/sessions/new", body: { agentId: "pi", workspace: "/allowed/app" } },
    })).rejects.toThrow(/not allowed to use agent/);

    await expect(service.handle(peer({
      scopes: ["sessions.write"],
      allowedAgents: ["codex"],
      allowedWorkspaceRoots: ["/allowed"],
    }), {
      protocolVersion: 1,
      type: "web.proxy",
      payload: { method: "POST", path: "/api/sessions/new", body: { agentId: "codex", workspace: "/other/app" } },
    })).rejects.toThrow(/not allowed to use workspace/);
  });

  it("proxies allowed prompt requests with a peer actor", async () => {
    const calls: Array<{ text: string; actorLabel?: string }> = [];
    const service = new PeerRuntimeService(config(), runtime({
      sendPrompt: async (text: string, actor: { label?: string }) => {
        calls.push({ text, actorLabel: actor.label });
        return { ok: true };
      },
    }));

    await expect(service.handle(peer({ scopes: ["prompt.send"] }), {
      protocolVersion: 1,
      type: "web.proxy",
      payload: { method: "POST", path: "/api/prompt", body: { text: "hello" } },
      actor: { channel: "web", id: "user-1", label: "Ricardo" },
    })).resolves.toEqual({ ok: true });

    expect(calls).toEqual([{ text: "hello", actorLabel: "Ricardo via Peer" }]);
  });
});

function peer(patch: Partial<PeerRecord> = {}): PeerRecord {
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
    createdAt: "2026-05-15T10:00:00.000Z",
    updatedAt: "2026-05-15T10:00:00.000Z",
    ...patch,
  };
}

function config(): ConnectorConfig {
  return {
    codexEnabled: true,
    piEnabled: true,
    hermesEnabled: false,
    openClawEnabled: false,
    claudeCodeEnabled: false,
  } as ConnectorConfig;
}

function runtime(patch: Partial<RelayRuntime> = {}): RelayRuntime {
  return {
    snapshot: async () => ({
      session: { agentId: "codex", workspace: "/allowed/app" },
      enabledAgents: ["codex"],
      workspaces: ["/allowed/app"],
    }),
    sendPrompt: async () => ({ ok: true }),
    ...patch,
  } as unknown as RelayRuntime;
}
