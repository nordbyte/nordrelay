import { spawnSync } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AgentUpdateJobSnapshot } from "./agent-updates.js";
import type { AuditEvent } from "./audit-log.js";
import type { ConnectorConfig } from "./config.js";
import {
  getAgentUpdateLogPath,
  getConnectorHealth,
  getConnectorHome,
  getConnectorLogPath,
  getConnectorStatePath,
  getSourceRoot,
  getUpdateLogPath,
  getVersionChecks,
  readFormattedLogTail,
  resolveNpmSpawnCommand,
  type ConnectorHealth,
  type VersionChecks,
} from "./operations.js";
import { redactText } from "./redaction.js";
import type {
  WebAdapterHealthDto,
  WebDiagnosticsDto,
} from "./relay-runtime-types.js";
import { createZipBuffer, type ZipEntryInput } from "./zip-writer.js";

export interface SupportBundleOptions {
  config: ConnectorConfig;
  health?: ConnectorHealth;
  versionChecks?: VersionChecks;
  diagnostics?: WebDiagnosticsDto;
  adapterHealth?: WebAdapterHealthDto[];
  auditEvents?: AuditEvent[];
  agentUpdateJobs?: AgentUpdateJobSnapshot[];
  source?: "web" | "telegram" | "cli";
}

export interface SupportBundleResult {
  path: string;
  name: string;
  sizeBytes: number;
  createdAt: string;
  includedFiles: string[];
}

export async function createSupportBundle(options: SupportBundleOptions): Promise<SupportBundleResult> {
  const createdAt = new Date();
  const health = options.health ?? await getConnectorHealth(cliPathOptions(options.config));
  const versionChecks = options.versionChecks ?? await getVersionChecks(cliPathOptions(options.config));
  const entries: ZipEntryInput[] = [];

  addJson(entries, "manifest.json", {
    createdAt: createdAt.toISOString(),
    source: options.source ?? "web",
    package: "@nordbyte/nordrelay",
    includedFiles: [],
  });
  addJson(entries, "config/redacted-config.json", redactValue(options.config));
  addJson(entries, "config/relevant-env.json", redactValue(relevantEnvironment()));
  addJson(entries, "runtime/health.json", redactValue(health));
  addJson(entries, "runtime/version-checks.json", redactValue(versionChecks));
  addJson(entries, "runtime/state-backend.json", {
    stateBackend: options.config.stateBackend,
    stateFile: getConnectorStatePath(),
    connectorHome: getConnectorHome(),
    sourceRoot: getSourceRoot(),
    workspace: options.config.workspace,
    databasePath: health.databasePath,
  });
  addJson(entries, "runtime/agent-paths.json", agentPaths(health));
  addJson(entries, "system/info.json", systemInfo());
  if (options.diagnostics) {
    addJson(entries, "runtime/diagnostics.json", redactValue(options.diagnostics));
  }
  if (options.adapterHealth) {
    addJson(entries, "runtime/adapter-health.json", redactValue(options.adapterHealth));
  }
  if (options.auditEvents) {
    addJson(entries, "audit/recent-events.json", redactValue(options.auditEvents));
  }
  if (options.agentUpdateJobs) {
    addJson(entries, "updates/jobs.json", redactValue(options.agentUpdateJobs));
  }

  await addLog(entries, "logs/connector.log", getConnectorLogPath());
  await addLog(entries, "logs/nordrelay-update.log", getUpdateLogPath());
  await addLog(entries, "logs/agent-updates.log", getAgentUpdateLogPath());

  const includedFiles = entries.map((entry) => entry.name);
  entries[0] = {
    name: "manifest.json",
    data: jsonText({
      createdAt: createdAt.toISOString(),
      source: options.source ?? "web",
      package: "@nordbyte/nordrelay",
      includedFiles,
    }),
    date: createdAt,
  };

  const buffer = createZipBuffer(entries);
  const name = `nordrelay-diagnostics-${formatTimestamp(createdAt)}.zip`;
  const supportDir = path.join(getConnectorHome(), "support");
  await mkdir(supportDir, { recursive: true });
  const bundlePath = path.join(supportDir, name);
  await writeFile(bundlePath, buffer);
  const stats = await stat(bundlePath);
  return {
    path: bundlePath,
    name,
    sizeBytes: stats.size,
    createdAt: createdAt.toISOString(),
    includedFiles,
  };
}

function cliPathOptions(config: ConnectorConfig): { piCliPath?: string; hermesCliPath?: string; openClawCliPath?: string; claudeCodeCliPath?: string } {
  return {
    piCliPath: config.piCliPath,
    hermesCliPath: config.hermesCliPath,
    openClawCliPath: config.openClawCliPath,
    claudeCodeCliPath: config.claudeCodeCliPath,
  };
}

function addJson(entries: ZipEntryInput[], name: string, value: unknown): void {
  entries.push({ name, data: jsonText(value) });
}

async function addLog(entries: ZipEntryInput[], name: string, filePath: string): Promise<void> {
  const tail = await readFormattedLogTail(300, filePath);
  entries.push({
    name,
    data: [
      `File: ${tail.filePath}`,
      `Updated: ${tail.updatedAt ? tail.updatedAt.toISOString() : "-"}`,
      `Lines: ${tail.lineCount}/${tail.requestedLines}`,
      "",
      tail.plain || "(empty)",
    ].join("\n"),
  });
}

function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item));
  }
  if (!value || typeof value !== "object") {
    return typeof value === "string" ? redactText(value) : value;
  }
  const output: Record<string, unknown> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    output[key] = isSecretKey(key) ? "[REDACTED]" : redactValue(rawValue);
  }
  return output;
}

function isSecretKey(key: string): boolean {
  return /(token|secret|password|authorization|api[_-]?key|apikey|botToken|webhookSecret|gatewayPassword)/i.test(key);
}

function relevantEnvironment(): Record<string, string> {
  const prefixes = [
    "NORDRELAY_",
    "TELEGRAM_",
    "DISCORD_",
    "CODEX_",
    "PI_",
    "HERMES_",
    "OPENCLAW_",
    "CLAUDE_",
    "WORKSPACE_",
    "ARTIFACT_",
    "VOICE_",
    "FASTER_WHISPER_",
  ];
  const exact = new Set(["MAX_FILE_SIZE", "TOOL_VERBOSITY", "CONNECTOR_LOG_FORMAT", "NODE_ENV"]);
  return Object.fromEntries(
    Object.entries(process.env)
      .filter(([key, value]) => value !== undefined && (exact.has(key) || prefixes.some((prefix) => key.startsWith(prefix))))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, value ?? ""]),
  );
}

function agentPaths(health: ConnectorHealth): Record<string, { label: string; path: string | null; version: string }> {
  return {
    codex: { label: health.codexCli, path: health.codexCliPath, version: health.codexCliVersion },
    pi: { label: health.piCli, path: health.piCliPath, version: health.piCliVersion },
    hermes: { label: health.hermesCli, path: health.hermesCliPath, version: health.hermesCliVersion },
    openclaw: { label: health.openClawCli, path: health.openClawCliPath, version: health.openClawCliVersion },
    "claude-code": { label: health.claudeCodeCli, path: health.claudeCodeCliPath, version: health.claudeCodeCliVersion },
  };
}

function systemInfo(): Record<string, unknown> {
  const npm = resolveNpmSpawnCommand();
  return {
    os: {
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      type: os.type(),
      homedir: os.homedir(),
      tmpdir: os.tmpdir(),
      cpus: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
      freeMemoryBytes: os.freemem(),
      uptimeSeconds: os.uptime(),
    },
    node: {
      executable: process.execPath,
      version: process.version,
      versions: process.versions,
      argv: process.argv,
      cwd: process.cwd(),
      pid: process.pid,
      uptimeSeconds: process.uptime(),
    },
    npm: npm ? {
      command: npm.display,
      version: detectNpmVersion(npm),
    } : {
      command: null,
      version: null,
      error: "npm not found",
    },
  };
}

function detectNpmVersion(npm: NonNullable<ReturnType<typeof resolveNpmSpawnCommand>>): string | null {
  const args = [...npm.argsPrefix, "--version"];
  const result = spawnSync(npm.shell ? formatShellCommand(npm.command, args) : npm.command, npm.shell ? [] : args, {
    encoding: "utf8",
    shell: npm.shell,
    timeout: 3000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    return null;
  }
  return String(result.stdout || "").trim() || null;
}

function formatShellCommand(command: string, args: string[]): string {
  return [command, ...args].map(quoteWindowsCmdArg).join(" ");
}

function quoteWindowsCmdArg(value: string): string {
  if (value.length === 0) {
    return "\"\"";
  }
  if (!/[\s"&|<>()^%]/.test(value)) {
    return value;
  }
  return `"${value
    .replace(/%/g, "%%")
    .replace(/(\\*)"/g, '$1$1\\"')
    .replace(/(\\+)$/g, "$1$1")}"`;
}

function formatTimestamp(date: Date): string {
  return [
    date.getFullYear(),
    pad2(date.getMonth() + 1),
    pad2(date.getDate()),
    "-",
    pad2(date.getHours()),
    pad2(date.getMinutes()),
    pad2(date.getSeconds()),
  ].join("");
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}
