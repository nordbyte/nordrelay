import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { validateCodexPluginManifest } from "../scripts/check-codex-plugin.mjs";

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
    expect(validateCodexPluginManifest()).toEqual([]);
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

    expect(validateCodexPluginManifest(root)).toEqual(expect.arrayContaining([
      expect.stringContaining("does not match package.json version"),
      expect.stringContaining("between 1 and 3"),
      expect.stringContaining("does not exist"),
    ]));
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

    expect(validateCodexPluginManifest(root)).toEqual(expect.arrayContaining([
      expect.stringContaining('keywords must include "claude-code"'),
      expect.stringContaining('keywords must include "matrix"'),
      expect.stringContaining("screenshots must be omitted"),
    ]));
  });
});

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
