import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

import { PluginInstaller } from "./plugin-installer.js";
import { validatePluginManifest } from "./plugin-manifest.js";
import { PluginStore, toPublicPluginRecord } from "./plugin-store.js";
import {
  PLUGIN_RUNTIME_PERMISSIONS,
  PLUGIN_MANIFEST_FILE,
  type InstalledPluginRecord,
  type PluginCapabilityType,
  type PluginHostContext,
  type PluginInstallRequest,
  type PluginInvokeRequest,
  type PluginInvokeResult,
  type PluginRuntimePermission,
  type PluginScaffoldRequest,
  type PluginUpdateCheckResult,
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
    outputVariables?: Record<string, string>;
    timeoutMs?: number;
  }>;
  webPanels: Array<{
    pluginId: string;
    panelId: string;
    title: string;
    path?: string;
    permission?: string;
    inputSchema?: Record<string, unknown>;
    timeoutMs?: number;
  }>;
  commands: Array<{
    pluginId: string;
    name: string;
    title?: string;
    description?: string;
    permission?: string;
    inputSchema?: Record<string, unknown>;
    timeoutMs?: number;
  }>;
  agentAdapters: Array<{ pluginId: string; id: string; title: string; description?: string }>;
  chatAdapters: Array<{ pluginId: string; id: string; title: string; description?: string }>;
  artifactHandlers: Array<{
    pluginId: string;
    id: string;
    title: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
    timeoutMs?: number;
  }>;
  diagnostics: Array<{ pluginId: string; title: string }>;
}

export interface PluginServiceOptions {
  enabled?: boolean;
  version?: string;
  nodeName?: string;
  nodeId?: string;
  platform?: string;
  workspace?: string;
  hostContext?: () => Promise<PluginHostContext> | PluginHostContext;
  defaultTimeoutMs?: number;
  outputLimitBytes?: number;
}

interface ResolvedCapability {
  id?: string;
  timeoutMs?: number;
  outputVariables?: Record<string, string>;
}

const DEFAULT_PLUGIN_TIMEOUT_MS = 120_000;
const DEFAULT_OUTPUT_LIMIT_BYTES = 1024 * 1024;
const KNOWN_PLUGIN_PERMISSIONS = new Set<string>(PLUGIN_RUNTIME_PERMISSIONS);

export class PluginService {
  readonly store: PluginStore;
  private readonly installer: PluginInstaller;

  constructor(private readonly home: string, private readonly options: PluginServiceOptions = {}) {
    this.store = new PluginStore(home);
    this.installer = new PluginInstaller(this.store);
  }

  isEnabled(): boolean {
    return this.options.enabled !== false;
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
    this.assertEnabled();
    const plugin = await this.installer.install(request);
    await this.log(plugin.id, `Installed ${plugin.name} ${plugin.version} from ${plugin.source.value}`);
    return toPublicPluginRecord(plugin);
  }

  async validate(sourcePath: string): Promise<PluginValidationResult> {
    return this.installer.validatePath(sourcePath);
  }

  async scaffold(request: PluginScaffoldRequest): Promise<string> {
    this.assertEnabled();
    return this.installer.scaffold(request);
  }

  async enable(id: string): Promise<PublicPluginRecord> {
    this.assertEnabled();
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
    this.assertEnabled();
    const plugin = await this.requirePlugin(id);
    await this.log(id, `Removed ${plugin.name} ${plugin.version}.`);
    await this.store.remove(id);
  }

  async updateSettings(id: string, settings: Record<string, unknown>): Promise<PublicPluginRecord> {
    this.assertEnabled();
    const plugin = await this.requirePlugin(id);
    plugin.settings = mergeSettings(plugin, settings);
    plugin.updatedAt = new Date().toISOString();
    await this.store.save(plugin);
    await this.log(id, "Updated plugin settings.");
    return toPublicPluginRecord(plugin);
  }

  async updateManifest(id: string): Promise<PublicPluginRecord> {
    this.assertEnabled();
    const plugin = await this.requirePlugin(id);
    await applyManifestToPlugin(plugin, plugin.manifestPath);
    plugin.updatedAt = new Date().toISOString();
    await this.store.save(plugin);
    await this.log(id, "Reloaded plugin manifest.");
    return toPublicPluginRecord(plugin);
  }

  async catalog(): Promise<PluginCatalog> {
    this.assertEnabled();
    const plugins = (await this.store.list()).filter((plugin) => plugin.enabled);
    const catalog: PluginCatalog = {
      workflowActions: [],
      webPanels: [],
      commands: [],
      agentAdapters: [],
      chatAdapters: [],
      artifactHandlers: [],
      diagnostics: [],
    };
    for (const plugin of plugins) {
      for (const action of plugin.capabilities.workflowActions ?? []) {
        catalog.workflowActions.push({
          pluginId: plugin.id,
          actionId: action.id,
          title: action.title,
          description: action.description,
          inputSchema: action.inputSchema,
          outputVariables: action.outputVariables,
          timeoutMs: action.timeoutMs,
        });
      }
      for (const panel of plugin.capabilities.webPanels ?? []) {
        catalog.webPanels.push({
          pluginId: plugin.id,
          panelId: panel.id,
          title: panel.title,
          path: panel.path,
          permission: panel.permission,
          inputSchema: panel.inputSchema,
          timeoutMs: panel.timeoutMs,
        });
      }
      for (const command of plugin.capabilities.commands ?? []) {
        catalog.commands.push({
          pluginId: plugin.id,
          name: command.name,
          title: command.title,
          description: command.description,
          permission: command.permission,
          inputSchema: command.inputSchema,
          timeoutMs: command.timeoutMs,
        });
      }
      for (const adapter of plugin.capabilities.agentAdapters ?? []) {
        catalog.agentAdapters.push({ pluginId: plugin.id, id: adapter.id, title: adapter.title, description: adapter.description });
      }
      for (const adapter of plugin.capabilities.chatAdapters ?? []) {
        catalog.chatAdapters.push({ pluginId: plugin.id, id: adapter.id, title: adapter.title, description: adapter.description });
      }
      for (const handler of plugin.capabilities.artifactHandlers ?? []) {
        catalog.artifactHandlers.push({
          pluginId: plugin.id,
          id: handler.id,
          title: handler.title,
          description: handler.description,
          inputSchema: handler.inputSchema,
          timeoutMs: handler.timeoutMs,
        });
      }
      if (plugin.capabilities.diagnostics) {
        catalog.diagnostics.push({ pluginId: plugin.id, title: `${plugin.name} diagnostics` });
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

  async checkUpdate(id: string): Promise<PluginUpdateCheckResult> {
    this.assertEnabled();
    const plugin = await this.requirePlugin(id);
    const checkedAt = new Date().toISOString();
    try {
      if (plugin.source.type === "github") {
        const latestRevision = gitLsRemote(plugin.source.value, plugin.source.ref);
        return {
          id,
          sourceType: plugin.source.type,
          currentVersion: plugin.version,
          currentRevision: plugin.source.revision,
          latestRevision,
          updateAvailable: Boolean(latestRevision && latestRevision !== plugin.source.revision),
          checkedAt,
        };
      }
      const raw = await readFile(path.join(plugin.source.value, "nordrelay.plugin.json"), "utf8");
      const validation = validatePluginManifest(JSON.parse(raw) as unknown);
      const latestVersion = validation.manifest?.version;
      return {
        id,
        sourceType: plugin.source.type,
        currentVersion: plugin.version,
        latestVersion,
        updateAvailable: Boolean(latestVersion && latestVersion !== plugin.version),
        checkedAt,
      };
    } catch (error) {
      return {
        id,
        sourceType: plugin.source.type,
        currentVersion: plugin.version,
        updateAvailable: false,
        checkedAt,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async update(id: string): Promise<PublicPluginRecord> {
    this.assertEnabled();
    const plugin = await this.requirePlugin(id);
    const updated = await this.installer.install({
      source: plugin.source.value,
      ref: plugin.source.ref,
      enable: plugin.enabled,
      approvePermissions: false,
      force: true,
    });
    await this.log(id, `Updated plugin from ${plugin.version} to ${updated.version}.`);
    return toPublicPluginRecord(updated);
  }

  async rollback(id: string, version?: string): Promise<PublicPluginRecord> {
    this.assertEnabled();
    const plugin = await this.requirePlugin(id);
    const versions = await this.store.installedVersions(id);
    const targetVersion = version || versions.find((candidate) => candidate !== plugin.version);
    if (!targetVersion) {
      throw new Error(`No rollback target found for plugin ${id}.`);
    }
    const installPath = this.store.installVersionPath(id, targetVersion);
    const manifestPath = path.join(installPath, PLUGIN_MANIFEST_FILE);
    await applyManifestToPlugin(plugin, manifestPath);
    plugin.installPath = installPath;
    plugin.manifestPath = manifestPath;
    plugin.updatedAt = new Date().toISOString();
    await this.store.save(plugin);
    await this.log(id, `Rolled back plugin to ${targetVersion}.`);
    return toPublicPluginRecord(plugin);
  }

  async invokeWorkflowAction(
    pluginId: string,
    actionId: string,
    input: Record<string, unknown>,
  ): Promise<PluginInvokeResult> {
    return this.invokeCapability(pluginId, "workflow-action", actionId, input);
  }

  async invokeCommand(pluginId: string, command: string, input: Record<string, unknown>): Promise<PluginInvokeResult> {
    return this.invokeCapability(pluginId, "command", command, input);
  }

  async invokeWebPanel(pluginId: string, panelId: string, input: Record<string, unknown>): Promise<PluginInvokeResult> {
    return this.invokeCapability(pluginId, "web-panel", panelId, input);
  }

  async invokeArtifactHandler(pluginId: string, handlerId: string, input: Record<string, unknown>): Promise<PluginInvokeResult> {
    return this.invokeCapability(pluginId, "artifact-handler", handlerId, input);
  }

  async invokeDiagnostics(pluginId: string, input: Record<string, unknown> = {}): Promise<PluginInvokeResult> {
    return this.invokeCapability(pluginId, "diagnostics", "diagnostics", input);
  }

  private async invokeCapability(
    pluginId: string,
    type: PluginCapabilityType,
    capabilityId: string,
    input: Record<string, unknown>,
  ): Promise<PluginInvokeResult> {
    this.assertEnabled();
    const plugin = await this.requireEnabledPlugin(pluginId);
    if (!plugin.entry) {
      throw new Error(`Plugin ${pluginId} has no executable entry.`);
    }
    const capability = this.requireCapability(plugin, type, capabilityId);
    this.assertPluginPermissions(plugin);
    const entry = path.resolve(plugin.installPath, plugin.entry);
    if (!entry.startsWith(path.resolve(plugin.installPath))) {
      throw new Error("Plugin entry resolves outside the plugin directory.");
    }
    const dataDir = this.store.dataPath(pluginId);
    await mkdir(dataDir, { recursive: true });
    const permissions = approvedRuntimePermissions(plugin);
    const context = filterHostContext(await this.hostContext(), permissions);
    const request: PluginInvokeRequest = {
      protocolVersion: 1,
      type,
      pluginId,
      capabilityId,
      actionId: type === "workflow-action" ? capabilityId : undefined,
      command: type === "command" ? capabilityId : undefined,
      panelId: type === "web-panel" ? capabilityId : undefined,
      handlerId: type === "artifact-handler" ? capabilityId : undefined,
      input,
      settings: plugin.settings,
      dataDir,
      permissions,
      context,
    };
    await this.log(pluginId, `Invoking ${type} ${capabilityId}.`);
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    const result = await runPlugin(entry, request, {
      pluginId,
      dataDir,
      timeoutMs: capability.timeoutMs ?? this.options.defaultTimeoutMs ?? DEFAULT_PLUGIN_TIMEOUT_MS,
      outputLimitBytes: this.options.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES,
    });
    const durationMs = Date.now() - startedMs;
    const normalized = {
      ...normalizePluginResult(result),
      variables: mergeOutputVariables(result, capability.outputVariables),
      durationMs,
    };
    await this.recordInvocation(plugin, normalized, startedAt, new Date().toISOString(), durationMs);
    await this.log(pluginId, `${type} ${capabilityId} completed: ${normalized.ok ? "ok" : "failed"} (${durationMs}ms).`);
    return normalized;
  }

  private requireCapability(plugin: InstalledPluginRecord, type: PluginCapabilityType, capabilityId: string): ResolvedCapability {
    if (type === "workflow-action") {
      const action = (plugin.capabilities.workflowActions ?? []).find((item) => item.id === capabilityId);
      if (!action) throw new Error(`Plugin ${plugin.id} does not provide workflow action ${capabilityId}.`);
      return { id: action.id, timeoutMs: action.timeoutMs, outputVariables: action.outputVariables };
    }
    if (type === "command") {
      const command = (plugin.capabilities.commands ?? []).find((item) => item.name === capabilityId);
      if (!command) throw new Error(`Plugin ${plugin.id} does not provide command ${capabilityId}.`);
      return { id: command.name, timeoutMs: command.timeoutMs };
    }
    if (type === "web-panel") {
      const panel = (plugin.capabilities.webPanels ?? []).find((item) => item.id === capabilityId);
      if (!panel) throw new Error(`Plugin ${plugin.id} does not provide web panel ${capabilityId}.`);
      return { id: panel.id, timeoutMs: panel.timeoutMs };
    }
    if (type === "artifact-handler") {
      const handler = (plugin.capabilities.artifactHandlers ?? []).find((item) => item.id === capabilityId);
      if (!handler) throw new Error(`Plugin ${plugin.id} does not provide artifact handler ${capabilityId}.`);
      return { id: handler.id, timeoutMs: handler.timeoutMs };
    }
    if (!plugin.capabilities.diagnostics) {
      throw new Error(`Plugin ${plugin.id} does not provide diagnostics.`);
    }
    return { id: "diagnostics" };
  }

  private async hostContext(): Promise<PluginHostContext> {
    const base: PluginHostContext = {
      runtime: {
        version: this.options.version,
        nodeName: this.options.nodeName,
        nodeId: this.options.nodeId,
        platform: this.options.platform ?? process.platform,
        workspace: this.options.workspace,
      },
    };
    const extra = await this.options.hostContext?.();
    return { ...base, ...(extra ?? {}) };
  }

  private assertEnabled(): void {
    if (this.options.enabled === false) {
      throw new Error("Plugins are disabled by NORDRELAY_PLUGINS_ENABLED=false.");
    }
  }

  private assertPluginPermissions(plugin: InstalledPluginRecord): void {
    for (const permission of plugin.permissions) {
      if (!KNOWN_PLUGIN_PERMISSIONS.has(permission)) {
        throw new Error(`Plugin ${plugin.id} declares unknown permission ${permission}.`);
      }
      if (!plugin.approvedPermissions.includes(permission)) {
        throw new Error(`Plugin ${plugin.id} permission ${permission} is not approved.`);
      }
    }
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

  private async recordInvocation(
    plugin: InstalledPluginRecord,
    result: PluginInvokeResult,
    startedAt: string,
    finishedAt: string,
    durationMs: number,
  ): Promise<void> {
    const latest = await this.requirePlugin(plugin.id);
    const previous = latest.metrics ?? { invocations: 0, failures: 0, totalDurationMs: 0 };
    latest.metrics = {
      invocations: previous.invocations + 1,
      failures: previous.failures + (result.ok ? 0 : 1),
      totalDurationMs: previous.totalDurationMs + durationMs,
      lastStartedAt: startedAt,
      lastFinishedAt: finishedAt,
      lastDurationMs: durationMs,
      lastStatus: result.ok ? "ok" : "failed",
      lastError: result.ok ? undefined : result.stderr ?? stringOutput(result.output) ?? "Plugin failed.",
    };
    latest.status = result.ok ? latest.status : "error";
    latest.lastError = result.ok ? undefined : latest.metrics.lastError;
    latest.updatedAt = finishedAt;
    await this.store.save(latest);
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

async function applyManifestToPlugin(plugin: InstalledPluginRecord, manifestPath: string): Promise<void> {
  const raw = await readFile(manifestPath, "utf8");
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
  plugin.approvedPermissions = (plugin.approvedPermissions ?? []).filter((permission) => plugin.permissions.includes(permission));
  plugin.capabilities = manifest.capabilities ?? {};
  plugin.settingsSchema = manifest.settings ?? [];
  plugin.settings = mergeSettings(plugin, plugin.settings);
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

function runPlugin(
  entry: string,
  payload: PluginInvokeRequest,
  options: { pluginId: string; dataDir: string; timeoutMs: number; outputLimitBytes: number },
): Promise<PluginInvokeResult> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    const child = spawn(process.execPath, [entry], {
      cwd: options.dataDir,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      env: safePluginEnv(options.pluginId, options.dataDir),
    });
    const finish = (result: PluginInvokeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({
        ...result,
        stdout,
        stderr: result.stderr ?? stderr,
      });
    };
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      const killTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
      killTimer.unref?.();
      finish({ ok: false, stderr: `${stderr}\nPlugin timed out.`.trim(), timedOut: true, exitCode: null });
    }, Math.max(100, options.timeoutMs));
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout = appendLimited(stdout, chunk, options.outputLimitBytes);
      if (stdout.length >= options.outputLimitBytes) {
        child.kill("SIGTERM");
        finish({ ok: false, stderr: "Plugin stdout exceeded output limit.", exitCode: null });
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendLimited(stderr, chunk, options.outputLimitBytes);
      if (stderr.length >= options.outputLimitBytes) {
        child.kill("SIGTERM");
        finish({ ok: false, stderr: "Plugin stderr exceeded output limit.", exitCode: null });
      }
    });
    child.on("error", (error) => {
      finish({ ok: false, stderr: error.message, exitCode: null });
    });
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        finish({ ok: false, stderr: stderr || `Plugin exited with code ${code}.`, exitCode: code });
        return;
      }
      finish(parsePluginOutput(stdout, stderr, code));
    });
    child.stdin.end(`${JSON.stringify(payload)}\n`);
  });
}

function parsePluginOutput(stdout: string, stderr: string, exitCode: number | null): PluginInvokeResult {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return { ok: true, stdout, stderr, exitCode };
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "ok" in parsed) {
      return { ...(parsed as PluginInvokeResult), stdout, stderr, exitCode };
    }
    return { ok: true, output: parsed, stdout, stderr, exitCode };
  } catch {
    return { ok: true, output: trimmed, stdout, stderr, exitCode };
  }
}

function safePluginEnv(pluginId: string, dataDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    NORDRELAY_PLUGIN: "1",
    NORDRELAY_PLUGIN_ID: pluginId,
    NORDRELAY_PLUGIN_DATA_DIR: dataDir,
    HOME: dataDir,
    USERPROFILE: dataDir,
    TMPDIR: dataDir,
    TEMP: dataDir,
    TMP: dataDir,
    NODE_ENV: process.env.NODE_ENV ?? "production",
  };
  if (process.env.PATH) env.PATH = process.env.PATH;
  if (process.platform === "win32") {
    for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) {
      if (process.env[key]) env[key] = process.env[key];
    }
  }
  return env;
}

function appendLimited(current: string, chunk: string, limit: number): string {
  const next = current + chunk;
  return next.length > limit ? next.slice(0, limit) : next;
}

function approvedRuntimePermissions(plugin: InstalledPluginRecord): PluginRuntimePermission[] {
  return plugin.permissions
    .filter((permission) => plugin.approvedPermissions.includes(permission))
    .filter((permission): permission is PluginRuntimePermission => KNOWN_PLUGIN_PERMISSIONS.has(permission));
}

function filterHostContext(context: PluginHostContext, permissions: PluginRuntimePermission[]): PluginHostContext {
  const allowed = new Set(permissions);
  const filtered: PluginHostContext = {};
  if (allowed.has("runtime.read")) filtered.runtime = context.runtime;
  if (allowed.has("sessions.read")) {
    filtered.session = context.session;
    filtered.sessions = context.sessions;
  }
  if (allowed.has("activity.read")) filtered.activity = context.activity;
  if (allowed.has("artifacts.read") || allowed.has("files.read")) filtered.artifacts = context.artifacts;
  if (allowed.has("workflows.read")) filtered.workflows = context.workflows;
  if (allowed.has("peers.read")) filtered.peers = context.peers;
  if (allowed.has("diagnostics.read")) filtered.diagnostics = context.diagnostics;
  if (allowed.has("settings.read")) filtered.settings = context.settings;
  return filtered;
}

function normalizePluginResult(result: PluginInvokeResult): PluginInvokeResult {
  if (result.output && typeof result.output === "object" && !Array.isArray(result.output)) {
    const output = result.output as Record<string, unknown>;
    return {
      ...result,
      variables: normalizeVariables(result.variables ?? recordField(output.variables)),
      html: stringField(result.html ?? output.html),
      text: stringField(result.text ?? output.text),
      artifacts: Array.isArray(result.artifacts) ? result.artifacts : Array.isArray(output.artifacts) ? output.artifacts : undefined,
      diagnostics: result.diagnostics ?? output.diagnostics,
    };
  }
  return { ...result, variables: normalizeVariables(result.variables) };
}

function mergeOutputVariables(result: PluginInvokeResult, mapping?: Record<string, string>): Record<string, string> | undefined {
  const existing = normalizeVariables(result.variables);
  if (!mapping || Object.keys(mapping).length === 0) {
    return existing;
  }
  const output = result.output;
  const mapped: Record<string, string> = { ...(existing ?? {}) };
  for (const [variable, pathExpression] of Object.entries(mapping)) {
    const value = valueAtPath(output, pathExpression);
    if (value !== undefined) mapped[variable] = String(value);
  }
  return Object.keys(mapped).length ? mapped : undefined;
}

function recordField(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function normalizeVariables(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const variables: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    variables[key] = String(item ?? "");
  }
  return Object.keys(variables).length ? variables : undefined;
}

function valueAtPath(value: unknown, expression: string): unknown {
  const parts = expression.split(".").map((part) => part.trim()).filter(Boolean);
  let current: unknown = value;
  for (const part of parts) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringOutput(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value === undefined) return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function gitLsRemote(repoUrl: string, ref?: string): string | undefined {
  const args = ["ls-remote", repoUrl, ref ?? "HEAD"];
  const result = spawnSync("git", args, { encoding: "utf8", stdio: "pipe" });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || result.error?.message || "git ls-remote failed");
  }
  const line = result.stdout.split(/\r?\n/).find(Boolean);
  return line?.split(/\s+/)[0];
}
