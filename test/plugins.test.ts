import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { PluginService } from "../src/plugins/plugin-service.js";
import { validatePluginManifest } from "../src/plugins/plugin-manifest.js";
import { PluginCollectorScheduler } from "../src/plugins/plugin-collector-scheduler.js";
import { pluginMarketplaceEntries } from "../src/plugins/plugin-marketplace.js";

async function createPluginFixture(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "nordrelay-plugin-fixture-"));
  await writeFile(path.join(dir, "nordrelay.plugin.json"), JSON.stringify({
    id: "example-plugin",
    name: "Example Plugin",
    version: "0.1.0",
    description: "Test plugin",
    entry: "index.js",
    permissions: ["files.read", "runtime.read", "system.metrics.read"],
    capabilities: {
      workflowActions: [
        { id: "example.echo", title: "Echo", inputSchema: { type: "object", properties: { text: { type: "string" } } }, outputVariables: { echoed: "input.text" } },
      ],
      commands: [
        { name: "example", description: "Example command", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
      ],
      webPanels: [
        { id: "panel", title: "Panel" },
      ],
      artifactHandlers: [
        { id: "artifact.echo", title: "Artifact Echo" },
      ],
      collectors: [
        { id: "metrics.sample", title: "Metrics Sample", intervalMs: 1000, runOnStart: true },
      ],
      diagnostics: true,
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
    "  process.stdout.write(JSON.stringify({ ok: true, output: { type: payload.type, actionId: payload.actionId, command: payload.command, panelId: payload.panelId, handlerId: payload.handlerId, collectorId: payload.collectorId, input: payload.input, prefix: payload.settings.prefix, context: payload.context, leakedSecret: process.env.NORDRELAY_PLUGIN_TEST_SECRET || '' }, html: payload.type === 'web-panel' ? '<strong>Panel</strong>' : undefined, diagnostics: payload.type === 'diagnostics' ? { ok: true } : undefined })+'\\n');",
    "});",
  ].join("\n"));
  return dir;
}

async function createStringifiedPanelPluginFixture(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "nordrelay-plugin-stringified-panel-"));
  await writeFile(path.join(dir, "nordrelay.plugin.json"), JSON.stringify({
    id: "stringified-panel-plugin",
    name: "Stringified Panel Plugin",
    version: "0.1.0",
    description: "Test stringified panel output",
    entry: "index.js",
    capabilities: {
      webPanels: [
        { id: "panel", title: "Panel" },
      ],
    },
  }, null, 2));
  await writeFile(path.join(dir, "index.js"), [
    "process.stdin.resume();",
    "process.stdin.on('end',()=>{",
    "  const nested = { ok: true, html: '<strong>Nested Panel</strong>', variables: { panel: 'ok' }, diagnostics: { nested: true } };",
    "  process.stdout.write(JSON.stringify({ ok: true, output: JSON.stringify(nested) })+'\\n');",
    "});",
  ].join("\n"));
  return dir;
}

describe("plugin system", () => {
  it("exposes official marketplace entries with installable GitHub sources", () => {
    const entries = pluginMarketplaceEntries();
    const systemMonitor = entries.find((entry) => entry.id === "system-monitor");

    expect(systemMonitor).toMatchObject({
      name: "System Monitor",
      source: "github:nordbyte/nordrelay-plugin-system-monitor",
      official: true,
      approved: true,
    });
    expect(systemMonitor?.permissions).toContain("system.metrics.read");
  });

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
    const service = new PluginService(home, {
      hostContext: () => ({
        runtime: { version: "test" },
        artifacts: [{ id: "hidden" }],
      }),
    });

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
    expect(enabled.approvedPermissions).toContain("runtime.read");

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
    expect(catalog.collectors).toEqual(expect.arrayContaining([
      expect.objectContaining({ pluginId: "example-plugin", collectorId: "metrics.sample" }),
    ]));

    process.env.NORDRELAY_PLUGIN_TEST_SECRET = "should-not-leak";
    const result = await service.invokeWorkflowAction("example-plugin", "example.echo", { text: "hello" });
    delete process.env.NORDRELAY_PLUGIN_TEST_SECRET;
    expect(result.ok).toBe(true);
    expect(result.output).toMatchObject({
      actionId: "example.echo",
      input: { text: "hello" },
      prefix: "custom",
      context: { runtime: { version: "test" }, artifacts: [{ id: "hidden" }] },
      leakedSecret: "",
    });
    expect(result.variables).toEqual({ echoed: "hello" });

    const command = await service.invokeCommand("example-plugin", "example", { text: "cmd" });
    expect(command.ok).toBe(true);
    expect(command.output).toMatchObject({ command: "example", input: { text: "cmd" } });

    const panel = await service.invokeWebPanel("example-plugin", "panel", {});
    expect(panel.ok).toBe(true);
    expect(panel.html).toBe("<strong>Panel</strong>");

    const diagnostics = await service.invokeDiagnostics("example-plugin");
    expect(diagnostics.ok).toBe(true);
    expect(diagnostics.diagnostics).toEqual({ ok: true });

    const collector = await service.invokeCollector("example-plugin", "metrics.sample", {});
    expect(collector.ok).toBe(true);
    expect(collector.output).toMatchObject({ collectorId: "metrics.sample" });

    const afterInvoke = await service.get("example-plugin");
    expect(afterInvoke?.metrics?.invocations).toBeGreaterThanOrEqual(5);
    expect(afterInvoke?.metrics?.failures).toBe(0);
  });

  it("promotes stringified plugin result output for web panels", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "nordrelay-plugin-home-"));
    const fixture = await createStringifiedPanelPluginFixture();
    const service = new PluginService(home);
    await service.install({ source: fixture, enable: true, approvePermissions: true });

    const panel = await service.invokeWebPanel("stringified-panel-plugin", "panel", {});

    expect(panel.ok).toBe(true);
    expect(panel.html).toBe("<strong>Nested Panel</strong>");
    expect(panel.variables).toEqual({ panel: "ok" });
    expect(panel.diagnostics).toEqual({ nested: true });
  });

  it("blocks executable capabilities when plugins are disabled", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "nordrelay-plugin-home-"));
    const fixture = await createPluginFixture();
    const setup = new PluginService(home);
    await setup.install({ source: fixture, enable: true, approvePermissions: true });

    const disabled = new PluginService(home, { enabled: false });
    await expect(disabled.catalog()).rejects.toThrow("Plugins are disabled");
    await expect(disabled.invokeWorkflowAction("example-plugin", "example.echo", {})).rejects.toThrow("Plugins are disabled");
  });

  it("schedules collectors according to their declared interval", async () => {
    vi.useFakeTimers({ now: 0 });
    try {
      const invocations: number[] = [];
      const service = {
        isEnabled: () => true,
        catalog: async () => ({
          workflowActions: [],
          webPanels: [],
          commands: [],
          agentAdapters: [],
          chatAdapters: [],
          artifactHandlers: [],
          diagnostics: [],
          collectors: [
            { pluginId: "example-plugin", collectorId: "metrics.sample", intervalMs: 1000, runOnStart: true },
          ],
        }),
        invokeCollector: async () => {
          invocations.push(Date.now());
          return { ok: true };
        },
      } as unknown as PluginService;
      const scheduler = new PluginCollectorScheduler(service, { refreshMs: 1000, minIntervalMs: 1000 });

      await scheduler.tick(true);
      await Promise.resolve();
      expect(invocations).toEqual([0]);

      vi.setSystemTime(999);
      await scheduler.tick();
      await Promise.resolve();
      expect(invocations).toEqual([0]);

      vi.setSystemTime(1000);
      await scheduler.tick();
      await Promise.resolve();
      expect(invocations).toEqual([0, 1000]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("filters host context by approved plugin permissions", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "nordrelay-plugin-home-"));
    const fixture = await createPluginFixture();
    const service = new PluginService(home, {
      hostContext: () => ({
        runtime: { version: "test" },
        sessions: [{ id: "thread" }],
      }),
    });
    await service.install({ source: fixture, enable: true, approvePermissions: true });
    const plugin = await service.store.get("example-plugin");
    expect(plugin).toBeTruthy();
    plugin!.approvedPermissions = ["files.read", "runtime.read", "system.metrics.read"];
    await service.store.save(plugin!);

    const result = await service.invokeWorkflowAction("example-plugin", "example.echo", {});
    expect(result.ok).toBe(true);
    expect(result.output).toMatchObject({ context: { runtime: { version: "test" } } });
    expect((result.output as { context?: { sessions?: unknown[] } }).context?.sessions).toBeUndefined();
  });

  it("updates and rolls back local plugin versions", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "nordrelay-plugin-home-"));
    const fixture = await createPluginFixture();
    const service = new PluginService(home);
    await service.install({ source: fixture, enable: true, approvePermissions: true });
    const manifestPath = path.join(fixture, "nordrelay.plugin.json");
    const raw = JSON.parse(await readFile(manifestPath, "utf8"));
    await writeFile(manifestPath, JSON.stringify({ ...raw, version: "0.2.0" }, null, 2));

    const updated = await service.update("example-plugin");
    expect(updated.version).toBe("0.2.0");

    const rolledBack = await service.rollback("example-plugin", "0.1.0");
    expect(rolledBack.version).toBe("0.1.0");
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
