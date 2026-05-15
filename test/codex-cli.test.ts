import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { findExecutableOnPath, resolveCodexCli } from "../src/codex-cli.js";

describe("codex-cli", () => {
  it("uses an explicit CODEX_CLI_PATH when configured", () => {
    expect(resolveCodexCli({ CODEX_CLI_PATH: "/opt/codex" })).toEqual({
      path: "/opt/codex",
      source: "env",
    });
  });

  it("can force the SDK-bundled CLI", () => {
    expect(resolveCodexCli({ CODEX_USE_BUNDLED_CLI: "true", PATH: "/usr/bin" })).toEqual({
      source: "bundled",
    });
  });

  it("finds codex on PATH and skips the project-local npm shim", () => {
    const originalCwd = process.cwd();
    const tempDir = mkdtempSync(path.join(tmpdir(), "codex-cli-"));
    try {
      process.chdir(tempDir);
      const localBin = path.join(tempDir, "node_modules", ".bin");
      const globalBin = path.join(tempDir, "global-bin");
      mkdirSync(localBin, { recursive: true });
      mkdirSync(globalBin, { recursive: true });

      const localCodex = path.join(localBin, "codex");
      const globalCodex = path.join(globalBin, "codex");
      writeFileSync(localCodex, "#!/bin/sh\nexit 0\n");
      writeFileSync(globalCodex, "#!/bin/sh\nexit 0\n");
      chmodSync(localCodex, 0o755);
      chmodSync(globalCodex, 0o755);

      expect(findExecutableOnPath("codex", [localBin, globalBin].join(path.delimiter))).toBe(globalCodex);
    } finally {
      process.chdir(originalCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("prefers Windows PATHEXT matches before extensionless shims", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "codex-cli-"));
    try {
      const extensionlessNpm = path.join(tempDir, "npm");
      const cmdNpm = path.join(tempDir, "npm.cmd");
      writeFileSync(extensionlessNpm, "#!/bin/sh\nexit 0\n");
      writeFileSync(cmdNpm, "@echo off\r\nexit /b 0\r\n");
      chmodSync(extensionlessNpm, 0o755);
      chmodSync(cmdNpm, 0o755);

      expect(findExecutableOnPath("npm", tempDir, { platform: "win32", pathext: ".cmd;.exe" })).toBe(cmdNpm);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
