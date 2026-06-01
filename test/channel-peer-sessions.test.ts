import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { AgentSessionInfo, AgentThreadRecord } from "../src/agents/shared/agent.js";
import {
  listTargetPeerSessions,
  parseRemoteSessionChoice,
  remoteSessionChoiceValue,
  renderTargetPeerMirrorPreference,
  renderTargetPeerSession,
  selectedTargetNodeLabel,
  switchTargetPeerSession,
  type RemotePeerWebClient,
} from "../src/channels/shared/channel-peer-sessions.js";
import { BotPreferencesStore } from "../src/state/bot-preferences.js";
import type { PeerWebProxyPayload } from "../src/peers/peer-types.js";
import type { WebActivityActor } from "../src/web/web-state.js";

describe("channel peer session helpers", () => {
  it("returns null when no peer target is selected", async () => {
    const preferencesStore = new BotPreferencesStore(tempWorkspace());
    await expect(renderTargetPeerSession({ contextKey: "telegram:1", preferencesStore })).resolves.toBeNull();
  });

  it("lists and switches sessions through the selected peer", async () => {
    const preferencesStore = new BotPreferencesStore(tempWorkspace());
    preferencesStore.update("telegram:1", { targetPeerId: "peer-a" });
    const requests: Array<{ payload: PeerWebProxyPayload; sourceContextKey?: string }> = [];
    const client = fakeClient({
      "/api/snapshot": { session: sessionInfo("thread-1") },
      "/api/sessions": { sessions: [threadRecord("thread-1"), threadRecord("thread-2")] },
      "/api/sessions/switch": { session: sessionInfo("thread-2") },
    }, requests);

    const listed = await listTargetPeerSessions({ contextKey: "telegram:1", preferencesStore, remoteClient: client });
    expect(listed?.sessions.map((record) => record.id)).toEqual(["thread-1", "thread-2"]);
    expect(listed?.sessions[0]?.updatedAt).toBeInstanceOf(Date);
    expect(listed?.sessions[0]?.createdAt).toBeInstanceOf(Date);
    expect(listed?.activeThreadId).toBe("thread-1");
    expect(requests.find((request) => request.payload.path === "/api/sessions")?.payload.query).toMatchObject({ agent: "codex" });

    const switched = await switchTargetPeerSession({ contextKey: "telegram:1", preferencesStore, remoteClient: client, threadId: "thread-2" });
    expect(switched?.info.threadId).toBe("thread-2");
    expect(preferencesStore.get("telegram:1")).toMatchObject({
      targetPeerId: "peer-a",
      targetThreadId: "thread-2",
      targetAgentId: "codex",
    });
    expect(requests.find((request) => request.payload.path === "/api/sessions/switch")?.sourceContextKey).toBe("telegram:1:thread:thread-2");
    expect(parseRemoteSessionChoice(remoteSessionChoiceValue("peer-a", "thread-2"))).toEqual({ peerId: "peer-a", threadId: "thread-2" });
  });

  it("stores remote mirror mode locally so persistent subscriptions can resume", async () => {
    const preferencesStore = new BotPreferencesStore(tempWorkspace());
    preferencesStore.update("discord:g:c", { targetPeerId: "peer-a" });
    const response = await renderTargetPeerMirrorPreference({
      source: "discord",
      contextKey: "discord:g:c",
      argument: "full",
      preferencesStore,
      remoteClient: fakeClient({
        "/api/chat/mirror": {
          mode: "full",
          minInterval: 1200,
          response: { plain: "CLI mirroring: full", html: "<b>CLI mirroring:</b> <code>full</code>" },
        },
      }),
    });
    expect(response?.mode).toBe("full");
    expect(preferencesStore.get("discord:g:c").mirrorMode).toBe("full");
  });

  it("renders the selected node label for channel commands", () => {
    const preferencesStore = new BotPreferencesStore(tempWorkspace());
    expect(selectedTargetNodeLabel(preferencesStore, "telegram:1")).toBe("Local node");

    preferencesStore.update("telegram:1", { targetPeerId: "missing-peer-x" });
    expect(selectedTargetNodeLabel(preferencesStore, "telegram:1")).toBe("missing-peer-x");
  });
});

function fakeClient(responses: Record<string, unknown>, requests: Array<{ payload: PeerWebProxyPayload; sourceContextKey?: string }> = []): RemotePeerWebClient {
  return {
    async webProxy(_peerId: string, payload: PeerWebProxyPayload, _actor?: WebActivityActor, sourceContextKey?: string): Promise<unknown> {
      requests.push({ payload, sourceContextKey });
      if (!(payload.path in responses)) {
        throw new Error(`Unexpected path ${payload.path}`);
      }
      return responses[payload.path];
    },
  };
}

function tempWorkspace(): string {
  return mkdtempSync(path.join(tmpdir(), "nordrelay-peer-sessions-"));
}

function sessionInfo(threadId: string): AgentSessionInfo {
  return {
    agentId: "codex",
    agentLabel: "Codex",
    threadId,
    workspace: "/workspace",
    model: "gpt-5.5",
    capabilities: {},
  } as AgentSessionInfo;
}

function threadRecord(id: string): AgentThreadRecord {
  return {
    id,
    title: `Thread ${id}`,
    cwd: "/workspace",
    firstUserMessage: "Prompt",
    createdAt: "2026-05-21T09:59:00.000Z",
    updatedAt: "2026-05-21T10:00:00.000Z",
  } as AgentThreadRecord;
}
