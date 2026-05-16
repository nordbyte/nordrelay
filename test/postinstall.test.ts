import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "scripts", "postinstall.mjs");

function runPostinstall(env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [script], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
    },
  });
}

describe("postinstall PATH check", () => {
  it("prints a macOS PATH hint when the global npm bin directory is missing", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "nordrelay-postinstall-"));
    try {
      const result = runPostinstall({
        NORDRELAY_POSTINSTALL_CHECK: "1",
        NORDRELAY_POSTINSTALL_PLATFORM: "darwin",
        npm_config_global: "true",
        npm_config_prefix: dir,
        PATH: "/usr/bin:/bin",
        SHELL: "/bin/zsh",
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toContain("npm global bin directory is not in your PATH");
      expect(result.stderr).toContain(path.join(dir, "bin"));
      expect(result.stderr).toContain("~/.zshrc");
      expect(result.stderr).toContain("nordrelay init");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stays quiet when the npm global bin directory is already in PATH", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "nordrelay-postinstall-"));
    try {
      const binDir = path.join(dir, "bin");
      const result = runPostinstall({
        NORDRELAY_POSTINSTALL_CHECK: "1",
        NORDRELAY_POSTINSTALL_PLATFORM: "darwin",
        npm_config_global: "true",
        npm_config_prefix: dir,
        PATH: ["/usr/bin", binDir].join(path.delimiter),
        SHELL: "/bin/zsh",
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not warn for local development installs", () => {
    const result = runPostinstall({
      npm_config_global: "false",
      npm_config_location: "project",
      npm_config_prefix: "/tmp/nordrelay-missing-prefix",
      PATH: "/usr/bin:/bin",
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });
});
