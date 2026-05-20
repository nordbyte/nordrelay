import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ConnectorConfig } from "../src/core/config.js";
import {
  getAgentUpdateLogPath,
  getConnectorLogPath,
  getUpdateLogPath,
  type ConnectorHealth,
  type VersionCheck,
  type VersionChecks,
} from "../src/support/operations.js";
import { createSupportBundle } from "../src/support/support-bundle.js";

const originalHome = process.env.NORDRELAY_HOME;
let tempHome: string | null = null;

afterEach(async () => {
  process.env.NORDRELAY_HOME = originalHome;
  if (tempHome) {
    await rm(tempHome, { recursive: true, force: true });
    tempHome = null;
  }
});

describe("support bundle", () => {
  it("exports a ZIP with redacted config, runtime data, logs, audit events, and update jobs", async () => {
    tempHome = await mkdtemp(path.join(os.tmpdir(), "nordrelay-support-"));
    process.env.NORDRELAY_HOME = tempHome;
    await writeFile(getConnectorLogPath(), "2026-05-14 12:00:00 INFO boot ok\nTELEGRAM_BOT_TOKEN=secret-token\n", "utf8");
    await writeFile(getUpdateLogPath(), "2026-05-14 12:01:00 WARN update pending\n", "utf8");
    await writeFile(getAgentUpdateLogPath(), "2026-05-14 12:02:00 ERROR agent failed\n", "utf8");

    const bundle = await createSupportBundle({
      config: {
        telegramBotToken: "secret-token",
        hermesApiKey: "secret-hermes",
        openClawGatewayPassword: "secret-password",
        workspace: tempHome,
        stateBackend: "json",
      } as unknown as ConnectorConfig,
      health: fakeHealth(tempHome),
      versionChecks: fakeVersionChecks(),
      auditEvents: [{
        id: "audit1",
        timestamp: "2026-05-14T12:00:00.000Z",
        action: "command",
        status: "ok",
        contextKey: "web",
        channelId: "web",
        description: "export diagnostics bundle",
      }],
      agentUpdateJobs: [{
        id: "job1",
        agentId: "pi",
        agentLabel: "Pi",
        operation: "update",
        status: "completed",
        method: "npm",
        command: "npm",
        args: ["install", "-g", "@earendil-works/pi-coding-agent"],
        cwd: tempHome,
        summary: "update pi",
        interactive: false,
        canInput: false,
        needsInput: false,
        startedAt: "2026-05-14T12:00:00.000Z",
        updatedAt: "2026-05-14T12:01:00.000Z",
        finishedAt: "2026-05-14T12:01:00.000Z",
        logPath: path.join(tempHome, "updates", "job1.log"),
        outputTail: "done",
      }],
      source: "web",
    });

    const contents = (await readFile(bundle.path)).toString("utf8");
    expect(bundle.name).toMatch(/^nordrelay-diagnostics-\d{8}-\d{6}\.zip$/);
    expect(bundle.includedFiles).toContain("config/redacted-config.json");
    expect(bundle.includedFiles).toContain("runtime/health.json");
    expect(bundle.includedFiles).toContain("audit/recent-events.json");
    expect(bundle.includedFiles).toContain("updates/jobs.json");
    expect(contents).toContain("manifest.json");
    expect(contents).toContain("logs/connector.log");
    expect(contents).toContain("[REDACTED]");
    expect(contents).not.toContain("secret-token");
    expect(contents).not.toContain("secret-hermes");
    expect(contents).not.toContain("secret-password");
  });
});

function fakeHealth(home: string): ConnectorHealth {
  return {
    version: "0.5.0",
    state: { status: "running", pid: process.pid, workspace: home },
    pidRunning: true,
    appPidRunning: true,
    codexCli: "codex",
    codexCliPath: "/usr/bin/codex",
    codexCliVersion: "codex 1.0.0",
    piCli: "pi",
    piCliPath: null,
    piCliVersion: "not installed",
    hermesCli: "hermes",
    hermesCliPath: null,
    hermesCliVersion: "not installed",
    openClawCli: "openclaw",
    openClawCliPath: null,
    openClawCliVersion: "not installed",
    claudeCodeCli: "claude",
    claudeCodeCliPath: null,
    claudeCodeCliVersion: "not installed",
    stateFile: path.join(home, "state.json"),
    logFile: getConnectorLogPath(),
    databasePath: null,
    uptimeSeconds: 10,
  };
}

function fakeVersionChecks(): VersionChecks {
  return {
    nordrelay: version("NordRelay", "@nordbyte/nordrelay"),
    codex: version("Codex", "@openai/codex"),
    pi: version("Pi", "@earendil-works/pi-coding-agent"),
    hermes: version("Hermes", "hermes-agent"),
    openclaw: version("OpenClaw", "openclaw"),
    claudeCode: version("Claude Code", "@anthropic-ai/claude-code"),
  };
}

function version(label: string, packageName: string): VersionCheck {
  return {
    label,
    packageName,
    installedLabel: "1.0.0",
    installedVersion: "1.0.0",
    latestVersion: "1.0.0",
    status: "current",
  };
}
