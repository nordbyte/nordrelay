import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildConnectorChildEnv, clearLogFile, detectSelfUpdateMethod, getVersionChecks, readFormattedLogTail, resolveNpmSpawnCommand } from "../src/support/operations.js";

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

  it("paginates and filters formatted logs server-side", async () => {
    const dir = createTempDir();
    const file = path.join(dir, "nordrelay.log");
    writeFileSync(file, [
      "[2026-05-12 14:30:01 +02:00] INFO first",
      "[2026-05-12 14:30:02 +02:00] WARN second",
      "continued warning",
      "[2026-05-12 14:30:03 +02:00] ERROR third token=secret-value",
      "[2026-05-12 14:30:04 +02:00] INFO fourth",
    ].join("\n"));

    const firstPage = await readFormattedLogTail({ limit: 2, level: "all" }, file);

    expect(firstPage.lineCount).toBe(2);
    expect(firstPage.plain).toContain("ERROR third token=[redacted]");
    expect(firstPage.plain).toContain("INFO  fourth");
    expect(firstPage.pagination?.hasNext).toBe(true);
    expect(firstPage.pagination?.total).toBe(5);

    const secondPage = await readFormattedLogTail({ limit: 2, cursor: firstPage.pagination?.nextCursor }, file);

    expect(secondPage.plain).toContain("WARN  second");
    expect(secondPage.plain).toContain("continued warning");

    const warnPage = await readFormattedLogTail({ limit: 10, level: "WARN" }, file);

    expect(warnPage.entries?.map((entry) => entry.line)).toEqual(expect.arrayContaining([
      expect.stringContaining("WARN  second"),
      "continued warning",
    ]));
    expect(warnPage.plain).not.toContain("ERROR third");
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

  it("adds Node and npm global bin directories to connector child PATH", () => {
    const prefix = createTempDir();
    const env = buildConnectorChildEnv({}, {
      PATH: "/usr/bin",
      npm_config_prefix: prefix,
    });
    const pathEntries = String(env.PATH || "").split(path.delimiter);

    expect(pathEntries).toContain(path.dirname(process.execPath));
    expect(pathEntries).toContain(process.platform === "win32" ? prefix : path.join(prefix, "bin"));
    expect(pathEntries.at(-1)).toBe("/usr/bin");
  });

  it("bypasses the latest-version cache for forced version checks", async () => {
    const dir = createTempDir();
    const fakeNpm = path.join(dir, "npm-cli.js");
    const versionFile = path.join(dir, "version.txt");
    writeFileSync(versionFile, "1.0.0\n");
    writeFileSync(fakeNpm, [
      "const fs = require('node:fs');",
      "if (!process.argv.includes('view')) process.exit(1);",
      "console.log(fs.readFileSync(process.env.NORDRELAY_FAKE_NPM_VERSION_FILE, 'utf8').trim());",
    ].join("\n"));
    process.env = {
      ...originalEnv,
      PATH: dir,
      npm_execpath: fakeNpm,
      NORDRELAY_HOME: dir,
      NORDRELAY_VERSION_CACHE_TTL_MS: "600000",
      NORDRELAY_CLI_VERSION_CACHE_TTL_MS: "0",
      NORDRELAY_FAKE_NPM_VERSION_FILE: versionFile,
    };

    const first = await getVersionChecks();
    writeFileSync(versionFile, "1.0.1\n");
    const cached = await getVersionChecks();
    const forced = await getVersionChecks({ forceRefresh: true });

    expect(first.nordrelay.latestVersion).toBe("1.0.0");
    expect(cached.nordrelay.latestVersion).toBe("1.0.0");
    expect(forced.nordrelay.latestVersion).toBe("1.0.1");
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
