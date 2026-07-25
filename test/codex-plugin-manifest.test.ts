import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const manifestCheckPath = path.resolve("scripts", "check-codex-plugin.mjs");
const temporaryRoots: string[] = [];
const currentPackage = JSON.parse(readFileSync("package.json", "utf8")) as Record<string, unknown>;
const currentManifest = JSON.parse(
  readFileSync("plugins/nordrelay/.codex-plugin/plugin.json", "utf8"),
) as Record<string, unknown>;

describe("Codex plugin manifest", () => {
  afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the checked-in manifest release-ready", () => {
    const result = runManifestCheck(path.resolve());

    expect(result.status, outputOf(result)).toBe(0);
    expect(result.stdout).toContain("Codex plugin manifest check passed.");
  });

  it("rejects version drift, excess prompts, and missing assets", () => {
    const root = createFixture({
      ...currentManifest,
      version: "0.0.0",
      interface: {
        ...(currentManifest.interface as Record<string, unknown>),
        defaultPrompt: ["One", "Two", "Three", "Four"],
        logo: "./assets/missing.svg",
      },
    });

    const result = runManifestCheck(root);
    const output = outputOf(result);

    expect(result.status, output).toBe(1);
    expect(output).toContain("does not match package.json version");
    expect(output).toContain("between 1 and 3");
    expect(output).toContain("does not exist");
  });

  it("rejects incomplete discovery metadata and empty screenshots", () => {
    const root = createFixture({
      ...currentManifest,
      keywords: ["codex"],
      interface: {
        ...(currentManifest.interface as Record<string, unknown>),
        screenshots: [],
      },
    });

    const result = runManifestCheck(root);
    const output = outputOf(result);

    expect(result.status, output).toBe(1);
    expect(output).toContain('keywords must include "claude-code"');
    expect(output).toContain('keywords must include "matrix"');
    expect(output).toContain("screenshots must be omitted");
  });
});

function runManifestCheck(root: string) {
  return spawnSync(process.execPath, [manifestCheckPath, root], {
    encoding: "utf8",
  });
}

function outputOf(result: ReturnType<typeof runManifestCheck>): string {
  return [result.stdout, result.stderr, result.error?.message].filter(Boolean).join("\n");
}

function createFixture(manifest: Record<string, unknown>): string {
  const root = mkdtempSync(path.join(tmpdir(), "nordrelay-codex-plugin-"));
  temporaryRoots.push(root);
  const pluginRoot = path.join(root, "plugins", "nordrelay");
  mkdirSync(path.join(pluginRoot, ".codex-plugin"), { recursive: true });
  mkdirSync(path.join(pluginRoot, "assets"), { recursive: true });
  mkdirSync(path.join(pluginRoot, "skills"), { recursive: true });
  writeFileSync(path.join(root, "package.json"), JSON.stringify(currentPackage), "utf8");
  writeFileSync(path.join(pluginRoot, ".codex-plugin", "plugin.json"), JSON.stringify(manifest), "utf8");
  writeFileSync(path.join(pluginRoot, "assets", "nordrelay.svg"), "<svg></svg>", "utf8");
  return root;
}
