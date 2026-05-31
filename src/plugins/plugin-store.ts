import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  type InstalledPluginRecord,
  type PluginJobRecord,
  type PluginJobsPayload,
  type PluginLockPayload,
  type PluginLockRecord,
  type PluginRegistryPayload,
  type PublicPluginRecord,
} from "./plugin-types.js";

const PLUGIN_JOB_LIMIT = 200;
const PLUGIN_JOB_WRITE_LOCKS = new Map<string, Promise<unknown>>();

export class PluginStore {
  readonly root: string;
  readonly installedRoot: string;
  readonly logRoot: string;
  readonly dataRoot: string;
  readonly registryPath: string;
  readonly lockPath: string;
  readonly jobsPath: string;

  constructor(home: string) {
    this.root = path.join(home, "plugins");
    this.installedRoot = path.join(this.root, "installed");
    this.logRoot = path.join(this.root, "logs");
    this.dataRoot = path.join(this.root, "data");
    this.registryPath = path.join(this.root, "plugins.json");
    this.lockPath = path.join(this.root, "plugins.lock.json");
    this.jobsPath = path.join(this.root, "jobs.json");
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
    await this.removeLock(id);
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

  async readLocks(): Promise<PluginLockPayload> {
    await this.ensure();
    try {
      const raw = await readFile(this.lockPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<PluginLockPayload>;
      if (parsed.version !== 1 || !Array.isArray(parsed.plugins)) {
        return { version: 1, plugins: [] };
      }
      return { version: 1, plugins: parsed.plugins as PluginLockRecord[] };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: 1, plugins: [] };
      }
      throw error;
    }
  }

  async saveLock(record: PluginLockRecord): Promise<void> {
    const payload = await this.readLocks();
    const index = payload.plugins.findIndex((item) => item.id === record.id);
    if (index >= 0) {
      payload.plugins[index] = record;
    } else {
      payload.plugins.push(record);
    }
    await this.writeLocks(payload);
  }

  async removeLock(id: string): Promise<void> {
    const payload = await this.readLocks();
    const next = payload.plugins.filter((item) => item.id !== id);
    if (next.length !== payload.plugins.length) {
      await this.writeLocks({ ...payload, plugins: next });
    }
  }

  private async writeLocks(payload: PluginLockPayload): Promise<void> {
    await this.ensure();
    const tmp = path.join(this.root, `.plugins-lock-${process.pid}-${Date.now()}.json.tmp`);
    await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await rename(tmp, this.lockPath);
  }

  async readJobs(): Promise<PluginJobsPayload> {
    await this.ensure();
    try {
      const raw = await readFile(this.jobsPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<PluginJobsPayload>;
      if (parsed.version !== 1 || !Array.isArray(parsed.jobs)) {
        return { version: 1, jobs: [] };
      }
      return { version: 1, jobs: parsed.jobs as PluginJobRecord[] };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: 1, jobs: [] };
      }
      throw error;
    }
  }

  async writeJobs(payload: PluginJobsPayload): Promise<void> {
    await this.withJobWriteLock(async () => {
      await this.ensure();
      const tmp = path.join(this.root, `.plugins-jobs-${process.pid}-${Date.now()}.json.tmp`);
      const jobs = payload.jobs.slice(0, PLUGIN_JOB_LIMIT).map(cloneJob);
      await writeFile(tmp, `${JSON.stringify({ version: 1, jobs }, null, 2)}\n`, "utf8");
      await rename(tmp, this.jobsPath);
    });
  }

  async listJobs(pluginId?: string): Promise<PluginJobRecord[]> {
    const payload = await this.readJobs();
    const jobs = pluginId ? payload.jobs.filter((job) => job.pluginId === pluginId) : payload.jobs;
    return jobs.map(cloneJob);
  }

  async getJob(pluginId: string, jobId: string): Promise<PluginJobRecord | undefined> {
    const payload = await this.readJobs();
    const job = payload.jobs.find((item) => item.pluginId === pluginId && item.id === jobId);
    return job ? cloneJob(job) : undefined;
  }

  async upsertJob(job: PluginJobRecord): Promise<PluginJobRecord> {
    return this.withJobWriteLock(async () => {
      const payload = await this.readJobs();
      const next = cloneJob(job);
      const index = payload.jobs.findIndex((item) => item.pluginId === next.pluginId && item.id === next.id);
      if (index >= 0) {
        payload.jobs[index] = next;
      } else {
        payload.jobs.unshift(next);
      }
      payload.jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const tmp = path.join(this.root, `.plugins-jobs-${process.pid}-${Date.now()}.json.tmp`);
      await writeFile(tmp, `${JSON.stringify({ version: 1, jobs: payload.jobs.slice(0, PLUGIN_JOB_LIMIT) }, null, 2)}\n`, "utf8");
      await rename(tmp, this.jobsPath);
      return cloneJob(next);
    });
  }

  private async withJobWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    const key = this.jobsPath;
    const previous = PLUGIN_JOB_WRITE_LOCKS.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.catch(() => undefined).then(() => current);
    PLUGIN_JOB_WRITE_LOCKS.set(key, queued);
    try {
      await previous.catch(() => undefined);
      return await fn();
    } finally {
      release();
      if (PLUGIN_JOB_WRITE_LOCKS.get(key) === queued) {
        PLUGIN_JOB_WRITE_LOCKS.delete(key);
      }
    }
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

  async installedVersions(id: string): Promise<string[]> {
    try {
      const entries = await readdir(path.join(this.installedRoot, id), { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(compareVersionsDesc);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
}

function cloneJob(job: PluginJobRecord): PluginJobRecord {
  return JSON.parse(JSON.stringify(job)) as PluginJobRecord;
}

function compareVersionsDesc(left: string, right: string): number {
  return right.localeCompare(left, undefined, { numeric: true, sensitivity: "base" });
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
