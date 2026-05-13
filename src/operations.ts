import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describeCodexCli, resolveCodexCli } from "./codex-cli.js";
import { findLatestDatabase } from "./codex-state.js";
import { describeClaudeCodeCli, resolveClaudeCodeCli } from "./claude-code-cli.js";
import { describeHermesCli, resolveHermesCli } from "./hermes-cli.js";
import { describeOpenClawCli, resolveOpenClawCli } from "./openclaw-cli.js";
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
  hermesCli?: string;
  openClawCli?: string;
  claudeCodeCli?: string;
  error?: string;
  updatedAt?: string;
}

export interface ConnectorHealth {
  version: string;
  state: ConnectorRuntimeState;
  pidRunning: boolean;
  appPidRunning: boolean;
  codexCli: string;
  codexCliPath: string | null;
  codexCliVersion: string;
  piCli: string;
  piCliPath: string | null;
  piCliVersion: string;
  hermesCli: string;
  hermesCliPath: string | null;
  hermesCliVersion: string;
  openClawCli: string;
  openClawCliPath: string | null;
  openClawCliVersion: string;
  claudeCodeCli: string;
  claudeCodeCliPath: string | null;
  claudeCodeCliVersion: string;
  stateFile: string;
  logFile: string;
  databasePath: string | null;
  uptimeSeconds: number;
}

export type VersionFreshness = "current" | "outdated" | "unknown" | "not-installed";

export interface VersionCheck {
  label: string;
  packageName: string;
  installedLabel: string;
  installedVersion: string | null;
  latestVersion: string | null;
  status: VersionFreshness;
  detail?: string;
}

export interface VersionChecks {
  nordrelay: VersionCheck;
  codex: VersionCheck;
  pi: VersionCheck;
  hermes: VersionCheck;
  openclaw: VersionCheck;
  claudeCode: VersionCheck;
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

export interface ClearLogResult {
  filePath: string;
  clearedAt: Date;
}

const APP_NAME = "nordrelay";
const PACKAGE_NAME = "@nordbyte/nordrelay";
const CODEX_PACKAGE_NAME = "@openai/codex";
const PI_PACKAGE_NAME = "@mariozechner/pi-coding-agent";
const HERMES_PACKAGE_NAME = "hermes-agent";
const OPENCLAW_PACKAGE_NAME = "openclaw";
const CLAUDE_CODE_PACKAGE_NAME = "@anthropic-ai/claude-code";
const CLAUDE_CODE_SDK_PACKAGE_NAME = "@anthropic-ai/claude-agent-sdk";
const DEFAULT_HOME = path.join(os.homedir(), ".nordrelay");
const SECRET_RE = /(bot|token|api[_-]?key|authorization|bearer|password|secret)(["'=: ]+)([^\s"',]+)/gi;
const DEFAULT_VERSION_CACHE_TTL_MS = 60 * 60 * 1000;

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

export function clearLogFile(filePath = getConnectorLogPath()): ClearLogResult {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, "", "utf8");
  return {
    filePath,
    clearedAt: new Date(),
  };
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

export async function getVersionChecks(options: { piCliPath?: string; hermesCliPath?: string; openClawCliPath?: string; claudeCodeCliPath?: string } = {}): Promise<VersionChecks> {
  const nordrelayVersion = await getPackageVersion();
  const codexCli = resolveCodexCli();
  const piCli = resolvePiCli(process.env, options.piCliPath);
  const hermesCli = resolveHermesCli(process.env, options.hermesCliPath);
  const openClawCli = resolveOpenClawCli(process.env, options.openClawCliPath);
  const claudeCodeCli = resolveClaudeCodeCli(process.env, options.claudeCodeCliPath);
  const codexVersionLabel = codexCli.path
    ? detectCliVersion(codexCli.path)
    : readInstalledPackageVersion(CODEX_PACKAGE_NAME) ?? "not installed";
  const piVersionLabel = piCli.path ? detectCliVersion(piCli.path) : "not installed";
  const hermesVersionLabel = hermesCli.path ? detectCliVersion(hermesCli.path) : "not installed";
  const openClawVersionLabel = openClawCli.path ? detectCliVersion(openClawCli.path) : "not installed";
  const claudeCodeVersionLabel = claudeCodeCli.path
    ? detectCliVersion(claudeCodeCli.path)
    : readInstalledPackageVersion(CLAUDE_CODE_SDK_PACKAGE_NAME) ?? "bundled";
  const claudeCodePackageName = claudeCodeCli.path ? CLAUDE_CODE_PACKAGE_NAME : CLAUDE_CODE_SDK_PACKAGE_NAME;

  return {
    nordrelay: buildVersionCheck({
      label: "NordRelay",
      packageName: PACKAGE_NAME,
      installedLabel: nordrelayVersion,
      installedVersion: extractVersion(nordrelayVersion),
    }),
    codex: buildVersionCheck({
      label: "Codex",
      packageName: CODEX_PACKAGE_NAME,
      installedLabel: codexVersionLabel,
      installedVersion: extractVersion(codexVersionLabel),
      notInstalled: codexVersionLabel === "not installed",
    }),
    pi: buildVersionCheck({
      label: "Pi",
      packageName: PI_PACKAGE_NAME,
      installedLabel: piVersionLabel,
      installedVersion: extractVersion(piVersionLabel),
      notInstalled: piVersionLabel === "not installed",
    }),
    hermes: buildHermesVersionCheck(hermesVersionLabel),
    openclaw: buildVersionCheck({
      label: "OpenClaw",
      packageName: OPENCLAW_PACKAGE_NAME,
      installedLabel: openClawVersionLabel,
      installedVersion: extractVersion(openClawVersionLabel),
      notInstalled: openClawVersionLabel === "not installed",
    }),
    claudeCode: buildVersionCheck({
      label: "Claude Code",
      packageName: claudeCodePackageName,
      installedLabel: claudeCodeVersionLabel,
      installedVersion: extractVersion(claudeCodeVersionLabel),
      notInstalled: claudeCodeVersionLabel === "not installed",
    }),
  };
}

export async function getConnectorHealth(options: { piCliPath?: string; hermesCliPath?: string; openClawCliPath?: string; claudeCodeCliPath?: string } = {}): Promise<ConnectorHealth> {
  const state = await readConnectorState();
  const version = await getPackageVersion();
  const pidRunning = isProcessRunning(state.pid);
  const appPidRunning = isProcessRunning(state.appPid);
  const codexCli = resolveCodexCli();
  const piCli = resolvePiCli(process.env, options.piCliPath);
  const hermesCli = resolveHermesCli(process.env, options.hermesCliPath);
  const openClawCli = resolveOpenClawCli(process.env, options.openClawCliPath);
  const claudeCodeCli = resolveClaudeCodeCli(process.env, options.claudeCodeCliPath);

  return {
    version,
    state,
    pidRunning,
    appPidRunning,
    codexCli: describeCodexCli(codexCli),
    codexCliPath: codexCli.path ?? null,
    codexCliVersion: detectCliVersion(codexCli.path),
    piCli: describePiCli(piCli),
    piCliPath: piCli.path ?? null,
    piCliVersion: detectCliVersion(piCli.path),
    hermesCli: describeHermesCli(hermesCli),
    hermesCliPath: hermesCli.path ?? null,
    hermesCliVersion: detectCliVersion(hermesCli.path),
    openClawCli: describeOpenClawCli(openClawCli),
    openClawCliPath: openClawCli.path ?? null,
    openClawCliVersion: detectCliVersion(openClawCli.path),
    claudeCodeCli: describeClaudeCodeCli(claudeCodeCli),
    claudeCodeCliPath: claudeCodeCli.path ?? null,
    claudeCodeCliVersion: claudeCodeCli.path
      ? detectCliVersion(claudeCodeCli.path)
      : readInstalledPackageVersion(CLAUDE_CODE_SDK_PACKAGE_NAME) ?? "bundled",
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

function detectCliVersion(commandPath: string | undefined): string {
  if (!commandPath) {
    return "not installed";
  }

  const result = spawnSync(commandPath, ["--version"], {
    encoding: "utf8",
    timeout: 3000,
    windowsHide: true,
  });

  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  if (result.error) {
    return `unavailable (${result.error.message})`;
  }
  if (result.status !== 0) {
    return output ? `unavailable (${output})` : `unavailable (exit ${result.status ?? "unknown"})`;
  }
  return output || "unknown";
}

function buildHermesVersionCheck(installedLabel: string): VersionCheck {
  if (installedLabel === "not installed") {
    return {
      label: "Hermes",
      packageName: HERMES_PACKAGE_NAME,
      installedLabel: "not installed",
      installedVersion: null,
      latestVersion: null,
      status: "not-installed",
    };
  }

  const lines = installedLabel.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const versionLine = lines[0] ?? installedLabel;
  const updateLine = lines.find((line) => /^Update available:/i.test(line));
  const installedVersion = extractVersion(versionLine);
  return {
    label: "Hermes",
    packageName: HERMES_PACKAGE_NAME,
    installedLabel: versionLine,
    installedVersion,
    latestVersion: updateLine?.replace(/^Update available:\s*/i, "") ?? null,
    status: updateLine ? "outdated" : installedVersion ? "current" : "unknown",
    detail: updateLine ?? (installedVersion ? undefined : "Could not parse Hermes version or update status"),
  };
}

function buildVersionCheck(options: {
  label: string;
  packageName: string;
  installedLabel: string;
  installedVersion: string | null;
  notInstalled?: boolean;
  skipLatest?: boolean;
}): VersionCheck {
  if (options.notInstalled) {
    return {
      label: options.label,
      packageName: options.packageName,
      installedLabel: "not installed",
      installedVersion: null,
      latestVersion: null,
      status: "not-installed",
    };
  }

  if (options.skipLatest) {
    return {
      label: options.label,
      packageName: options.packageName,
      installedLabel: options.installedLabel,
      installedVersion: options.installedVersion,
      latestVersion: null,
      status: options.installedVersion ? "unknown" : "unknown",
      detail: "Latest-version lookup is not available for this package source",
    };
  }

  const latest = detectLatestNpmVersion(options.packageName);
  if (!options.installedVersion || !latest.version) {
    return {
      label: options.label,
      packageName: options.packageName,
      installedLabel: options.installedLabel,
      installedVersion: options.installedVersion,
      latestVersion: latest.version,
      status: "unknown",
      detail: latest.error ?? "Could not parse installed version",
    };
  }

  return {
    label: options.label,
    packageName: options.packageName,
    installedLabel: options.installedLabel,
    installedVersion: options.installedVersion,
    latestVersion: latest.version,
    status: compareVersions(options.installedVersion, latest.version) < 0 ? "outdated" : "current",
    detail: latest.error,
  };
}

function detectLatestNpmVersion(packageName: string): { version: string | null; error?: string } {
  const cached = readVersionCache(packageName);
  if (cached) {
    return cached;
  }

  const result = spawnSync("npm", ["view", packageName, "version", "--registry=https://registry.npmjs.org"], {
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
  });
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  if (result.error) {
    return { version: null, error: result.error.message };
  }
  if (result.status !== 0) {
    return { version: null, error: output || `npm exited ${result.status ?? "unknown"}` };
  }
  const resolved = { version: output.split(/\r?\n/).at(-1)?.trim() || null };
  writeVersionCache(packageName, resolved.version);
  return resolved;
}

function readVersionCache(packageName: string): { version: string | null; error?: string } | null {
  const ttlMs = parseVersionCacheTtlMs();
  if (ttlMs <= 0) {
    return null;
  }
  try {
    const payload = JSON.parse(readFileSync(getVersionCachePath(), "utf8")) as {
      packages?: Record<string, { version?: unknown; checkedAt?: unknown }>;
    };
    const entry = payload.packages?.[packageName];
    if (!entry || typeof entry.version !== "string" || typeof entry.checkedAt !== "number") {
      return null;
    }
    if (Date.now() - entry.checkedAt > ttlMs) {
      return null;
    }
    return { version: entry.version };
  } catch {
    return null;
  }
}

function writeVersionCache(packageName: string, version: string | null): void {
  if (!version || parseVersionCacheTtlMs() <= 0) {
    return;
  }
  const filePath = getVersionCachePath();
  try {
    const existing = existsSync(filePath)
      ? JSON.parse(readFileSync(filePath, "utf8")) as { packages?: Record<string, { version: string; checkedAt: number }> }
      : {};
    const packages = existing.packages ?? {};
    packages[packageName] = { version, checkedAt: Date.now() };
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${JSON.stringify({ packages }, null, 2)}\n`, "utf8");
  } catch {
    // Best-effort cache only.
  }
}

function getVersionCachePath(): string {
  return path.join(getConnectorHome(), "version-cache.json");
}

function parseVersionCacheTtlMs(): number {
  const raw = process.env.NORDRELAY_VERSION_CACHE_TTL_MS;
  if (!raw) {
    return DEFAULT_VERSION_CACHE_TTL_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : DEFAULT_VERSION_CACHE_TTL_MS;
}

function readInstalledPackageVersion(packageName: string): string | null {
  try {
    const packagePath = path.join(getSourceRoot(), "node_modules", ...packageName.split("/"), "package.json");
    const pkg = JSON.parse(readFileSyncUtf8(packagePath)) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

function readFileSyncUtf8(filePath: string): string {
  return readFileSync(filePath, "utf8");
}

function extractVersion(value: string): string | null {
  const match = value.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/);
  return match?.[0] ?? null;
}

function compareVersions(left: string, right: string): number {
  const leftParts = parseVersionParts(left);
  const rightParts = parseVersionParts(right);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const diff = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

function parseVersionParts(value: string): number[] {
  return value.split(/[.-]/).slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);
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

  return trimmed;
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
  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
  ].join(" ");
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
