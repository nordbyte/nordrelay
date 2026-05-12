import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
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

export type SelfUpdateMethod = "git" | "npm";

export interface SelfUpdateResult {
  logPath: string;
  method: SelfUpdateMethod;
  sourceRoot: string;
  summary: string;
}

export interface FormattedLogTail {
  filePath: string;
  requestedLines: number;
  lineCount: number;
  updatedAt: Date | null;
  plain: string;
}

const APP_NAME = "nordrelay";
const PACKAGE_NAME = "@nordbyte/nordrelay";
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

export async function readFormattedLogTail(lines = 80, filePath = getConnectorLogPath()): Promise<FormattedLogTail> {
  const boundedLines = Math.min(Math.max(lines, 1), 300);
  try {
    const [contents, stats] = await Promise.all([readFile(filePath, "utf8"), stat(filePath)]);
    const rawLines = contents.split(/\r?\n/).filter((line) => line.trim().length > 0).slice(-boundedLines);
    const formatted = rawLines.map(formatLogLine).join("\n");
    return {
      filePath,
      requestedLines: boundedLines,
      lineCount: rawLines.length,
      updatedAt: stats.mtime,
      plain: redactSecrets(formatted),
    };
  } catch (error) {
    return {
      filePath,
      requestedLines: boundedLines,
      lineCount: 0,
      updatedAt: null,
      plain: `Cannot read log: ${error instanceof Error ? error.message : String(error)}`,
    };
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

export function spawnSelfUpdate(): SelfUpdateResult {
  const sourceRoot = getSourceRoot();
  const script = getWrapperScriptPath();
  const updateLog = getUpdateLogPath();
  const method = detectSelfUpdateMethod(sourceRoot);
  const commands = method === "npm"
    ? buildNpmSelfUpdateCommands()
    : buildGitSelfUpdateCommands(script);
  const logFd = openSync(updateLog, "a");
  const command = [
    "set -e",
    `printf '\\n[%s] Starting ${method} connector self-update\\n' "$(date -Is)"`,
    ...commands,
  ].join(" && ");

  const child = spawn("sh", ["-lc", command], {
    cwd: sourceRoot,
    detached: true,
    env: process.env,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  closeSync(logFd);
  return {
    logPath: updateLog,
    method,
    sourceRoot,
    summary: method === "npm"
      ? `Install latest ${PACKAGE_NAME} with npm, verify the CLI, and restart.`
      : "Pull origin/main, install dependencies, run check, tests, build, and restart.",
  };
}

export function getSourceRoot(): string {
  return process.env.NORDRELAY_SOURCE_ROOT || process.cwd();
}

export function detectSelfUpdateMethod(sourceRoot = getSourceRoot()): SelfUpdateMethod {
  const override = process.env.NORDRELAY_UPDATE_METHOD?.trim().toLowerCase();
  if (override === "npm" || override === "git") {
    return override;
  }
  return existsSync(path.join(sourceRoot, ".git")) ? "git" : "npm";
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

function buildGitSelfUpdateCommands(script: string): string[] {
  return [
    "git pull --ff-only origin main",
    "npm install",
    "npm run check",
    "npm test",
    "npm run build",
    `printf '[%s] Checks passed; restarting connector\\n' "$(date -Is)"`,
    `${shellQuote(process.execPath)} ${shellQuote(script)} restart --keep-pending-updates`,
  ];
}

function buildNpmSelfUpdateCommands(): string[] {
  return [
    `${resolveNpmCommand()} install -g ${PACKAGE_NAME}@latest`,
    "nordrelay version",
    `printf '[%s] npm update finished; restarting connector\\n' "$(date -Is)"`,
    "nordrelay restart --keep-pending-updates",
  ];
}

function resolveNpmCommand(): string {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath && existsSync(npmExecPath)) {
    return `${shellQuote(process.execPath)} ${shellQuote(npmExecPath)}`;
  }
  return "npm";
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function formatLogLine(line: string): string {
  const trimmed = line.trim();
  if (!trimmed) {
    return "";
  }

  const parsedJson = parseJsonLogLine(trimmed);
  if (parsedJson) {
    return parsedJson;
  }

  const textRecord = trimmed.match(/^\[(?<timestamp>[^\]]+)\]\s+(?<level>INFO|WARN|ERROR)\s+(?<message>.*)$/i);
  if (textRecord?.groups) {
    return [
      formatLogTimestamp(textRecord.groups.timestamp),
      textRecord.groups.level.toUpperCase().padEnd(5),
      textRecord.groups.message,
    ].join(" ");
  }

  const timestampedShellLine = trimmed.match(/^\[(?<timestamp>[^\]]+)\]\s+(?<message>.*)$/);
  if (timestampedShellLine?.groups) {
    return [
      formatLogTimestamp(timestampedShellLine.groups.timestamp),
      "INFO ".padEnd(5),
      timestampedShellLine.groups.message,
    ].join(" ");
  }

  return `${"no timestamp".padEnd(25)} ${trimmed}`;
}

function parseJsonLogLine(line: string): string | null {
  if (!line.startsWith("{")) {
    return null;
  }
  try {
    const parsed = JSON.parse(line) as { ts?: unknown; timestamp?: unknown; level?: unknown; message?: unknown; event?: unknown };
    const timestamp = typeof parsed.ts === "string"
      ? parsed.ts
      : typeof parsed.timestamp === "string"
        ? parsed.timestamp
        : null;
    const level = typeof parsed.level === "string" ? parsed.level.toUpperCase() : "INFO";
    const message = typeof parsed.message === "string" ? parsed.message : JSON.stringify(parsed);
    const event = typeof parsed.event === "string" && parsed.event !== "console" ? ` ${parsed.event}` : "";
    return [
      formatLogTimestamp(timestamp),
      `${level}${event}`.slice(0, 12).padEnd(12),
      message,
    ].join(" ");
  } catch {
    return null;
  }
}

function formatLogTimestamp(value: string | null | undefined): string {
  if (!value) {
    return "unknown time".padEnd(25);
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value.padEnd(25).slice(0, 25);
  }

  return formatLocalTimestamp(parsed);
}

function formatLocalTimestamp(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteOffset = Math.abs(offsetMinutes);
  const offsetHours = Math.floor(absoluteOffset / 60);
  const offsetRemainder = absoluteOffset % 60;
  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
    `${sign}${pad(offsetHours)}:${pad(offsetRemainder)}`,
  ].join(" ");
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
