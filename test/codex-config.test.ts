import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readCodexFastMode, writeCodexFastMode } from "../src/agents/codex/codex-config.js";

describe("codex-config", () => {
  const originalCodexHome = process.env.CODEX_HOME;
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  let home: string;
  let configPath: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "codex-config-"));
    configPath = path.join(home, ".codex", "config.toml");
    mkdirSync(path.dirname(configPath), { recursive: true });
    process.env.HOME = home;
    delete process.env.CODEX_HOME;
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = originalUserProfile;
    }
    if (originalCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = originalCodexHome;
    }
  });

  it("reads fast mode from fast_default_opt_out", () => {
    writeFileSync(configPath, "[notice]\nfast_default_opt_out = true\n", "utf8");

    expect(readCodexFastMode()).toBe(false);

    writeFileSync(configPath, "[notice]\nfast_default_opt_out = false\n", "utf8");

    expect(readCodexFastMode()).toBe(true);
  });

  it("returns null when fast mode is not configured", () => {
    writeFileSync(configPath, "[notice]\nhide_full_access_warning = true\n", "utf8");

    expect(readCodexFastMode()).toBeNull();
  });

  it("updates an existing fast mode setting", () => {
    writeFileSync(configPath, "[notice]\nfast_default_opt_out = true # comment\n", "utf8");

    writeCodexFastMode(true);

    expect(readFileSync(configPath, "utf8")).toBe("[notice]\nfast_default_opt_out = false # comment\n");
  });

  it("adds fast mode under an existing notice section", () => {
    writeFileSync(configPath, "[notice]\nhide_full_access_warning = true\n", "utf8");

    writeCodexFastMode(false);

    expect(readFileSync(configPath, "utf8")).toBe(
      "[notice]\nfast_default_opt_out = true\nhide_full_access_warning = true\n",
    );
  });

  it("creates the notice section when the config file is missing", () => {
    rmSync(configPath, { force: true });

    writeCodexFastMode(true);

    expect(readFileSync(configPath, "utf8")).toBe("[notice]\nfast_default_opt_out = false\n");
  });

  it("uses USERPROFILE for the Codex config path when HOME is not set", () => {
    delete process.env.HOME;
    process.env.USERPROFILE = home;
    rmSync(configPath, { force: true });

    writeCodexFastMode(false);

    expect(readFileSync(configPath, "utf8")).toBe("[notice]\nfast_default_opt_out = true\n");
  });
});
