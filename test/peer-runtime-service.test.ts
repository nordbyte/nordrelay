import { describe, expect, it } from "vitest";

import type { ConnectorConfig } from "../src/core/config.js";
import { PeerRuntimeService } from "../src/peers/peer-runtime-service.js";
import type { PeerRecord } from "../src/peers/peer-types.js";
import type { RelayRuntime } from "../src/runtime/relay-runtime.js";

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
    const calls: Array<{ text: string; actorLabel?: string; correlationId?: string }> = [];
    const service = new PeerRuntimeService(config(), runtime({
      sendPrompt: async (text: string, actor: { label?: string }, correlationId?: string) => {
        calls.push({ text, actorLabel: actor.label, correlationId });
        return { ok: true };
      },
    }));

    await expect(service.handle(peer({ scopes: ["prompt.send"] }), {
      protocolVersion: 1,
      type: "web.proxy",
      payload: { method: "POST", path: "/api/prompt", body: { text: "hello", correlationId: "cid-peer-1" } },
      actor: { channel: "web", id: "user-1", label: "Ricardo" },
    })).resolves.toEqual({ ok: true });

    expect(calls).toEqual([{ text: "hello", actorLabel: "Ricardo via Peer", correlationId: "cid-peer-1" }]);
  });

  it("routes proxied requests through a source-context runtime", async () => {
    const contexts: Array<string | undefined> = [];
    const calls: string[] = [];
    const service = new PeerRuntimeService(config(), runtime(), {
      runtimeForContext: (_peer, contextKey) => {
        contexts.push(contextKey);
        return runtime({
          snapshot: async () => ({ session: { agentId: "codex", workspace: "/allowed/app" }, enabledAgents: ["codex"], workspaces: ["/allowed/app"] }),
          sendPrompt: async (text: string) => {
            calls.push(text);
            return { queued: false };
          },
        });
      },
    });

    await expect(service.handle(peer({ scopes: ["prompt.send"] }), {
      protocolVersion: 1,
      type: "web.proxy",
      payload: { method: "POST", path: "/api/prompt", contextKey: "telegram:123", body: { text: "remote hello" } },
    })).resolves.toEqual({ queued: false });

    expect(contexts).toEqual(["telegram:123"]);
    expect(calls).toEqual(["remote hello"]);
  });

  it("resolves peer workspace aliases before starting a session", async () => {
    const calls: string[] = [];
    const service = new PeerRuntimeService(config(), runtime({
      newSession: async (options: { workspace?: string }) => {
        calls.push(options.workspace ?? "");
        return { agentId: "codex", workspace: options.workspace, threadId: "thread" };
      },
    }));

    await expect(service.handle(peer({
      scopes: ["sessions.write"],
      allowedAgents: ["codex"],
      allowedWorkspaceRoots: ["/allowed"],
      workspaceAliases: { app: "/allowed/app" },
    }), {
      protocolVersion: 1,
      type: "web.proxy",
      payload: { method: "POST", path: "/api/sessions/new", body: { agentId: "codex", workspace: "app" } },
    })).resolves.toEqual({ session: { agentId: "codex", workspace: "/allowed/app", threadId: "thread" } });

    expect(calls).toEqual(["/allowed/app"]);
  });

  it("implements proxy routes for adapter conformance and session locks", async () => {
    const service = new PeerRuntimeService(config(), runtime({
      locks: () => [{ contextKey: "web:dashboard", owner: { userId: "web", label: "Web", channel: "web" }, expiresAt: "2026-05-16T10:00:00.000Z", createdAt: "2026-05-16T09:00:00.000Z" }],
      lockWebSession: (ownerName: string) => ({ contextKey: "web:dashboard", owner: { userId: "peer", label: ownerName, channel: "web" }, expiresAt: "2026-05-16T10:00:00.000Z", createdAt: "2026-05-16T09:00:00.000Z" }),
      unlockWebSession: () => ({ removed: true, locks: [] }),
    }));

    await expect(service.handle(peer({ scopes: ["inspect"] }), {
      protocolVersion: 1,
      type: "web.proxy",
      payload: { method: "GET", path: "/api/adapters/conformance" },
    })).resolves.toMatchObject({ agents: expect.any(Array), channels: expect.any(Array) });

    await expect(service.handle(peer({ scopes: ["sessions.read", "sessions.write"] }), {
      protocolVersion: 1,
      type: "web.proxy",
      payload: { method: "GET", path: "/api/locks" },
    })).resolves.toMatchObject({ locks: expect.any(Array) });

    await expect(service.handle(peer({ scopes: ["sessions.read", "sessions.write"] }), {
      protocolVersion: 1,
      type: "web.proxy",
      payload: { method: "POST", path: "/api/locks", body: { ownerName: "Remote Peer" } },
    })).resolves.toMatchObject({ lock: { owner: { label: "Remote Peer" } } });
  });

  it("scopes proxied workflow and template lists by peer agent/workspace limits", async () => {
    const service = new PeerRuntimeService(config(), runtime({
      workflowService: {
        list: () => ({
          templates: [
            { id: "allowed-template", name: "Allowed", prompt: "A", tags: [], variables: [], scope: "shared", defaultAgentId: "codex", defaultWorkspace: "/allowed/app", createdAt: "2026-05-16T10:00:00.000Z", updatedAt: "2026-05-16T10:00:00.000Z" },
            { id: "denied-template", name: "Denied", prompt: "B", tags: [], variables: [], scope: "shared", defaultAgentId: "pi", defaultWorkspace: "/other/app", createdAt: "2026-05-16T10:00:00.000Z", updatedAt: "2026-05-16T10:00:00.000Z" },
          ],
          workflows: [
            { id: "allowed-workflow", name: "Allowed flow", tags: [], scope: "shared", createdAt: "2026-05-16T10:00:00.000Z", updatedAt: "2026-05-16T10:00:00.000Z", steps: [{ id: "s1", name: "One", type: "prompt", prompt: "A", agentId: "codex", workspace: "/allowed/app", sessionMode: "current", target: "local", requiresApproval: false, continueOnError: false }] },
            { id: "denied-workflow", name: "Denied flow", tags: [], scope: "shared", createdAt: "2026-05-16T10:00:00.000Z", updatedAt: "2026-05-16T10:00:00.000Z", steps: [{ id: "s2", name: "Two", type: "prompt", prompt: "B", agentId: "pi", workspace: "/other/app", sessionMode: "current", target: "local", requiresApproval: false, continueOnError: false }] },
          ],
          runs: [],
        }),
      },
    }));
    const scopedPeer = peer({
      scopes: ["workflows.read"],
      allowedAgents: ["codex"],
      allowedWorkspaceRoots: ["/allowed"],
    });

    await expect(service.handle(scopedPeer, {
      protocolVersion: 1,
      type: "web.proxy",
      payload: { method: "GET", path: "/api/templates" },
    })).resolves.toMatchObject({ templates: [{ id: "allowed-template" }] });

    await expect(service.handle(scopedPeer, {
      protocolVersion: 1,
      type: "web.proxy",
      payload: { method: "GET", path: "/api/workflows" },
    })).resolves.toMatchObject({ workflows: [{ id: "allowed-workflow" }] });
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
    workspaceAliases: {},
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
