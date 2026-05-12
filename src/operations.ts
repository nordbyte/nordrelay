import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describeCodexCli, resolveCodexCli } from "./codex-cli.js";
import { findLatestDatabase } from "./codex-state.js";
import { describePiCli, resolvePiCli } from "./pi-cli.js";

export interface ConnectorRuntimeState {
  status?: string;
  pid?: number;
  appPid?: number;
  workspace?: string;
  sessionMode?: string;
  authenticated?: boolean;
  authMethod?: string;
  codexCli?: string;
  piCli?: string;
  error?: string;
  updatedAt?: string;
}

export interface ConnectorHealth {
  version: string;
  state: ConnectorRuntimeState;
  pidRunning: boolean;
  appPidRunning: boolean;
  codexCli: string;
  piCli: string;
  stateFile: string;
  logFile: string;
  databasePath: string | null;
  uptimeSeconds: number;
}

const APP_NAME = "nordrelay";
const DEFAULT_HOME = path.join(os.homedir(), ".codex", "nordrelay");
const SECRET_RE = /(bot|token|api[_-]?key|authorization|bearer|password|secret)(["'=: ]+)([^\s"',]+)/gi;

export function getConnectorHome(): string {
  return process.env.NORDRELAY_HOME || DEFAULT_HOME;
}

export function getConnectorStatePath(): string {
  return process.env.NORDRELAY_STATE_FILE || path.join(getConnectorHome(), "state.json");
}

export function getConnectorLogPath(): string {
  return path.join(getConnectorHome(), "nordrelay.log");
}

export function getUpdateLogPath(): string {
  return path.join(getConnectorHome(), "update.log");
}

export async function readConnectorState(): Promise<ConnectorRuntimeState> {
  try {
    return JSON.parse(await readFile(getConnectorStatePath(), "utf8")) as ConnectorRuntimeState;
  } catch {
    return {};
  }
}

export async function readLogTail(lines = 80, filePath = getConnectorLogPath()): Promise<string> {
  const boundedLines = Math.min(Math.max(lines, 1), 300);
  try {
    const contents = await readFile(filePath, "utf8");
    return redactSecrets(contents.split(/\r?\n/).slice(-boundedLines).join("\n").trim());
  } catch (error) {
    return `Cannot read log: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function getPackageVersion(): Promise<string> {
  try {
    const pkg = JSON.parse(await readFile(path.join(getSourceRoot(), "package.json"), "utf8")) as {
      version?: unknown;
    };
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

export async function getConnectorHealth(): Promise<ConnectorHealth> {
  const state = await readConnectorState();
  const version = await getPackageVersion();
  const pidRunning = isProcessRunning(state.pid);
  const appPidRunning = isProcessRunning(state.appPid);

  return {
    version,
    state,
    pidRunning,
    appPidRunning,
    codexCli: describeCodexCli(resolveCodexCli()),
    piCli: describePiCli(resolvePiCli()),
    stateFile: getConnectorStatePath(),
    logFile: getConnectorLogPath(),
    databasePath: findLatestDatabase(),
    uptimeSeconds: Math.max(0, Math.round(process.uptime())),
  };
}

export function spawnConnectorRestart(): void {
  const script = getWrapperScriptPath();
  const child = spawn(process.execPath, [script, "restart", "--keep-pending-updates"], {
    cwd: getSourceRoot(),
    detached: true,
    env: process.env,
    stdio: "ignore",
  });
  child.unref();
}

export function spawnSelfUpdate(): string {
  const sourceRoot = getSourceRoot();
  const script = getWrapperScriptPath();
  const updateLog = getUpdateLogPath();
  const logFd = openSync(updateLog, "a");
  const command = [
    "set -e",
    `printf '\\n[%s] Starting connector self-update\\n' "$(date -Is)"`,
    "git pull --ff-only origin main",
    "npm install",
    "npm run check",
    "npm test",
    "npm run build",
    `printf '[%s] Checks passed; restarting connector\\n' "$(date -Is)"`,
    `${shellQuote(process.execPath)} ${shellQuote(script)} restart --keep-pending-updates`,
  ].join(" && ");

  const child = spawn("sh", ["-lc", command], {
    cwd: sourceRoot,
    detached: true,
    env: process.env,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  closeSync(logFd);
  return updateLog;
}

export function getSourceRoot(): string {
  return process.env.NORDRELAY_SOURCE_ROOT || process.cwd();
}

function getWrapperScriptPath(): string {
  const sourceRoot = getSourceRoot();
  const script = path.join(sourceRoot, "plugins", APP_NAME, "scripts", `${APP_NAME}.mjs`);
  if (existsSync(script)) {
    return script;
  }
  return path.join(process.cwd(), "plugins", APP_NAME, "scripts", `${APP_NAME}.mjs`);
}

function isProcessRunning(pid: unknown): boolean {
  if (!Number.isInteger(pid) || (pid as number) <= 0) {
    return false;
  }

  try {
    process.kill(pid as number, 0);
    return true;
  } catch {
    return false;
  }
}

function redactSecrets(text: string): string {
  return text.replace(SECRET_RE, "$1$2[redacted]");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
