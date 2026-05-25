import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { PluginService } from "../src/plugins/plugin-service.js";
import { validatePluginManifest } from "../src/plugins/plugin-manifest.js";

async function createPluginFixture(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "nordrelay-plugin-fixture-"));
  await writeFile(path.join(dir, "nordrelay.plugin.json"), JSON.stringify({
    id: "example-plugin",
    name: "Example Plugin",
    version: "0.1.0",
    description: "Test plugin",
    entry: "index.js",
    permissions: ["files.read"],
    capabilities: {
      workflowActions: [
        { id: "example.echo", title: "Echo" },
      ],
      commands: [
        { name: "example", description: "Example command" },
      ],
    },
    settings: [
      { key: "prefix", label: "Prefix", type: "string", default: "ok" },
      { key: "token", label: "Token", type: "secret" },
    ],
  }, null, 2));
  await writeFile(path.join(dir, "index.js"), [
    "process.stdin.setEncoding('utf8');",
    "let input='';",
    "process.stdin.on('data',chunk=>input+=chunk);",
    "process.stdin.on('end',()=>{",
    "  const payload=JSON.parse(input);",
    "  process.stdout.write(JSON.stringify({ actionId: payload.actionId, input: payload.input, prefix: payload.settings.prefix })+'\\n');",
    "});",
  ].join("\n"));
  return dir;
}

describe("plugin system", () => {
  it("validates required manifest fields", () => {
    const result = validatePluginManifest({ id: "Bad ID", name: "", version: "latest" });

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.message).join("\n")).toContain("Manifest id");
    expect(result.issues.map((issue) => issue.message).join("\n")).toContain("Manifest name");
    expect(result.issues.map((issue) => issue.message).join("\n")).toContain("Manifest version");
  });

  it("installs, enables, catalogs, stores settings, and invokes workflow actions", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "nordrelay-plugin-home-"));
    const fixture = await createPluginFixture();
    const service = new PluginService(home);

    const installed = await service.install({
      source: fixture,
      enable: false,
      approvePermissions: false,
    });
    expect(installed.id).toBe("example-plugin");
    expect(installed.enabled).toBe(false);
    expect(installed.settings.prefix).toBe("ok");
    expect(installed.settings.token).toBe("");

    const enabled = await service.enable("example-plugin");
    expect(enabled.enabled).toBe(true);
    expect(enabled.approvedPermissions).toContain("files.read");

    const updated = await service.updateSettings("example-plugin", { prefix: "custom", token: "secret-value" });
    expect(updated.settings.prefix).toBe("custom");
    expect(updated.settings.token).toBe("");
    expect(updated.settingsSummary.token).toBe("configured");

    const catalog = await service.catalog();
    expect(catalog.workflowActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ pluginId: "example-plugin", actionId: "example.echo" }),
    ]));
    expect(catalog.commands).toEqual(expect.arrayContaining([
      expect.objectContaining({ pluginId: "example-plugin", name: "example" }),
    ]));

    const result = await service.invokeWorkflowAction("example-plugin", "example.echo", { text: "hello" });
    expect(result.ok).toBe(true);
    expect(result.output).toMatchObject({
      actionId: "example.echo",
      input: { text: "hello" },
      prefix: "custom",
    });
  });

  it("scaffolds a valid plugin template", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "nordrelay-plugin-home-"));
    const target = path.join(home, "new-plugin");
    const service = new PluginService(home);

    await service.scaffold({ targetDir: target, id: "new-plugin", name: "New Plugin" });
    const validation = await service.validate(target);

    expect(validation.ok).toBe(true);
    expect(validation.manifest?.id).toBe("new-plugin");
  });
});

