import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describeCodexCli, findExecutableOnPath, resolveCodexCli } from "../agents/codex/codex-cli.js";
import { findLatestDatabase } from "../agents/codex/codex-state.js";
import { describeClaudeCodeCli, resolveClaudeCodeCli } from "../agents/claude-code/claude-code-cli.js";
import { describeHermesCli, resolveHermesCli } from "../agents/hermes/hermes-cli.js";
import { describeOpenClawCli, resolveOpenClawCli } from "../agents/openclaw/openclaw-cli.js";
import { describePiCli, resolvePiCli } from "../agents/pi/pi-cli.js";
import { normalizeCursorLimit, type CursorPageMeta } from "../core/pagination.js";

export interface ConnectorRuntimeState {
  status?: string;
  pid?: number;
  appPid?: number;
  exitCode?: number | null;
  signal?: string | null;
  workspace?: string;
  sessionMode?: string;
  authenticated?: boolean;
  authMethod?: string;
  adapterWarnings?: string[];
  codexCli?: string;
  piCli?: string;
  hermesCli?: string;
  openClawCli?: string;
  claudeCodeCli?: string;
  telegramTransport?: string;
  discordEnabled?: boolean;
  slackEnabled?: boolean;
  peerEnabled?: boolean;
  peerUrl?: string;
  peerTlsFingerprint?: string;
  error?: string;
  logFile?: string;
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
  scannedLineCount?: number;
  totalLineCount?: number;
  truncated?: boolean;
  updatedAt: Date | null;
  entries?: FormattedLogEntry[];
  pagination?: CursorPageMeta;
  plain: string;
}

export interface FormattedLogEntry {
  line: string;
  level: string;
  time: number;
}

export interface FormattedLogReadOptions {
  lines?: number;
  limit?: number;
  cursor?: string | null;
  level?: string | null;
  search?: string | null;
  since?: string | null;
  maxScanLines?: number;
}

export interface ClearLogResult {
  filePath: string;
  clearedAt: Date;
}

export interface NpmSpawnCommand {
  command: string;
  argsPrefix: string[];
  display: string;
  shell: boolean;
}

const APP_NAME = "nordrelay";
const PACKAGE_NAME = "@nordbyte/nordrelay";
const CODEX_PACKAGE_NAME = "@openai/codex";
const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const LEGACY_PI_PACKAGE_NAME = "@mariozechner/pi-coding-agent";
const HERMES_PACKAGE_NAME = "hermes-agent";
const OPENCLAW_PACKAGE_NAME = "openclaw";
const CLAUDE_CODE_PACKAGE_NAME = "@anthropic-ai/claude-code";
const CLAUDE_CODE_SDK_PACKAGE_NAME = "@anthropic-ai/claude-agent-sdk";
const DEFAULT_HOME = path.join(os.homedir(), ".nordrelay");
const SECRET_RE = /(bot|token|api[_-]?key|authorization|bearer|password|secret)(["'=: ]+)([^\s"',]+)/gi;
const DEFAULT_VERSION_CACHE_TTL_MS = 60 * 60 * 1000;
const DEFAULT_CLI_VERSION_CACHE_TTL_MS = 60 * 1000;

interface AgentCliVersionSnapshot {
  codexCli: ReturnType<typeof resolveCodexCli>;
  piCli: ReturnType<typeof resolvePiCli>;
  hermesCli: ReturnType<typeof resolveHermesCli>;
  openClawCli: ReturnType<typeof resolveOpenClawCli>;
  claudeCodeCli: ReturnType<typeof resolveClaudeCodeCli>;
  codexVersionLabel: string;
  piVersionLabel: string;
  hermesVersionLabel: string;
  openClawVersionLabel: string;
  claudeCodeVersionLabel: string;
  claudeCodePackageName: string;
  legacyPiPackageVersion: string | null;
}

interface CommandOutput {
  stdout: string;
  stderr: string;
  status: number | null;
  signal?: NodeJS.Signals | null;
  error?: Error & { code?: unknown };
}

const cliVersionCache = new Map<string, { value?: string; expiresAt: number; promise?: Promise<string> }>();

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

export function getAgentUpdateLogPath(home = getConnectorHome()): string {
  return path.join(home, "agent-updates.log");
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

export async function readFormattedLogTail(linesOrOptions: number | FormattedLogReadOptions = 80, filePath = getConnectorLogPath()): Promise<FormattedLogTail> {
  const options = typeof linesOrOptions === "number" ? { lines: linesOrOptions, limit: linesOrOptions } : linesOrOptions;
  const boundedLines = normalizeCursorLimit(options.limit ?? options.lines, 80, 300);
  const maxScanLines = normalizeCursorLimit(options.maxScanLines, 20_000, 100_000);
  const cursorOffset = parseLogCursor(options.cursor);
  try {
    const { lines: rawLines, stats, truncated } = await readRecentNonEmptyLines(filePath, maxScanLines);
    const filtered = parseFormattedLogEntries(rawLines.map(formatLogLine)).filter((entry) => logEntryMatches(entry, options));
    const pageEnd = Math.max(0, filtered.length - cursorOffset);
    const pageStart = Math.max(0, pageEnd - boundedLines);
    const page = filtered.slice(pageStart, pageEnd);
    const pageLines = page.map((entry) => redactSecrets(entry.line));
    const hasNext = pageStart > 0;
    const nextOffset = cursorOffset + page.length;
    return {
      filePath,
      requestedLines: boundedLines,
      lineCount: page.length,
      scannedLineCount: rawLines.length,
      totalLineCount: filtered.length,
      truncated,
      updatedAt: stats.mtime,
      entries: page.map((entry, index) => ({ ...entry, line: pageLines[index] ?? "" })),
      pagination: {
        limit: boundedLines,
        nextCursor: hasNext ? String(nextOffset) : null,
        hasNext,
        total: filtered.length,
      },
      plain: pageLines.join("\n"),
    };
  } catch (error) {
    const message = `Cannot read log: ${error instanceof Error ? error.message : String(error)}`;
    return {
      filePath,
      requestedLines: boundedLines,
      lineCount: 1,
      scannedLineCount: 0,
      totalLineCount: 0,
      truncated: false,
      updatedAt: null,
      entries: [{ line: message, level: "ERROR", time: 0 }],
      pagination: {
        limit: boundedLines,
        nextCursor: null,
        hasNext: false,
        total: 0,
      },
      plain: message,
    };
  }
}

async function readRecentNonEmptyLines(filePath: string, maxLines: number): Promise<{ lines: string[]; stats: Awaited<ReturnType<typeof stat>>; truncated: boolean }> {
  const stats = await stat(filePath);
  if (stats.size === 0) {
    return { lines: [], stats, truncated: false };
  }

  const file = await open(filePath, "r");
  const collected: string[] = [];
  const chunkSize = 64 * 1024;
  let position = stats.size;
  let carry = "";
  let truncated = false;

  try {
    while (position > 0 && collected.length <= maxLines) {
      const readSize = Math.min(chunkSize, position);
      position -= readSize;
      const buffer = Buffer.allocUnsafe(readSize);
      await file.read(buffer, 0, readSize, position);
      const text = buffer.toString("utf8") + carry;
      const parts = text.split(/\r?\n/);
      carry = parts.shift() ?? "";
      for (let index = parts.length - 1; index >= 0; index -= 1) {
        const line = parts[index] ?? "";
        if (line.trim().length > 0) {
          collected.push(line);
        }
        if (collected.length > maxLines) {
          break;
        }
      }
    }
    if (position === 0 && carry.trim().length > 0) {
      collected.push(carry);
    }
    truncated = position > 0 || collected.length > maxLines;
    return { lines: collected.slice(0, maxLines).reverse(), stats, truncated };
  } finally {
    await file.close();
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
  const [nordrelayVersion, cliVersions] = await Promise.all([
    getPackageVersion(),
    resolveAgentCliVersions(options),
  ]);
  const [
    nordrelay,
    codex,
    pi,
    hermes,
    openclaw,
    claudeCode,
  ] = await Promise.all([
    buildVersionCheck({
      label: "NordRelay",
      packageName: PACKAGE_NAME,
      installedLabel: nordrelayVersion,
      installedVersion: extractVersion(nordrelayVersion),
    }),
    buildVersionCheck({
      label: "Codex",
      packageName: CODEX_PACKAGE_NAME,
      installedLabel: cliVersions.codexVersionLabel,
      installedVersion: extractVersion(cliVersions.codexVersionLabel),
      notInstalled: cliVersions.codexVersionLabel === "not installed",
    }),
    buildVersionCheck({
      label: "Pi",
      packageName: PI_PACKAGE_NAME,
      installedLabel: cliVersions.piVersionLabel,
      installedVersion: extractVersion(cliVersions.piVersionLabel),
      notInstalled: cliVersions.piVersionLabel === "not installed",
      detail: cliVersions.legacyPiPackageVersion ? `Legacy package ${LEGACY_PI_PACKAGE_NAME} is present; current package is ${PI_PACKAGE_NAME}.` : undefined,
    }),
    buildHermesVersionCheck(cliVersions.hermesVersionLabel),
    buildVersionCheck({
      label: "OpenClaw",
      packageName: OPENCLAW_PACKAGE_NAME,
      installedLabel: cliVersions.openClawVersionLabel,
      installedVersion: extractVersion(cliVersions.openClawVersionLabel),
      notInstalled: cliVersions.openClawVersionLabel === "not installed",
    }),
    buildVersionCheck({
      label: "Claude Code",
      packageName: cliVersions.claudeCodePackageName,
      installedLabel: cliVersions.claudeCodeVersionLabel,
      installedVersion: extractVersion(cliVersions.claudeCodeVersionLabel),
      notInstalled: cliVersions.claudeCodeVersionLabel === "not installed",
    }),
  ]);

  return {
    nordrelay,
    codex,
    pi,
    hermes,
    openclaw,
    claudeCode,
  };
}

export async function getConnectorHealth(options: { piCliPath?: string; hermesCliPath?: string; openClawCliPath?: string; claudeCodeCliPath?: string } = {}): Promise<ConnectorHealth> {
  const [rawState, version, cliVersions] = await Promise.all([
    readConnectorState(),
    getPackageVersion(),
    resolveAgentCliVersions(options),
  ]);
  const pidRunning = isProcessRunning(rawState.pid);
  const appPidRunning = isProcessRunning(rawState.appPid);
  const state = normalizeConnectorState(rawState, pidRunning, appPidRunning);

  return {
    version,
    state,
    pidRunning,
    appPidRunning,
    codexCli: describeCodexCli(cliVersions.codexCli),
    codexCliPath: cliVersions.codexCli.path ?? null,
    codexCliVersion: cliVersions.codexVersionLabel,
    piCli: describePiCli(cliVersions.piCli),
    piCliPath: cliVersions.piCli.path ?? null,
    piCliVersion: cliVersions.piVersionLabel,
    hermesCli: describeHermesCli(cliVersions.hermesCli),
    hermesCliPath: cliVersions.hermesCli.path ?? null,
    hermesCliVersion: cliVersions.hermesVersionLabel,
    openClawCli: describeOpenClawCli(cliVersions.openClawCli),
    openClawCliPath: cliVersions.openClawCli.path ?? null,
    openClawCliVersion: cliVersions.openClawVersionLabel,
    claudeCodeCli: describeClaudeCodeCli(cliVersions.claudeCodeCli),
    claudeCodeCliPath: cliVersions.claudeCodeCli.path ?? null,
    claudeCodeCliVersion: cliVersions.claudeCodeVersionLabel,
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
  mkdirSync(path.dirname(updateLog), { recursive: true });
  const child = spawn(process.execPath, [
    script,
    "update",
    "--method",
    method,
    "--home",
    getConnectorHome(),
    "--keep-pending-updates",
  ], {
    cwd: sourceRoot,
    detached: true,
    env: process.env,
    stdio: "ignore",
  });
  child.unref();
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

function normalizeConnectorState(
  state: ConnectorRuntimeState,
  pidRunning: boolean,
  appPidRunning: boolean,
): ConnectorRuntimeState {
  const stoppedSignal = state.signal === "SIGTERM" || state.signal === "SIGINT";
  if (state.status === "error" && stoppedSignal && !state.error && !pidRunning && !appPidRunning) {
    return { ...state, status: "stopped" };
  }
  return state;
}

function redactSecrets(text: string): string {
  return text.replace(SECRET_RE, "$1$2[redacted]");
}

async function resolveAgentCliVersions(options: { piCliPath?: string; hermesCliPath?: string; openClawCliPath?: string; claudeCodeCliPath?: string } = {}): Promise<AgentCliVersionSnapshot> {
  const codexCli = resolveCodexCli();
  const piCli = resolvePiCli(process.env, options.piCliPath);
  const hermesCli = resolveHermesCli(process.env, options.hermesCliPath);
  const openClawCli = resolveOpenClawCli(process.env, options.openClawCliPath);
  const claudeCodeCli = resolveClaudeCodeCli(process.env, options.claudeCodeCliPath);
  const legacyPiPackageVersion = readInstalledPackageVersion(LEGACY_PI_PACKAGE_NAME);
  const [
    codexVersionLabel,
    piVersionLabel,
    hermesVersionLabel,
    openClawVersionLabel,
    claudeCodeVersionLabel,
  ] = await Promise.all([
    codexCli.path ? detectCliVersion(codexCli.path) : Promise.resolve(readInstalledPackageVersion(CODEX_PACKAGE_NAME) ?? "not installed"),
    piCli.path ? detectCliVersion(piCli.path) : Promise.resolve(readInstalledPackageVersion(PI_PACKAGE_NAME) ?? legacyPiPackageVersion ?? "not installed"),
    hermesCli.path ? detectCliVersion(hermesCli.path) : Promise.resolve("not installed"),
    openClawCli.path ? detectCliVersion(openClawCli.path) : Promise.resolve("not installed"),
    claudeCodeCli.path ? detectCliVersion(claudeCodeCli.path) : Promise.resolve(readInstalledPackageVersion(CLAUDE_CODE_SDK_PACKAGE_NAME) ?? "bundled"),
  ]);

  return {
    codexCli,
    piCli,
    hermesCli,
    openClawCli,
    claudeCodeCli,
    codexVersionLabel,
    piVersionLabel,
    hermesVersionLabel,
    openClawVersionLabel,
    claudeCodeVersionLabel,
    claudeCodePackageName: claudeCodeCli.path ? CLAUDE_CODE_PACKAGE_NAME : CLAUDE_CODE_SDK_PACKAGE_NAME,
    legacyPiPackageVersion,
  };
}

async function detectCliVersion(commandPath: string | undefined): Promise<string> {
  if (!commandPath) {
    return "not installed";
  }

  const ttlMs = parseCliVersionCacheTtlMs();
  if (ttlMs > 0) {
    const cached = cliVersionCache.get(commandPath);
    if (cached && Date.now() < cached.expiresAt) {
      if (cached.value !== undefined) {
        return cached.value;
      }
      if (cached.promise) {
        return cached.promise;
      }
    }
    const promise = detectCliVersionUncached(commandPath);
    cliVersionCache.set(commandPath, { promise, expiresAt: Date.now() + ttlMs });
    const value = await promise;
    cliVersionCache.set(commandPath, { value, expiresAt: Date.now() + ttlMs });
    return value;
  }

  return detectCliVersionUncached(commandPath);
}

async function detectCliVersionUncached(commandPath: string): Promise<string> {
  const result = await runCommand(commandPath, ["--version"], {
    shell: isWindowsShellScript(commandPath),
    timeout: 3000,
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

async function buildHermesVersionCheck(installedLabel: string): Promise<VersionCheck> {
  if (installedLabel === "not installed") {
    const latest = await detectLatestNpmVersion(HERMES_PACKAGE_NAME);
    return {
      label: "Hermes",
      packageName: HERMES_PACKAGE_NAME,
      installedLabel: "not installed",
      installedVersion: null,
      latestVersion: latest.version,
      status: "not-installed",
      detail: latest.error,
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

async function buildVersionCheck(options: {
  label: string;
  packageName: string;
  installedLabel: string;
  installedVersion: string | null;
  notInstalled?: boolean;
  skipLatest?: boolean;
  detail?: string;
}): Promise<VersionCheck> {
  if (options.notInstalled) {
    const latest = options.skipLatest ? { version: null, error: undefined } : await detectLatestNpmVersion(options.packageName);
    return {
      label: options.label,
      packageName: options.packageName,
      installedLabel: "not installed",
      installedVersion: null,
      latestVersion: latest.version,
      status: "not-installed",
      detail: [options.detail, latest.error].filter(Boolean).join(" ") || undefined,
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
      detail: options.detail ?? "Latest-version lookup is not available for this package source",
    };
  }

  const latest = await detectLatestNpmVersion(options.packageName);
  if (!options.installedVersion || !latest.version) {
    return {
      label: options.label,
      packageName: options.packageName,
      installedLabel: options.installedLabel,
      installedVersion: options.installedVersion,
      latestVersion: latest.version,
      status: "unknown",
      detail: [options.detail, latest.error ?? "Could not parse installed version"].filter(Boolean).join(" "),
    };
  }

  return {
    label: options.label,
    packageName: options.packageName,
    installedLabel: options.installedLabel,
    installedVersion: options.installedVersion,
    latestVersion: latest.version,
    status: compareVersions(options.installedVersion, latest.version) < 0 ? "outdated" : "current",
    detail: [options.detail, latest.error].filter(Boolean).join(" ") || undefined,
  };
}

async function detectLatestNpmVersion(packageName: string): Promise<{ version: string | null; error?: string }> {
  const cached = readVersionCache(packageName);
  if (cached) {
    return cached;
  }

  const npm = resolveNpmSpawnCommand();
  if (!npm) {
    return { version: null, error: "npm was not found on PATH; latest-version lookup is unavailable" };
  }

  const result = await runCommand(npm.command, [...npm.argsPrefix, "view", packageName, "version", "--registry=https://registry.npmjs.org"], {
    shell: npm.shell,
    timeout: 5000,
  });
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  if (result.error) {
    return { version: null, error: `${npm.display}: ${result.error.message}` };
  }
  if (result.status !== 0) {
    return { version: null, error: output || `npm exited ${result.status ?? "unknown"}` };
  }
  const resolved = { version: output.split(/\r?\n/).at(-1)?.trim() || null };
  writeVersionCache(packageName, resolved.version);
  return resolved;
}

function runCommand(command: string, args: string[], options: { shell?: boolean; timeout: number }): Promise<CommandOutput> {
  return new Promise((resolve) => {
    const useShell = Boolean(options.shell);
    execFile(
      useShell ? formatShellCommand(command, args) : command,
      useShell ? [] : args,
      {
        encoding: "utf8",
        shell: useShell,
        timeout: options.timeout,
        windowsHide: true,
        env: process.env,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const enriched = error as (Error & { code?: unknown; signal?: NodeJS.Signals | null }) | null;
        resolve({
          stdout: typeof stdout === "string" ? stdout : "",
          stderr: typeof stderr === "string" ? stderr : "",
          status: typeof enriched?.code === "number" ? enriched.code : error ? 1 : 0,
          signal: enriched?.signal,
          error: enriched ?? undefined,
        });
      },
    );
  });
}

function formatShellCommand(command: string, args: string[]): string {
  return [command, ...args].map(quoteShellArg).join(" ");
}

function quoteShellArg(value: string): string {
  if (process.platform === "win32") {
    return quoteWindowsCmdArg(value);
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
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

export function resolveNpmSpawnCommand(env: NodeJS.ProcessEnv = process.env): NpmSpawnCommand | null {
  const npmExecPath = env.npm_execpath?.trim();
  if (npmExecPath && existsSync(npmExecPath)) {
    return {
      command: process.execPath,
      argsPrefix: [npmExecPath],
      display: `${process.execPath} ${npmExecPath}`,
      shell: false,
    };
  }

  const pathMatch = findExecutableOnPath("npm", env.PATH, { pathext: env.PATHEXT });
  if (pathMatch) {
    return {
      command: pathMatch,
      argsPrefix: [],
      display: pathMatch,
      shell: isWindowsShellScript(pathMatch),
    };
  }

  for (const candidate of commonNpmCandidates(env)) {
    if (!existsSync(candidate)) {
      continue;
    }
    return {
      command: candidate,
      argsPrefix: [],
      display: candidate,
      shell: isWindowsShellScript(candidate),
    };
  }

  return null;
}

function commonNpmCandidates(env: NodeJS.ProcessEnv): string[] {
  const names = process.platform === "win32" ? ["npm.cmd", "npm.bat", "npm"] : ["npm"];
  const directories = [
    path.dirname(process.execPath),
    env.APPDATA ? path.join(env.APPDATA, "npm") : undefined,
    env.ProgramFiles ? path.join(env.ProgramFiles, "nodejs") : undefined,
    env["ProgramFiles(x86)"] ? path.join(env["ProgramFiles(x86)"], "nodejs") : undefined,
  ].filter((value): value is string => Boolean(value));
  return directories.flatMap((directory) => names.map((name) => path.join(directory, name)));
}

function isWindowsShellScript(filePath: string): boolean {
  return process.platform === "win32" && /\.(?:cmd|bat)$/i.test(filePath);
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

function parseCliVersionCacheTtlMs(): number {
  const raw = process.env.NORDRELAY_CLI_VERSION_CACHE_TTL_MS;
  if (!raw) {
    return DEFAULT_CLI_VERSION_CACHE_TTL_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : DEFAULT_CLI_VERSION_CACHE_TTL_MS;
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

function parseLogCursor(cursor: string | null | undefined): number {
  const parsed = Number.parseInt(String(cursor ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function parseFormattedLogEntries(lines: string[]): FormattedLogEntry[] {
  let currentLevel = "INFO";
  let currentTime = 0;
  return lines.filter((line) => line.length > 0).map((line) => {
    const explicitLevel = explicitFormattedLogLevel(line);
    if (explicitLevel) {
      currentLevel = explicitLevel;
    }
    const parsedTime = formattedLogTime(line);
    if (parsedTime) {
      currentTime = parsedTime;
    }
    return {
      line,
      level: currentLevel,
      time: currentTime,
    };
  });
}

function explicitFormattedLogLevel(line: string): string {
  const match = String(line || "").match(/^\s*(?:\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}|unknown time)?\s*(ERROR|WARN|INFO)\b/i);
  return match?.[1]?.toUpperCase() ?? "";
}

function formattedLogTime(line: string): number {
  const match = String(line || "").match(/^\s*(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2})/);
  if (!match?.[1]) {
    return 0;
  }
  const parsed = new Date(match[1].replace(" ", "T")).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function logEntryMatches(entry: FormattedLogEntry, options: FormattedLogReadOptions): boolean {
  const level = String(options.level || "all").toUpperCase();
  if (level !== "ALL" && entry.level !== level) {
    return false;
  }
  const search = String(options.search || "").trim().toLowerCase();
  if (search && !entry.line.toLowerCase().includes(search)) {
    return false;
  }
  const since = logSinceTime(options.since);
  if (since && entry.time && entry.time < since) {
    return false;
  }
  return true;
}

function logSinceTime(value: string | null | undefined): number {
  if (!value) {
    return 0;
  }
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
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
