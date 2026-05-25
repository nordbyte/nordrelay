import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import { PluginInstaller } from "./plugin-installer.js";
import { validatePluginManifest } from "./plugin-manifest.js";
import { PluginStore, toPublicPluginRecord } from "./plugin-store.js";
import {
  type InstalledPluginRecord,
  type PluginInstallRequest,
  type PluginScaffoldRequest,
  type PluginValidationResult,
  type PublicPluginRecord,
} from "./plugin-types.js";

export interface PluginCatalog {
  workflowActions: Array<{
    pluginId: string;
    actionId: string;
    title: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
  }>;
  webPanels: Array<{
    pluginId: string;
    panelId: string;
    title: string;
    path?: string;
    permission?: string;
  }>;
  commands: Array<{
    pluginId: string;
    name: string;
    description?: string;
    permission?: string;
  }>;
  agentAdapters: Array<{ pluginId: string; id: string; title: string; description?: string }>;
  chatAdapters: Array<{ pluginId: string; id: string; title: string; description?: string }>;
  artifactHandlers: Array<{ pluginId: string; id: string; title: string; description?: string }>;
}

export interface PluginInvokeResult {
  ok: boolean;
  output?: unknown;
  stdout?: string;
  stderr?: string;
}

export class PluginService {
  readonly store: PluginStore;
  private readonly installer: PluginInstaller;

  constructor(private readonly home: string) {
    this.store = new PluginStore(home);
    this.installer = new PluginInstaller(this.store);
  }

  async list(): Promise<PublicPluginRecord[]> {
    const plugins = await this.store.list();
    return plugins.map(toPublicPluginRecord);
  }

  async get(id: string): Promise<PublicPluginRecord | undefined> {
    const plugin = await this.store.get(id);
    return plugin ? toPublicPluginRecord(plugin) : undefined;
  }

  async install(request: PluginInstallRequest): Promise<PublicPluginRecord> {
    const plugin = await this.installer.install(request);
    await this.log(plugin.id, `Installed ${plugin.name} ${plugin.version} from ${plugin.source.value}`);
    return toPublicPluginRecord(plugin);
  }

  async validate(sourcePath: string): Promise<PluginValidationResult> {
    return this.installer.validatePath(sourcePath);
  }

  async scaffold(request: PluginScaffoldRequest): Promise<string> {
    return this.installer.scaffold(request);
  }

  async enable(id: string): Promise<PublicPluginRecord> {
    const plugin = await this.requirePlugin(id);
    plugin.enabled = true;
    plugin.status = "enabled";
    plugin.lastError = undefined;
    plugin.approvedPermissions = Array.from(new Set([...(plugin.approvedPermissions ?? []), ...plugin.permissions])).sort();
    plugin.updatedAt = new Date().toISOString();
    await this.store.save(plugin);
    await this.log(plugin.id, "Enabled plugin.");
    return toPublicPluginRecord(plugin);
  }

  async disable(id: string): Promise<PublicPluginRecord> {
    const plugin = await this.requirePlugin(id);
    plugin.enabled = false;
    plugin.status = "disabled";
    plugin.updatedAt = new Date().toISOString();
    await this.store.save(plugin);
    await this.log(plugin.id, "Disabled plugin.");
    return toPublicPluginRecord(plugin);
  }

  async remove(id: string): Promise<void> {
    const plugin = await this.requirePlugin(id);
    await this.log(id, `Removed ${plugin.name} ${plugin.version}.`);
    await this.store.remove(id);
  }

  async updateSettings(id: string, settings: Record<string, unknown>): Promise<PublicPluginRecord> {
    const plugin = await this.requirePlugin(id);
    plugin.settings = mergeSettings(plugin, settings);
    plugin.updatedAt = new Date().toISOString();
    await this.store.save(plugin);
    await this.log(id, "Updated plugin settings.");
    return toPublicPluginRecord(plugin);
  }

  async updateManifest(id: string): Promise<PublicPluginRecord> {
    const plugin = await this.requirePlugin(id);
    const raw = await readFile(plugin.manifestPath, "utf8");
    const validation = validatePluginManifest(JSON.parse(raw) as unknown);
    if (!validation.ok || !validation.manifest) {
      throw new Error(validation.issues.map((issue) => issue.message).join("; ") || "Invalid plugin manifest.");
    }
    const manifest = validation.manifest;
    plugin.name = manifest.name;
    plugin.version = manifest.version;
    plugin.description = manifest.description;
    plugin.author = manifest.author;
    plugin.homepage = manifest.homepage;
    plugin.repository = manifest.repository;
    plugin.license = manifest.license;
    plugin.nordrelay = manifest.nordrelay;
    plugin.entry = manifest.entry;
    plugin.permissions = manifest.permissions ?? [];
    plugin.capabilities = manifest.capabilities ?? {};
    plugin.settingsSchema = manifest.settings ?? [];
    plugin.settings = mergeSettings(plugin, plugin.settings);
    plugin.updatedAt = new Date().toISOString();
    await this.store.save(plugin);
    await this.log(id, "Reloaded plugin manifest.");
    return toPublicPluginRecord(plugin);
  }

  async catalog(): Promise<PluginCatalog> {
    const plugins = (await this.store.list()).filter((plugin) => plugin.enabled);
    const catalog: PluginCatalog = {
      workflowActions: [],
      webPanels: [],
      commands: [],
      agentAdapters: [],
      chatAdapters: [],
      artifactHandlers: [],
    };
    for (const plugin of plugins) {
      for (const action of plugin.capabilities.workflowActions ?? []) {
        catalog.workflowActions.push({
          pluginId: plugin.id,
          actionId: action.id,
          title: action.title,
          description: action.description,
          inputSchema: action.inputSchema,
        });
      }
      for (const panel of plugin.capabilities.webPanels ?? []) {
        catalog.webPanels.push({
          pluginId: plugin.id,
          panelId: panel.id,
          title: panel.title,
          path: panel.path,
          permission: panel.permission,
        });
      }
      for (const command of plugin.capabilities.commands ?? []) {
        catalog.commands.push({
          pluginId: plugin.id,
          name: command.name,
          description: command.description,
          permission: command.permission,
        });
      }
      for (const adapter of plugin.capabilities.agentAdapters ?? []) {
        catalog.agentAdapters.push({
          pluginId: plugin.id,
          id: adapter.id,
          title: adapter.title,
          description: adapter.description,
        });
      }
      for (const adapter of plugin.capabilities.chatAdapters ?? []) {
        catalog.chatAdapters.push({
          pluginId: plugin.id,
          id: adapter.id,
          title: adapter.title,
          description: adapter.description,
        });
      }
      for (const handler of plugin.capabilities.artifactHandlers ?? []) {
        catalog.artifactHandlers.push({
          pluginId: plugin.id,
          id: handler.id,
          title: handler.title,
          description: handler.description,
        });
      }
    }
    return catalog;
  }

  async readLog(id: string, maxBytes = 20000): Promise<string> {
    await this.requirePlugin(id);
    const logPath = this.store.logPath(id);
    try {
      const raw = await readFile(logPath, "utf8");
      return raw.length > maxBytes ? raw.slice(raw.length - maxBytes) : raw;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return "";
      }
      throw error;
    }
  }

  async invokeWorkflowAction(
    pluginId: string,
    actionId: string,
    input: Record<string, unknown>,
  ): Promise<PluginInvokeResult> {
    const plugin = await this.requireEnabledPlugin(pluginId);
    if (!plugin.entry) {
      throw new Error(`Plugin ${pluginId} has no executable entry.`);
    }
    const action = (plugin.capabilities.workflowActions ?? []).find((item) => item.id === actionId);
    if (!action) {
      throw new Error(`Plugin ${pluginId} does not provide workflow action ${actionId}.`);
    }
    for (const permission of plugin.permissions) {
      if (!plugin.approvedPermissions.includes(permission)) {
        throw new Error(`Plugin ${pluginId} permission ${permission} is not approved.`);
      }
    }

    const entry = path.resolve(plugin.installPath, plugin.entry);
    if (!entry.startsWith(path.resolve(plugin.installPath))) {
      throw new Error("Plugin entry resolves outside the plugin directory.");
    }
    await this.log(pluginId, `Invoking workflow action ${actionId}.`);
    const result = await runPlugin(entry, {
      type: "workflow-action",
      pluginId,
      actionId,
      input,
      settings: plugin.settings,
      dataDir: this.store.dataPath(pluginId),
    });
    await this.log(pluginId, `Workflow action ${actionId} completed: ${result.ok ? "ok" : "failed"}.`);
    return result;
  }

  private async requirePlugin(id: string): Promise<InstalledPluginRecord> {
    const plugin = await this.store.get(id);
    if (!plugin) {
      throw new Error(`Plugin not found: ${id}`);
    }
    return plugin;
  }

  private async requireEnabledPlugin(id: string): Promise<InstalledPluginRecord> {
    const plugin = await this.requirePlugin(id);
    if (!plugin.enabled) {
      throw new Error(`Plugin is disabled: ${id}`);
    }
    return plugin;
  }

  private async log(id: string, message: string): Promise<void> {
    await this.store.ensure();
    const line = `${new Date().toISOString()} ${message}\n`;
    await appendFile(this.store.logPath(id), line, "utf8");
  }
}

function mergeSettings(plugin: InstalledPluginRecord, input: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const setting of plugin.settingsSchema) {
    const incoming = input[setting.key];
    if (setting.type === "secret" && incoming === "") {
      next[setting.key] = plugin.settings[setting.key] ?? "";
      continue;
    }
    if (incoming === undefined) {
      next[setting.key] = plugin.settings[setting.key] ?? setting.default ?? (setting.type === "boolean" ? false : "");
      continue;
    }
    next[setting.key] = coerceSettingValue(setting.type, incoming);
  }
  return next;
}

function coerceSettingValue(type: string, value: unknown): unknown {
  if (type === "boolean") {
    return value === true || value === "true" || value === "1" || value === 1;
  }
  if (type === "number") {
    const parsed = typeof value === "number" ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return typeof value === "string" ? value : String(value ?? "");
}

function runPlugin(entry: string, payload: Record<string, unknown>): Promise<PluginInvokeResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entry], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        NORDRELAY_PLUGIN: "1",
      },
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({ ok: false, stdout, stderr: `${stderr}\nPlugin timed out.`.trim() });
    }, 120000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({ ok: false, stdout, stderr: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        resolve({ ok: false, stdout, stderr: stderr || `Plugin exited with code ${code}.` });
        return;
      }
      const trimmed = stdout.trim();
      if (!trimmed) {
        resolve({ ok: true, stdout, stderr });
        return;
      }
      try {
        resolve({ ok: true, output: JSON.parse(trimmed) as unknown, stdout, stderr });
      } catch {
        resolve({ ok: true, output: trimmed, stdout, stderr });
      }
    });
    child.stdin.end(`${JSON.stringify(payload)}\n`);
  });
}
