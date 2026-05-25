import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  type InstalledPluginRecord,
  type PluginRegistryPayload,
  type PublicPluginRecord,
} from "./plugin-types.js";

export class PluginStore {
  readonly root: string;
  readonly installedRoot: string;
  readonly logRoot: string;
  readonly dataRoot: string;
  readonly registryPath: string;

  constructor(home: string) {
    this.root = path.join(home, "plugins");
    this.installedRoot = path.join(this.root, "installed");
    this.logRoot = path.join(this.root, "logs");
    this.dataRoot = path.join(this.root, "data");
    this.registryPath = path.join(this.root, "plugins.json");
  }

  async ensure(): Promise<void> {
    await mkdir(this.installedRoot, { recursive: true });
    await mkdir(this.logRoot, { recursive: true });
    await mkdir(this.dataRoot, { recursive: true });
  }

  async list(): Promise<InstalledPluginRecord[]> {
    const payload = await this.read();
    return payload.plugins.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }

  async get(id: string): Promise<InstalledPluginRecord | undefined> {
    const payload = await this.read();
    return payload.plugins.find((plugin) => plugin.id === id);
  }

  async save(plugin: InstalledPluginRecord): Promise<void> {
    const payload = await this.read();
    const index = payload.plugins.findIndex((item) => item.id === plugin.id);
    if (index >= 0) {
      payload.plugins[index] = plugin;
    } else {
      payload.plugins.push(plugin);
    }
    await this.write(payload);
  }

  async remove(id: string): Promise<boolean> {
    const payload = await this.read();
    const plugin = payload.plugins.find((item) => item.id === id);
    const next = payload.plugins.filter((item) => item.id !== id);
    if (next.length === payload.plugins.length) {
      return false;
    }
    await this.write({ ...payload, plugins: next });
    if (plugin?.installPath) {
      await rm(plugin.installPath, { recursive: true, force: true });
    }
    return true;
  }

  async read(): Promise<PluginRegistryPayload> {
    await this.ensure();
    try {
      const raw = await readFile(this.registryPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<PluginRegistryPayload>;
      if (parsed.version !== 1 || !Array.isArray(parsed.plugins)) {
        return { version: 1, plugins: [] };
      }
      return { version: 1, plugins: parsed.plugins as InstalledPluginRecord[] };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: 1, plugins: [] };
      }
      throw error;
    }
  }

  async write(payload: PluginRegistryPayload): Promise<void> {
    await this.ensure();
    const tmp = path.join(this.root, `.plugins-${process.pid}-${Date.now()}.json.tmp`);
    await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await rename(tmp, this.registryPath);
  }

  installVersionPath(id: string, version: string): string {
    return path.join(this.installedRoot, id, version);
  }

  logPath(id: string): string {
    return path.join(this.logRoot, `${id}.log`);
  }

  dataPath(id: string): string {
    return path.join(this.dataRoot, id);
  }
}

export function toPublicPluginRecord(plugin: InstalledPluginRecord): PublicPluginRecord {
  const settings: Record<string, unknown> = {};
  const settingsSummary: PublicPluginRecord["settingsSummary"] = {};
  for (const setting of plugin.settingsSchema) {
    const value = plugin.settings[setting.key];
    if (setting.type === "secret") {
      settings[setting.key] = "";
      settingsSummary[setting.key] = value ? "configured" : "empty";
    } else {
      settings[setting.key] = value;
      settingsSummary[setting.key] = value ?? "empty";
    }
  }
  return {
    ...plugin,
    settings,
    settingsSummary,
  };
}

export function defaultPluginHome(): string {
  return path.join(os.homedir(), ".nordrelay");
}
