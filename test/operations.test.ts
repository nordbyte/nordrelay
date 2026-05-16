import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { clearLogFile, detectSelfUpdateMethod, readFormattedLogTail, resolveNpmSpawnCommand } from "../src/support/operations.js";

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "nordrelay-ops-"));
  tempDirs.push(dir);
  return dir;
}

describe("operations", () => {
  const originalEnv = process.env;

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
    process.env = originalEnv;
  });

  it("formats log tails with timestamps, levels, and plain legacy lines", async () => {
    const dir = createTempDir();
    const file = path.join(dir, "nordrelay.log");
    writeFileSync(file, [
      "legacy startup line",
      "[2026-05-12T12:30:00.000Z] Starting git connector self-update",
      "[2026-05-12 14:30:01 +02:00] WARN token=secret-value",
      JSON.stringify({ ts: "2026-05-12T12:30:02.000Z", level: "error", event: "console", message: "failed" }),
    ].join("\n"));

    const tail = await readFormattedLogTail(10, file);

    expect(tail.filePath).toBe(file);
    expect(tail.lineCount).toBe(4);
    expect(tail.plain).toContain("legacy startup line");
    expect(tail.plain).not.toContain("no timestamp");
    expect(tail.plain).toContain("Starting git connector self-update");
    expect(tail.plain).not.toContain("+02:00");
    expect(tail.plain).toContain("WARN");
    expect(tail.plain).toContain("token=[redacted]");
    expect(tail.plain).toContain("ERROR");
    expect(tail.plain).toContain("failed");
  });

  it("detects git checkouts and npm installs for self-update", () => {
    const gitRoot = createTempDir();
    mkdirSync(path.join(gitRoot, ".git"));
    const packageRoot = createTempDir();

    expect(detectSelfUpdateMethod(gitRoot)).toBe("git");
    expect(detectSelfUpdateMethod(packageRoot)).toBe("npm");

    process.env = { ...originalEnv, NORDRELAY_UPDATE_METHOD: "npm" };
    expect(detectSelfUpdateMethod(gitRoot)).toBe("npm");
  });

  it("resolves npm through npm_execpath for Windows-safe spawned commands", () => {
    const dir = createTempDir();
    const npmCli = path.join(dir, "npm-cli.js");
    writeFileSync(npmCli, "process.exit(0);\n");

    expect(resolveNpmSpawnCommand({ ...process.env, npm_execpath: npmCli })).toMatchObject({
      command: process.execPath,
      argsPrefix: [npmCli],
      shell: false,
    });
  });

  it.runIf(process.platform === "win32")("prefers npm.cmd over the extensionless npm shim on Windows", () => {
    const dir = createTempDir();
    const extensionlessNpm = path.join(dir, "npm");
    const cmdNpm = path.join(dir, "npm.cmd");
    writeFileSync(extensionlessNpm, "#!/bin/sh\nexit 0\n");
    writeFileSync(cmdNpm, "@echo off\r\nexit /b 0\r\n");
    chmodSync(extensionlessNpm, 0o755);
    chmodSync(cmdNpm, 0o755);

    expect(resolveNpmSpawnCommand({ ...process.env, PATH: dir, PATHEXT: ".cmd" })).toMatchObject({
      command: cmdNpm,
      argsPrefix: [],
      shell: true,
    });
  });

  it("clears log files", () => {
    const dir = createTempDir();
    const file = path.join(dir, "nordrelay.log");
    writeFileSync(file, "line one\nline two\n");

    const result = clearLogFile(file);

    expect(result.filePath).toBe(file);
    expect(result.clearedAt).toBeInstanceOf(Date);
    expect(readFileSync(file, "utf8")).toBe("");
  });
});
