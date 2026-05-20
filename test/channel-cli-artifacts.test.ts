import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AgentSessionInfo, AgentSessionService } from "../src/agents/shared/agent.js";
import type { ConnectorConfig } from "../src/core/config.js";
import { deliverChannelCliArtifacts } from "../src/channels/shared/channel-cli-artifacts.js";
import type { ChannelExternalMirrorState } from "../src/channels/shared/channel-bridge-state.js";

const tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("channel CLI artifact delivery", () => {
  it("deduplicates concurrent delivery for the same external turn", async () => {
    const workspace = await makeWorkspace();
    const startedAt = await writeRecentArtifact(workspace);
    const state = mirrorState();
    const summaries: string[] = [];

    const first = deliverChannelCliArtifacts({
      config: config(workspace),
      contextKey: "discord:guild:channel",
      session: session(workspace),
      startedAt,
      turnId: "turn-1",
      state,
      autoSend: false,
      sendSummaryWhenAutoSendDisabled: true,
      logPrefix: "Discord",
      sendSummary: async (summary) => {
        summaries.push(summary);
      },
      sendArtifact: async () => {},
      appendActivity: () => {},
    });
    const second = deliverChannelCliArtifacts({
      config: config(workspace),
      contextKey: "discord:guild:channel",
      session: session(workspace),
      startedAt,
      turnId: "turn-1",
      state,
      autoSend: false,
      sendSummaryWhenAutoSendDisabled: true,
      logPrefix: "Discord",
      sendSummary: async (summary) => {
        summaries.push(summary);
      },
      sendArtifact: async () => {},
      appendActivity: () => {},
    });

    await Promise.all([first, second]);

    expect(summaries).toHaveLength(1);
    expect(state.artifactsDeliveredForTurnId).toBe("turn-1");
    expect(state.artifactsDeliveryInFlightForTurnId).toBeNull();
  });

  it("retries if the in-flight delivery fails before being marked delivered", async () => {
    const workspace = await makeWorkspace();
    const startedAt = await writeRecentArtifact(workspace);
    const state = mirrorState();
    let attempts = 0;

    await expect(deliverChannelCliArtifacts({
      config: config(workspace),
      contextKey: "discord:guild:channel",
      session: session(workspace),
      startedAt,
      turnId: "turn-1",
      state,
      autoSend: false,
      sendSummaryWhenAutoSendDisabled: true,
      logPrefix: "Discord",
      sendSummary: async () => {
        attempts += 1;
        throw new Error("network failed");
      },
      sendArtifact: async () => {},
      appendActivity: () => {},
    })).rejects.toThrow("network failed");

    await deliverChannelCliArtifacts({
      config: config(workspace),
      contextKey: "discord:guild:channel",
      session: session(workspace),
      startedAt,
      turnId: "turn-1",
      state,
      autoSend: false,
      sendSummaryWhenAutoSendDisabled: true,
      logPrefix: "Discord",
      sendSummary: async () => {
        attempts += 1;
      },
      sendArtifact: async () => {},
      appendActivity: () => {},
    });

    expect(attempts).toBe(2);
    expect(state.artifactsDeliveredForTurnId).toBe("turn-1");
    expect(state.artifactsDeliveryInFlightForTurnId).toBeNull();
  });
});

async function makeWorkspace(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "nordrelay-artifacts-"));
  tmpDirs.push(dir);
  return dir;
}

async function writeRecentArtifact(workspace: string): Promise<Date> {
  const startedAt = new Date(Date.now() - 60_000);
  const modifiedAt = new Date(Date.now() - 1_000);
  const filePath = path.join(workspace, "result.txt");
  await writeFile(filePath, "hello");
  await utimes(filePath, modifiedAt, modifiedAt);
  return startedAt;
}

function config(workspace: string): ConnectorConfig {
  return {
    workspace,
    maxFileSize: 1024 * 1024,
    artifactIgnoreDirs: [],
    artifactIgnoreGlobs: [],
  } as ConnectorConfig;
}

function session(workspace: string): AgentSessionService {
  const info: AgentSessionInfo = {
    agentId: "codex",
    agentLabel: "Codex",
    threadId: "thread-1",
    workspace,
    model: "gpt-5.5",
    launchProfileId: "default",
    launchProfileLabel: "Default",
    launchProfileBehavior: "workspace-write / never",
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
    fastMode: false,
    unsafeLaunch: false,
  };
  return {
    getInfo: () => info,
    getActiveThreadId: () => info.threadId,
  } as AgentSessionService;
}

function mirrorState(): ChannelExternalMirrorState<string> {
  return {
    threadId: "thread-1",
    rolloutPath: "/tmp/rollout.jsonl",
    lastLine: 1,
    turnId: "turn-1",
    startedAt: new Date(Date.now() - 10_000),
  };
}
