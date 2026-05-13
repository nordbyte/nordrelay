import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AgentUpdateManager, resolveAgentUpdatePlan } from "../src/agent-updates.js";

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "nordrelay-agent-update-"));
  tempDirs.push(dir);
  return dir;
}

describe("agent updates", () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("resolves agent-specific update commands", () => {
    expect(resolveAgentUpdatePlan("codex", { env: { ...process.env, CODEX_CLI_PATH: "/tmp/codex" } })).toMatchObject({
      method: "codex update",
      command: "/tmp/codex",
      args: ["update"],
    });
    expect(resolveAgentUpdatePlan("pi", { piCliPath: "/tmp/pi" })).toMatchObject({
      method: "pi update pi",
      command: "/tmp/pi",
      args: ["update", "pi"],
    });
    expect(resolveAgentUpdatePlan("hermes", { hermesCliPath: "/tmp/hermes" })).toMatchObject({
      method: "hermes update --yes",
      args: ["update", "--yes"],
    });
    expect(resolveAgentUpdatePlan("openclaw", { openClawCliPath: "/tmp/openclaw" })).toMatchObject({
      method: "openclaw update --yes",
      args: ["update", "--yes"],
    });
    expect(resolveAgentUpdatePlan("claude-code", { claudeCodeCliPath: "/tmp/claude" })).toMatchObject({
      method: "claude update",
      args: ["update"],
    });
  });

  it("runs update jobs, accepts input, and redacts output logs", async () => {
    const dir = createTempDir();
    const bin = path.join(dir, "codex");
    writeFileSync(bin, [
      "#!/usr/bin/env node",
      "process.stderr.write('api_key=secret-value\\n');",
      "process.stdout.write('Proceed? ');",
      "process.stdin.once('data', input => {",
      "  process.stdout.write('answer ' + input.toString().trim() + '\\n');",
      "  setTimeout(() => process.exit(0), 10);",
      "});",
    ].join("\n"));
    chmodSync(bin, 0o755);

    const manager = new AgentUpdateManager({
      home: dir,
      env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}` },
    });
    const started = manager.start("codex");

    await waitFor(() => manager.get(started.id)?.needsInput === true);
    expect(() => manager.deleteLog(started.id)).toThrow(/still running/i);
    manager.sendInput(started.id, "yes");
    await waitFor(() => manager.get(started.id)?.status === "completed");

    const finished = manager.get(started.id);
    expect(finished?.exitCode).toBe(0);
    expect(finished?.outputTail).toContain("Proceed?");
    expect(finished?.outputTail).toContain("answer yes");
    expect(finished?.outputTail).not.toContain("secret-value");
    expect(readFileSync(started.logPath, "utf8")).toContain("api_key=[REDACTED]");
    expect(readFileSync(path.join(dir, "agent-updates.log"), "utf8")).toContain("api_key=[REDACTED]");

    const reloaded = new AgentUpdateManager({ home: dir });
    expect(reloaded.get(started.id)).toMatchObject({
      id: started.id,
      status: "completed",
      agentId: "codex",
    });
    expect(existsSync(path.join(dir, "updates", "jobs.json"))).toBe(true);

    const deleted = reloaded.deleteLog(started.id);
    expect(deleted).toMatchObject({ id: started.id, status: "completed" });
    expect(existsSync(started.logPath)).toBe(false);
    expect(reloaded.get(started.id)).toBeNull();
    expect(() => reloaded.readLog(started.id)).toThrow(/unknown update job/i);

    const afterDeleteReload = new AgentUpdateManager({ home: dir });
    expect(afterDeleteReload.get(started.id)).toBeNull();
    expect(afterDeleteReload.list().some((job) => job.id === started.id)).toBe(false);
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
