#!/usr/bin/env node
import fs from "node:fs";
import fsp from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildLaunchdServiceSpec,
  buildSystemdUserServiceSpec,
  buildWindowsTaskServiceSpec,
  parseServiceFlags,
  serviceInstallSpec,
} from "./service-installer.mjs";

const FALLBACK_VERSION = "0.3.1";
const require = createRequire(import.meta.url);
const APP_NAME = "nordrelay";
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PLUGIN_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const DEFAULT_MARKETPLACE_ROOT = path.resolve(PLUGIN_ROOT, "../..");
const RUNTIME_ROOT = findRuntimeRoot();
const VERSION = readRuntimePackageVersion() || FALLBACK_VERSION;
const DEFAULT_HOME = path.join(os.homedir(), ".nordrelay");
const LIFECYCLE_LOCK_TIMEOUT_MS = 10000;
const LIFECYCLE_LOCK_STALE_MS = 60000;

function nowIso() {
  return new Date().toISOString();
}

function readRuntimePackageVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(RUNTIME_ROOT, "package.json"), "utf8"));
    return typeof pkg.version === "string" && pkg.version.trim() ? pkg.version.trim() : null;
  } catch {
    return null;
  }
}

function isMainScript(argvPath) {
  if (!argvPath) return false;
  try {
    return fs.realpathSync.native(argvPath) === fs.realpathSync.native(SCRIPT_PATH);
  } catch {
    return path.resolve(argvPath) === SCRIPT_PATH;
  }
}

function parseArgs(argv) {
  const copy = [...argv];
  let command = "foreground";
  if (copy[0] === "--help" || copy[0] === "-h") {
    command = "help";
    copy.shift();
  }
  if (copy[0] === "--version" || copy[0] === "-v") {
    command = "version";
    copy.shift();
  }
  if (copy[0] && !copy[0].startsWith("-")) {
    command = copy.shift();
  }

  const options = {
    command,
    rawFlags: copy,
    home: process.env.NORDRELAY_HOME || DEFAULT_HOME,
    dropPendingUpdates: !envFlag("NORDRELAY_KEEP_PENDING_UPDATES"),
    force: false,
    host: undefined,
    port: undefined,
    restartAfterUpdate: true,
    updateMethod: undefined,
    buildBeforeStart: false,
    fix: false,
  };

  for (let i = 0; i < copy.length; i += 1) {
    const arg = copy[i];
    if (arg === "--home") options.home = requireValue(copy, ++i, arg);
    else if (arg === "--keep-pending-updates") options.dropPendingUpdates = false;
    else if (arg === "--force") options.force = true;
    else if (arg === "--host") options.host = requireValue(copy, ++i, arg);
    else if (arg === "--port") options.port = Number.parseInt(requireValue(copy, ++i, arg), 10);
    else if (arg === "--method") options.updateMethod = requireValue(copy, ++i, arg);
    else if (arg === "--build") options.buildBeforeStart = true;
    else if (arg === "--fix") options.fix = true;
    else if (arg === "--no-restart") options.restartAfterUpdate = false;
    else if (arg === "--restart") options.restartAfterUpdate = true;
    else if (arg === "--disable-webui") options.disableWebui = true;
    else if (arg === "--token") options.telegramBotToken = requireValue(copy, ++i, arg);
    else if (arg === "--disable-telegram") options.disableTelegram = true;
    else if (arg === "--enable-discord") options.enableDiscord = true;
    else if (arg === "--discord-token") options.discordBotToken = requireValue(copy, ++i, arg);
    else if (arg === "--discord-client-id") options.discordClientId = requireValue(copy, ++i, arg);
    else if (arg === "--enable-slack") options.enableSlack = true;
    else if (arg === "--slack-bot-token") options.slackBotToken = requireValue(copy, ++i, arg);
    else if (arg === "--slack-app-token") options.slackAppToken = requireValue(copy, ++i, arg);
    else if (arg === "--slack-signing-secret") options.slackSigningSecret = requireValue(copy, ++i, arg);
    else if (arg === "--enable-matrix") options.enableMatrix = true;
    else if (arg === "--matrix-homeserver-url") options.matrixHomeserverUrl = requireValue(copy, ++i, arg);
    else if (arg === "--matrix-access-token") options.matrixAccessToken = requireValue(copy, ++i, arg);
    else if (arg === "--matrix-user-id") options.matrixUserId = requireValue(copy, ++i, arg);
    else if (arg === "--matrix-device-id") options.matrixDeviceId = requireValue(copy, ++i, arg);
    else if (arg === "--admin-email") options.adminEmail = requireValue(copy, ++i, arg);
    else if (arg === "--admin-name") options.adminName = requireValue(copy, ++i, arg);
    else if (arg === "--admin-password") options.adminPassword = requireValue(copy, ++i, arg);
    else if (arg === "--telegram-user-id") options.telegramUserId = requireValue(copy, ++i, arg);
    else if (arg === "--discord-user-id") options.discordUserId = requireValue(copy, ++i, arg);
    else if (arg === "--slack-user-id") options.slackUserId = requireValue(copy, ++i, arg);
    else if (arg === "--slack-team-id") options.slackTeamId = requireValue(copy, ++i, arg);
    else if (arg === "--matrix-user-id-link") options.matrixLinkedUserId = requireValue(copy, ++i, arg);
    else if (arg === "--matrix-homeserver") options.matrixLinkedHomeserver = requireValue(copy, ++i, arg);
    else if (arg === "--state-backend") options.stateBackend = requireValue(copy, ++i, arg);
    else if (arg === "--enable-pi") options.enablePi = true;
    else if (arg === "--enable-hermes") options.enableHermes = true;
    else if (arg === "--enable-openclaw") options.enableOpenClaw = true;
    else if (arg === "--enable-claude-code") options.enableClaudeCode = true;
    else if (arg === "--disable-codex") options.disableCodex = true;
  }

  options.pidFile = path.join(options.home, "nordrelay.pid");
  options.stateFile = path.join(options.home, "state.json");
  options.logFile = path.join(options.home, "nordrelay.log");
  options.webPidFile = path.join(options.home, "nordrelay-web.pid");
  options.webStateFile = path.join(options.home, "web-state.json");
  options.webLogFile = path.join(options.home, "nordrelay-web.log");
  return options;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("-")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function envFlag(name) {
  const value = process.env[name];
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

async function mkdirp(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

function loadEnvFiles(home) {
  const envPath = resolveEnvPath(home);
  loadEnvFile(envPath);

  normalizeEnvAliases();
}

function resolveEnvPath(home) {
  return process.env.NORDRELAY_ENV_FILE
    ? path.resolve(process.env.NORDRELAY_ENV_FILE)
    : path.join(home, "nordrelay.env");
}

function resolveLaunchWorkspace() {
  const configured = process.env.NORDRELAY_WORKSPACE?.trim();
  return path.resolve(configured || process.cwd());
}

function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) return;
  const text = fs.readFileSync(envPath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
    const equals = normalized.indexOf("=");
    if (equals < 1) continue;
    const key = normalized.slice(0, equals).trim();
    let value = normalized.slice(equals + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value.replace(/\\n/g, "\n");
    }
  }
}

function normalizeEnvAliases() {
  if (!process.env.TOOL_VERBOSITY && envFlag("NORDRELAY_FORWARD_TOOL_OUTPUT")) {
    process.env.TOOL_VERBOSITY = "all";
  }
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(filePath, payload) {
  await mkdirp(path.dirname(filePath));
  const tmp = `${filePath}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`);
  await fsp.rename(tmp, filePath);
}

function isProcessRunning(pid) {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readProcessCommandLine(pid) {
  if (!pid || process.platform !== "linux") return null;
  try {
    const raw = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
    return raw.split("\0").filter(Boolean).join(" ");
  } catch {
    return null;
  }
}

async function readPid(pidFile) {
  try {
    const value = Number.parseInt((await fsp.readFile(pidFile, "utf8")).trim(), 10);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

async function writePidAtomic(pidFile, pid) {
  await mkdirp(path.dirname(pidFile));
  const tmp = `${pidFile}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, `${pid}\n`);
  await fsp.rename(tmp, pidFile);
}

async function isLifecycleLockStale(lockFile) {
  try {
    const stat = await fsp.stat(lockFile);
    if (Date.now() - stat.mtimeMs > LIFECYCLE_LOCK_STALE_MS) {
      return true;
    }
    const text = await fsp.readFile(lockFile, "utf8").catch(() => "");
    const pid = Number.parseInt(text.trim(), 10);
    return Number.isFinite(pid) && !isProcessRunning(pid);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    return true;
  }
}

async function withLifecycleLock(lockFile, task) {
  await mkdirp(path.dirname(lockFile));
  const deadline = Date.now() + LIFECYCLE_LOCK_TIMEOUT_MS;
  let handle = null;
  for (;;) {
    try {
      handle = await fsp.open(lockFile, "wx");
      await handle.writeFile(`${process.pid}\n`);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      if (await isLifecycleLockStale(lockFile)) {
        await fsp.rm(lockFile, { force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for lifecycle lock ${lockFile}`);
      }
      await sleep(100);
    }
  }

  try {
    return await task();
  } finally {
    await handle?.close().catch(() => {});
    await fsp.rm(lockFile, { force: true });
  }
}

function pidFileLock(pidFile) {
  return `${pidFile}.lock`;
}

async function isManagedConnectorPid(options, pid) {
  if (!isProcessRunning(pid)) return false;
  const state = await readJson(options.stateFile, {});
  const commandLine = readProcessCommandLine(pid);
  if (commandLine) {
    return commandLine.includes(SCRIPT_PATH) && commandLine.includes(" foreground");
  }
  return Number(state?.pid) === pid && state?.status !== "stopped";
}

async function isManagedWebPid(options, pid) {
  if (!isProcessRunning(pid)) return false;
  const state = await readWebState(options);
  const commandLine = readProcessCommandLine(pid);
  if (commandLine) {
    return commandLine.includes(RUNTIME_ROOT) && commandLine.includes("web-dashboard");
  }
  return Number(state?.pid) === pid && state?.status !== "stopped";
}

async function readWebState(options) {
  return await readJson(options.webStateFile, {});
}

async function readWebPid(options) {
  return await readPid(options.webPidFile);
}

async function isWebDashboardRunning(options) {
  return await isManagedWebPid(options, await readWebPid(options));
}

async function writeWebState(options, patch) {
  await writeJsonAtomic(options.webStateFile, {
    updatedAt: nowIso(),
    logFile: options.webLogFile,
    ...patch,
  });
}

function resolveDashboardEndpoint(options, settings = {}) {
  const host = options.host || process.env.NORDRELAY_DASHBOARD_HOST || "127.0.0.1";
  const rawPort = options.port ?? Number.parseInt(process.env.NORDRELAY_DASHBOARD_PORT || "31878", 10);
  if (!Number.isFinite(rawPort) || rawPort <= 0) {
    if (settings.strict) {
      throw new Error("Dashboard port must be a positive number.");
    }
    return { host, port: 31878 };
  }
  const port = rawPort;
  return { host, port };
}

function isWebUiEnabled() {
  return process.env.NORDRELAY_WEBUI_ENABLED !== "false";
}

function formatDashboardUrl(endpoint) {
  const host = endpoint.host || "127.0.0.1";
  const displayHost = host === "0.0.0.0" || host === "" ? "127.0.0.1" : host === "::" ? "::1" : host;
  const formattedHost = displayHost.includes(":") && !displayHost.startsWith("[") ? `[${displayHost}]` : displayHost;
  const bindHint = displayHost === host ? "" : ` (binds ${host || "all interfaces"})`;
  return `http://${formattedHost}:${endpoint.port}/${bindHint}`;
}

async function webDashboardHint(options, webUiEnabled) {
  if (!webUiEnabled) {
    return "(disabled by NORDRELAY_WEBUI_ENABLED=false)";
  }
  const webPid = await readWebPid(options);
  return await isManagedWebPid(options, webPid) ? `(running with PID ${webPid})` : "(run `nordrelay web` to start it)";
}

async function commandStart(options, settings = {}) {
  await mkdirp(options.home);
  loadEnvFiles(options.home);
  warnIfCliPathMissing();
  await prepareRuntimeForLaunch(options);
  const dashboard = resolveDashboardEndpoint(options);
  const webUiEnabled = isWebUiEnabled();

  await withLifecycleLock(pidFileLock(options.pidFile), async () => {
    const currentPid = await readPid(options.pidFile);
    if (await isManagedConnectorPid(options, currentPid)) {
      console.log(`Already running with PID ${currentPid}`);
      await commandStatus(options);
      return;
    }
    if (currentPid) {
      await fsp.rm(options.pidFile, { force: true });
    }

    await writeJsonAtomic(options.stateFile, {
      status: "starting",
      pid: null,
      updatedAt: nowIso(),
      logFile: options.logFile,
    });

    const logFd = fs.openSync(options.logFile, "a");
    const child = spawn(process.execPath, [SCRIPT_PATH, "foreground", ...runtimeForwardFlags(options.rawFlags)], {
      cwd: RUNTIME_ROOT,
      detached: true,
      env: {
        ...process.env,
        NORDRELAY_WORKSPACE: resolveLaunchWorkspace(),
      },
      stdio: ["ignore", logFd, logFd],
    });
    child.unref();
    fs.closeSync(logFd);

    await writePidAtomic(options.pidFile, child.pid);

    const state = await waitForState(options.stateFile, child.pid, 8000);
    if (state?.status === "ready") {
      console.log(`Started ${APP_NAME} ${VERSION} with PID ${child.pid}`);
      console.log(`Workspace: ${state.workspace || "-"}`);
      console.log(`Mode: ${state.sessionMode || "per Telegram context"}`);
      if (!settings.skipWebHint) {
        console.log(`WebUI: ${formatDashboardUrl(dashboard)} ${await webDashboardHint(options, webUiEnabled)}`);
      }
      console.log(`Log: ${options.logFile}`);
      return;
    }

    if (state?.status === "error") {
      if (!isProcessRunning(child.pid)) {
        await fsp.rm(options.pidFile, { force: true });
      }
      console.log(`Startup failed. Log: ${options.logFile}`);
      console.log(state.error || await readStartupError(options.logFile) || "Unknown error");
      process.exitCode = 1;
      return;
    }

    console.log(`Started ${APP_NAME} ${VERSION} with PID ${child.pid}`);
    if (!settings.skipWebHint) {
      console.log(`WebUI: ${formatDashboardUrl(dashboard)} ${await webDashboardHint(options, webUiEnabled)}`);
    }
    console.log(`Startup is still in progress. Log: ${options.logFile}`);
  });
}

async function ensureConnectorStartedForWeb(options) {
  const currentPid = await readPid(options.pidFile);
  if (await isManagedConnectorPid(options, currentPid)) {
    console.log(`NordRelay connector already running with PID ${currentPid}.`);
    return;
  }

  console.log("Starting NordRelay connector...");
  const previousExitCode = process.exitCode;
  await commandStart(options, { skipWebHint: true });
  if (process.exitCode && process.exitCode !== previousExitCode) {
    throw new Error(`NordRelay connector failed to start. See ${options.logFile}.`);
  }
}

async function waitForState(stateFile, pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await readJson(stateFile);
    if (state?.pid === pid && ["ready", "error"].includes(state.status)) {
      return state;
    }
    if (!isProcessRunning(pid)) {
      return await readJson(stateFile);
    }
    await sleep(250);
  }
  return await readJson(stateFile);
}

async function stopWebDashboard(options, settings = {}) {
  const pid = await readWebPid(options);
  if (!(await isManagedWebPid(options, pid))) {
    await fsp.rm(options.webPidFile, { force: true });
    const state = await readWebState(options);
    if (state.status === "running" || state.status === "starting") {
      await writeWebState(options, { status: "stopped", pid: null });
    }
    if (!settings.quiet) {
      console.log("WebUI is not running.");
    }
    return false;
  }

  process.kill(pid, "SIGTERM");
  for (let i = 0; i < 40; i += 1) {
    if (!isProcessRunning(pid)) break;
    await sleep(250);
  }

  if (isProcessRunning(pid)) {
    process.kill(pid, "SIGKILL");
    for (let i = 0; i < 20; i += 1) {
      if (!isProcessRunning(pid)) break;
      await sleep(250);
    }
  }

  if (isProcessRunning(pid)) {
    console.log(`WebUI PID ${pid} did not exit after SIGTERM/SIGKILL.`);
    process.exitCode = 1;
    return false;
  }
  await fsp.rm(options.webPidFile, { force: true });
  await writeWebState(options, { status: "stopped", pid: null });
  if (!settings.quiet) {
    console.log(`Stopped WebUI PID ${pid}.`);
  }
  return true;
}

async function commandStop(options, settings = {}) {
  if (!settings.keepWeb) {
    await stopWebDashboard(options);
  }
  const pid = await readPid(options.pidFile);
  if (!(await isManagedConnectorPid(options, pid))) {
    console.log("Connector is not running.");
    await fsp.rm(options.pidFile, { force: true });
    return;
  }

  process.kill(pid, "SIGTERM");
  for (let i = 0; i < 40; i += 1) {
    if (!isProcessRunning(pid)) break;
    await sleep(250);
  }

  if (isProcessRunning(pid)) {
    console.log(`PID ${pid} did not exit after SIGTERM.`);
    process.exitCode = 1;
  } else {
    await fsp.rm(options.pidFile, { force: true });
    console.log(`Stopped ${APP_NAME} PID ${pid}.`);
  }
}

async function commandStatus(options) {
  loadEnvFiles(options.home);
  const dashboard = resolveDashboardEndpoint(options);
  const pid = await readPid(options.pidFile);
  const webPid = await readWebPid(options);
  const state = await readJson(options.stateFile, {});
  const webState = await readWebState(options);
  const running = await isManagedConnectorPid(options, pid);
  const webRunning = await isManagedWebPid(options, webPid);
  const webUiEnabled = isWebUiEnabled();
  const webStatus = webRunning ? "running" : webState.status === "running" || webState.status === "starting" ? "stale" : webState.status || "stopped";
  if (!webRunning && (webState.status === "running" || webState.status === "starting")) {
    await fsp.rm(options.webPidFile, { force: true });
    await writeWebState(options, { status: "stopped", pid: null });
  }
  console.log(`Status: ${state.status || (running ? "running" : "stopped")}`);
  console.log(`PID: ${pid || "-"} (${running ? "running" : "not running"})`);
  console.log(`WebUI enabled: ${webUiEnabled ? "yes" : "no"}`);
  console.log(`WebUI PID: ${webPid || "-"} (${webRunning ? "running" : "not running"})`);
  console.log(`Workspace: ${state.workspace || "-"}`);
  console.log(`Mode: ${state.sessionMode || "per Telegram context"}`);
  console.log(`Auth: ${state.authenticated === undefined ? "-" : state.authenticated ? "yes" : "no"}`);
  console.log(`Codex CLI: ${state.codexCli || "-"}`);
  console.log(`Pi CLI: ${state.piCli || "-"}`);
  console.log(`Hermes CLI: ${state.hermesCli || "-"}`);
  console.log(`OpenClaw CLI: ${state.openClawCli || "-"}`);
  console.log(`Claude Code CLI: ${state.claudeCodeCli || "-"}`);
  console.log(`OpenClaw Gateway: ${state.openClawGateway || process.env.OPENCLAW_GATEWAY_URL || "-"}`);
  console.log(`Peers: ${state.peerEnabled ? state.peerUrl || "enabled" : "disabled"}`);
  if (state.peerTlsFingerprint) console.log(`Peer TLS fingerprint: ${state.peerTlsFingerprint}`);
  console.log(`WebUI: ${formatDashboardUrl(dashboard)} (${webStatus})`);
  console.log(`Log: ${options.logFile}`);
  console.log(`WebUI log: ${options.webLogFile}`);
  if (state.error) console.log(`Error: ${state.error}`);
}

function cliPathDiagnostics() {
  const resolved = findExecutable(APP_NAME);
  const globalBin = resolveNpmGlobalBinDir();
  const candidate = globalBin ? path.join(globalBin, process.platform === "win32" ? `${APP_NAME}.cmd` : APP_NAME) : null;
  const pathContainsGlobalBin = globalBin ? pathListIncludes(globalBin) : false;
  const expected = [candidate, SCRIPT_PATH].filter(Boolean);
  const resolvedKnown = Boolean(resolved && expected.some((item) => pathsEqualOrLinked(resolved, item)));
  const hint = globalBin
    ? process.platform === "win32"
      ? `Add ${globalBin} to PATH and reopen the terminal.`
      : `Add ${globalBin} to PATH, for example: export PATH="${globalBin}:$PATH"`
    : "Ensure the npm global bin directory is on PATH.";
  return {
    ok: Boolean(resolved),
    resolved,
    globalBin,
    pathContainsGlobalBin,
    expected: candidate,
    resolvedKnown,
    detail: resolved
      ? resolvedKnown
        ? resolved
        : `${resolved} (different command target; current wrapper: ${SCRIPT_PATH})`
      : `not found on PATH${globalBin ? `; npm global bin: ${globalBin}` : ""}`,
    hint,
  };
}

function warnIfCliPathMissing() {
  if (envFlag("NORDRELAY_SUPPRESS_PATH_WARNING")) {
    return;
  }
  const diagnostics = cliPathDiagnostics();
  if (diagnostics.ok) {
    return;
  }
  console.warn(`Warning: \`${APP_NAME}\` is not available on PATH.`);
  console.warn(`Hint: ${diagnostics.hint}`);
}

async function commandUpdate(options) {
  await mkdirp(options.home);
  loadEnvFiles(options.home);
  const method = resolveUpdateMethod(options);
  const updateLog = path.join(options.home, "update.log");
  await mkdirp(path.dirname(updateLog));
  const log = fs.createWriteStream(updateLog, { flags: "a" });
  const sourceRoot = RUNTIME_ROOT;
  const wasRunning = await isManagedConnectorPid(options, await readPid(options.pidFile));
  const summary = method === "npm"
    ? "Install latest @nordbyte/nordrelay with npm, verify the CLI, and restart if the connector is running."
    : "Pull origin/main, install dependencies, run check, tests, build, and restart if the connector is running.";

  console.log(`Starting NordRelay update (${method}).`);
  console.log(`Source: ${sourceRoot}`);
  console.log(`Log: ${updateLog}`);
  logUpdateLine(log, `Starting ${method} connector self-update`);
  logUpdateLine(log, summary);

  try {
    if (method === "npm") {
      await runNpmSelfUpdate(sourceRoot, log);
    } else {
      await runGitSelfUpdate(sourceRoot, log);
    }

    if (options.restartAfterUpdate && wasRunning) {
      await runLoggedStep(log, "Restart NordRelay connector", process.execPath, [
        SCRIPT_PATH,
        "restart",
        "--keep-pending-updates",
        "--home",
        options.home,
      ], { cwd: sourceRoot });
    } else if (options.restartAfterUpdate) {
      logUpdateLine(log, "Connector was not running; restart skipped.");
      console.log("Connector was not running; restart skipped.");
    } else {
      logUpdateLine(log, "Restart skipped by --no-restart.");
      console.log("Restart skipped by --no-restart.");
    }

    logUpdateLine(log, "NordRelay update completed.");
    console.log("NordRelay update completed.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logUpdateLine(log, `ERROR ${message}`);
    console.error(`Update failed: ${message}`);
    process.exitCode = 1;
  } finally {
    await closeLogStream(log);
  }
}

function resolveUpdateMethod(options) {
  const requested = (options.updateMethod || process.env.NORDRELAY_UPDATE_METHOD || "auto").trim().toLowerCase();
  if (!requested || requested === "auto") {
    return fs.existsSync(path.join(RUNTIME_ROOT, ".git")) ? "git" : "npm";
  }
  if (requested === "npm" || requested === "git") {
    return requested;
  }
  throw new Error(`Unsupported update method "${requested}". Use auto, npm, or git.`);
}

async function runNpmSelfUpdate(sourceRoot, log) {
  const npm = resolveNpmSpawnCommand();
  if (!npm) {
    throw new Error("npm was not found. Install Node.js/npm or add npm to PATH.");
  }
  await runLoggedStep(log, "Install latest NordRelay package", npm.command, [
    ...npm.argsPrefix,
    "install",
    "-g",
    "@nordbyte/nordrelay@latest",
  ], { cwd: os.homedir(), shell: npm.shell });
  await runVerifyNordRelayCli(sourceRoot, log);
}

async function runGitSelfUpdate(sourceRoot, log) {
  const git = resolveRequiredCommand("git");
  const npm = resolveNpmSpawnCommand();
  if (!npm) {
    throw new Error("npm was not found. Install Node.js/npm or add npm to PATH.");
  }
  await runLoggedStep(log, "Pull latest source", git.command, ["pull", "--ff-only", "origin", "main"], { cwd: sourceRoot, shell: git.shell });
  await runLoggedStep(log, "Install dependencies", npm.command, [...npm.argsPrefix, "install"], { cwd: sourceRoot, shell: npm.shell });
  await runLoggedStep(log, "Run checks", npm.command, [...npm.argsPrefix, "run", "check"], { cwd: sourceRoot, shell: npm.shell });
  await runLoggedStep(log, "Run tests", npm.command, [...npm.argsPrefix, "test"], { cwd: sourceRoot, shell: npm.shell });
  await runLoggedStep(log, "Build runtime", npm.command, [...npm.argsPrefix, "run", "build"], { cwd: sourceRoot, shell: npm.shell });
  await runVerifyNordRelayCli(sourceRoot, log);
}

async function runVerifyNordRelayCli(sourceRoot, log) {
  if (fs.existsSync(SCRIPT_PATH)) {
    await runLoggedStep(log, "Verify NordRelay CLI", process.execPath, [SCRIPT_PATH, "version"], { cwd: sourceRoot });
    return;
  }
  const nordrelay = resolveRequiredCommand("nordrelay");
  await runLoggedStep(log, "Verify NordRelay CLI", nordrelay.command, ["version"], { cwd: os.homedir(), shell: nordrelay.shell });
}

async function runLoggedStep(log, label, command, args, settings = {}) {
  logUpdateLine(log, `${label}: ${formatCommand(command, args)}`);
  console.log(`\n${label}`);
  const useShell = Boolean(settings.shell);
  const child = spawn(useShell ? formatShellCommand(command, args) : command, useShell ? [] : args, {
    cwd: settings.cwd || RUNTIME_ROOT,
    env: process.env,
    shell: useShell,
    stdio: ["inherit", "pipe", "pipe"],
    windowsHide: false,
  });

  child.stdout?.on("data", (chunk) => {
    safeWrite(process.stdout, chunk);
    safeWrite(log, chunk);
  });
  child.stderr?.on("data", (chunk) => {
    safeWrite(process.stderr, chunk);
    safeWrite(log, chunk);
  });

  const exit = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  if (exit.signal) {
    throw new Error(`${label} stopped with signal ${exit.signal}`);
  }
  if (exit.code !== 0) {
    throw new Error(`${label} failed with exit code ${exit.code ?? "unknown"}`);
  }
  logUpdateLine(log, `${label} completed`);
}

function resolveRequiredCommand(command) {
  const resolved = findExecutable(command);
  if (!resolved) {
    throw new Error(`${command} was not found on PATH.`);
  }
  return {
    command: resolved,
    shell: isWindowsShellScript(resolved),
  };
}

function resolveNpmSpawnCommand(env = process.env) {
  const npmExecPath = env.npm_execpath?.trim();
  if (npmExecPath && fs.existsSync(npmExecPath)) {
    return {
      command: process.execPath,
      argsPrefix: [npmExecPath],
      shell: false,
    };
  }

  const pathMatch = findExecutable("npm", env.PATH);
  if (pathMatch) {
    return {
      command: pathMatch,
      argsPrefix: [],
      shell: isWindowsShellScript(pathMatch),
    };
  }

  for (const candidate of commonNpmCandidates(env)) {
    if (!fs.existsSync(candidate)) continue;
    return {
      command: candidate,
      argsPrefix: [],
      shell: isWindowsShellScript(candidate),
    };
  }
  return null;
}

function commonNpmCandidates(env) {
  const names = process.platform === "win32" ? ["npm.cmd", "npm.bat", "npm"] : ["npm"];
  const directories = [
    path.dirname(process.execPath),
    env.APPDATA ? path.join(env.APPDATA, "npm") : undefined,
    env.ProgramFiles ? path.join(env.ProgramFiles, "nodejs") : undefined,
    env["ProgramFiles(x86)"] ? path.join(env["ProgramFiles(x86)"], "nodejs") : undefined,
  ].filter(Boolean);
  return directories.flatMap((directory) => names.map((name) => path.join(directory, name)));
}

function logUpdateLine(log, message) {
  safeWrite(log, `[${nowIso()}] ${message}\n`);
}

function safeWrite(stream, chunk) {
  try {
    stream.write(chunk);
  } catch {
    // Logging must not break the updater if stdout/stderr disappears.
  }
}

function closeLogStream(log) {
  return new Promise((resolve) => {
    log.end(resolve);
  });
}

function formatCommand(command, args) {
  return [command, ...args].map((part) => {
    const text = String(part);
    return /[\s"'$`\\]/.test(text) ? JSON.stringify(text) : text;
  }).join(" ");
}

function formatShellCommand(command, args) {
  return [command, ...args].map(quoteShellArg).join(" ");
}

function quoteShellArg(value) {
  if (process.platform === "win32") {
    return quoteWindowsCmdArg(String(value));
  }
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function quoteWindowsCmdArg(value) {
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

async function commandInit(options) {
  await mkdirp(options.home);
  warnIfCliPathMissing();
  const envPath = path.join(options.home, "nordrelay.env");
  const userStore = await createUserStore(options.home);
  if (fs.existsSync(envPath) && !options.force) {
    console.log(`Config already exists: ${envPath}`);
    console.log("Run with --force to overwrite.");
    return;
  }

  const enableWebui = options.disableWebui ? "false" : await askChoice(null, "Enable WebUI", "true");
  const enableTelegram = options.disableTelegram ? "false" : await askChoice(null, "Enable Telegram", "true");
  const telegramBotToken = enableTelegram === "true"
    ? options.telegramBotToken || process.env.TELEGRAM_BOT_TOKEN || await ask(null, "Telegram bot token", "")
    : "";
  const enableDiscord = options.enableDiscord ? "true" : await askChoice(null, "Enable Discord", "false");
  const discordBotToken = enableDiscord === "true"
    ? options.discordBotToken || process.env.DISCORD_BOT_TOKEN || await ask(null, "Discord bot token", "")
    : "";
  const discordClientId = enableDiscord === "true"
    ? options.discordClientId || process.env.DISCORD_CLIENT_ID || await ask(null, "Discord client ID", "")
    : "";
  const enableSlack = options.enableSlack ? "true" : await askChoice(null, "Enable Slack", "false");
  const slackBotToken = enableSlack === "true"
    ? options.slackBotToken || process.env.SLACK_BOT_TOKEN || await ask(null, "Slack bot token", "")
    : "";
  const slackAppToken = enableSlack === "true"
    ? options.slackAppToken || process.env.SLACK_APP_TOKEN || await ask(null, "Slack app-level token for Socket Mode", "")
    : "";
  const slackSigningSecret = enableSlack === "true"
    ? options.slackSigningSecret || process.env.SLACK_SIGNING_SECRET || await ask(null, "Slack signing secret (optional for Socket Mode)", "")
    : "";
  const enableMatrix = options.enableMatrix ? "true" : await askChoice(null, "Enable Matrix", "false");
  const matrixHomeserverUrl = enableMatrix === "true"
    ? options.matrixHomeserverUrl || process.env.MATRIX_HOMESERVER_URL || await ask(null, "Matrix homeserver URL", "")
    : "";
  const matrixAccessToken = enableMatrix === "true"
    ? options.matrixAccessToken || process.env.MATRIX_ACCESS_TOKEN || await ask(null, "Matrix access token", "")
    : "";
  const matrixUserId = enableMatrix === "true"
    ? options.matrixUserId || process.env.MATRIX_USER_ID || await ask(null, "Matrix bot user ID", "")
    : "";
  const matrixDeviceId = enableMatrix === "true"
    ? options.matrixDeviceId || process.env.MATRIX_DEVICE_ID || await ask(null, "Matrix device ID (optional)", "")
    : "";
  const adminEmail = options.adminEmail || await ask(null, "Admin email", "");
  const adminName = options.adminName || await ask(null, "Admin name", "Admin");
  const adminPassword = options.adminPassword || await askSecret(null, "Admin password", "");
  const telegramUserId = options.telegramUserId || await ask(null, "Optional Telegram user id to link", "");
  const discordUserId = options.discordUserId || await ask(null, "Optional Discord user id to link", "");
  const slackUserId = options.slackUserId || await ask(null, "Optional Slack user id to link", "");
  const slackTeamId = slackUserId ? (options.slackTeamId || await ask(null, "Optional Slack team id for linked user", "")) : "";
  const linkedMatrixUserId = options.matrixLinkedUserId || await ask(null, "Optional Matrix user id to link", "");
  const linkedMatrixHomeserver = linkedMatrixUserId ? (options.matrixLinkedHomeserver || await ask(null, "Optional Matrix homeserver for linked user", "")) : "";
  const enableCodex = options.disableCodex ? "false" : await askChoice(null, "Enable Codex", "true");
  const enablePi = options.enablePi ? "true" : await askChoice(null, "Enable Pi", "false");
  const enableHermes = options.enableHermes ? "true" : await askChoice(null, "Enable Hermes", "false");
  const enableOpenClaw = options.enableOpenClaw ? "true" : await askChoice(null, "Enable OpenClaw", "false");
  const enableClaudeCode = options.enableClaudeCode ? "true" : await askChoice(null, "Enable Claude Code", "false");
  const stateBackend = options.stateBackend || await askChoice(null, "State backend (json/sqlite)", "json");

  if (enableTelegram === "true" && !telegramBotToken) throw new Error("Telegram bot token is required when Telegram is enabled.");
  if (enableDiscord === "true" && !discordBotToken) throw new Error("Discord bot token is required when Discord is enabled.");
  if (enableSlack === "true" && !slackBotToken) throw new Error("Slack bot token is required when Slack is enabled.");
  if (enableSlack === "true" && !slackAppToken) throw new Error("Slack app-level token is required for default Socket Mode.");
  if (enableMatrix === "true" && (!matrixHomeserverUrl || !matrixAccessToken || !matrixUserId)) throw new Error("Matrix homeserver URL, access token, and bot user ID are required when Matrix is enabled.");
  if (enableWebui !== "true" && enableTelegram !== "true" && enableDiscord !== "true" && enableSlack !== "true" && enableMatrix !== "true") {
    throw new Error("At least WebUI or one chat adapter must be enabled.");
  }
  if (!adminEmail) throw new Error("Admin email is required.");
  if (!adminPassword) throw new Error("Admin password is required.");
  if (enableCodex !== "true" && enablePi !== "true" && enableHermes !== "true" && enableOpenClaw !== "true" && enableClaudeCode !== "true") throw new Error("At least one agent must be enabled.");
  const defaultAgent = enableCodex === "true"
    ? "codex"
    : enablePi === "true"
      ? "pi"
      : enableHermes === "true"
        ? "hermes"
        : enableOpenClaw === "true"
          ? "openclaw"
          : "claude-code";

  const lines = [
    "# NordRelay local runtime config.",
    "# Keep this file private; it contains bot credentials.",
    `NORDRELAY_WEBUI_ENABLED=${enableWebui}`,
    `TELEGRAM_ENABLED=${enableTelegram}`,
    `TELEGRAM_BOT_TOKEN=${telegramBotToken}`,
    `DISCORD_ENABLED=${enableDiscord}`,
    `DISCORD_BOT_TOKEN=${discordBotToken}`,
    `DISCORD_CLIENT_ID=${discordClientId}`,
    "DISCORD_COMMAND_MODE=both",
    "DISCORD_MESSAGE_CONTENT_ENABLED=true",
    "DISCORD_AUTO_REGISTER_COMMANDS=true",
    `SLACK_ENABLED=${enableSlack}`,
    `SLACK_BOT_TOKEN=${slackBotToken}`,
    `SLACK_APP_TOKEN=${slackAppToken}`,
    `SLACK_SIGNING_SECRET=${slackSigningSecret}`,
    "SLACK_SOCKET_MODE=true",
    "SLACK_MESSAGE_CONTENT_ENABLED=true",
    "SLACK_AUTO_SEND_ARTIFACTS=false",
    `MATRIX_ENABLED=${enableMatrix}`,
    `MATRIX_HOMESERVER_URL=${matrixHomeserverUrl}`,
    `MATRIX_ACCESS_TOKEN=${matrixAccessToken}`,
    `MATRIX_USER_ID=${matrixUserId}`,
    `MATRIX_DEVICE_ID=${matrixDeviceId}`,
    "MATRIX_AUTOJOIN_INVITES=true",
    "MATRIX_MESSAGE_CONTENT_ENABLED=true",
    "MATRIX_COMMAND_PREFIX=!nr",
    "MATRIX_AUTO_SEND_ARTIFACTS=false",
    `NORDRELAY_CODEX_ENABLED=${enableCodex}`,
    `NORDRELAY_PI_ENABLED=${enablePi}`,
    `NORDRELAY_HERMES_ENABLED=${enableHermes}`,
    `NORDRELAY_OPENCLAW_ENABLED=${enableOpenClaw}`,
    `NORDRELAY_CLAUDE_CODE_ENABLED=${enableClaudeCode}`,
    `NORDRELAY_DEFAULT_AGENT=${defaultAgent}`,
    "PI_DEFAULT_PROFILE=default",
    "HERMES_API_BASE_URL=http://127.0.0.1:8642",
    "HERMES_DEFAULT_PROFILE=default",
    "OPENCLAW_GATEWAY_URL=ws://127.0.0.1:18789",
    "OPENCLAW_AGENT_ID=main",
    "OPENCLAW_DEFAULT_PROFILE=default",
    "CLAUDE_CODE_DEFAULT_PROFILE=default",
    "CLAUDE_CODE_MAX_TURNS=100",
    "NORDRELAY_PEER_ENABLED=false",
    "NORDRELAY_PEER_HOST=127.0.0.1",
    "NORDRELAY_PEER_PORT=31979",
    "NORDRELAY_PEER_TLS_ENABLED=true",
    "NORDRELAY_PEER_REQUIRE_TLS=true",
    `NORDRELAY_STATE_BACKEND=${stateBackend === "sqlite" ? "sqlite" : "json"}`,
    "TELEGRAM_TRANSPORT=polling",
    "TELEGRAM_AUTO_SEND_ARTIFACTS=false",
    "",
  ];

  await fsp.writeFile(envPath, lines.join("\n"), { mode: 0o600 });
  await fsp.chmod(envPath, 0o600).catch(() => {});
  userStore.createAdmin({
    email: adminEmail,
    displayName: adminName || adminEmail,
    password: adminPassword,
    telegramUserId: telegramUserId ? Number(telegramUserId) : undefined,
    discordUserId: discordUserId || undefined,
    slackUserId: slackUserId || undefined,
    slackTeamId: slackTeamId || undefined,
    matrixUserId: linkedMatrixUserId || undefined,
    matrixHomeserver: linkedMatrixHomeserver || undefined,
  });
  console.log(`Wrote ${envPath}`);
  console.log(`Created admin user ${adminEmail}.`);
  console.log("Run `nordrelay doctor` to validate the setup.");
}

async function createUserStore(home) {
  const modulePath = path.join(RUNTIME_ROOT, "dist", "access", "user-management.js");
  if (!fs.existsSync(modulePath)) {
    throw new Error(`Missing user management runtime. Run \`npm run build\` in ${RUNTIME_ROOT}.`);
  }
  const mod = await import(pathToFileURL(modulePath).href);
  return new mod.UserStore(home);
}

async function peerModules() {
  const required = [
    "peer-store.js",
    "peer-identity.js",
    "peer-client.js",
  ];
  for (const file of required) {
    const modulePath = path.join(RUNTIME_ROOT, "dist", "peers", file);
    if (!fs.existsSync(modulePath)) {
      throw new Error(`Missing peer runtime. Run \`npm run build\` in ${RUNTIME_ROOT}.`);
    }
  }
  const [store, identity, client] = await Promise.all(required.map((file) => import(pathToFileURL(path.join(RUNTIME_ROOT, "dist", "peers", file)).href)));
  return { store, identity, client };
}

function parsePeerFlags(argv) {
  const copy = [...argv];
  const subcommand = copy[0] && !copy[0].startsWith("-") ? copy.shift() : "list";
  const flags = { subcommand, url: undefined };
  if (["add", "test", "check", "revoke", "trust", "rotate"].includes(subcommand) && copy[0] && !copy[0].startsWith("-")) {
    flags.url = copy.shift();
    flags.id = flags.url;
  }
  for (let i = 0; i < copy.length; i += 1) {
    const arg = copy[i];
    if (arg === "--name") flags.name = requireValue(copy, ++i, arg);
    else if (arg === "--code") flags.code = requireValue(copy, ++i, arg);
    else if (arg === "--expect-fingerprint") flags.expectFingerprint = requireValue(copy, ++i, arg);
    else if (arg === "--public-url") flags.publicUrl = requireValue(copy, ++i, arg);
    else if (arg === "--expires" || arg === "--expires-minutes") flags.expiresMinutes = Number.parseInt(requireValue(copy, ++i, arg), 10);
    else if (arg === "--scopes") flags.scopes = requireValue(copy, ++i, arg);
    else if (arg === "--agents") flags.agents = requireValue(copy, ++i, arg);
    else if (arg === "--workspaces") flags.workspaces = requireValue(copy, ++i, arg);
    else if (arg === "--workspace-aliases" || arg === "--aliases") flags.workspaceAliases = requireValue(copy, ++i, arg);
  }
  return flags;
}

function csv(value) {
  return value ? value.split(",").map((item) => item.trim()).filter(Boolean) : undefined;
}

function aliasMap(value) {
  if (!value) return undefined;
  return Object.fromEntries(value.split(",").map((item) => item.split("=", 2).map((part) => part.trim())).filter(([alias, workspace]) => alias && workspace));
}

async function commandPeer(options) {
  await mkdirp(options.home);
  loadEnvFiles(options.home);
  const flags = parsePeerFlags(options.rawFlags);
  const { store: storeMod, identity: identityMod, client: clientMod } = await peerModules();
  const store = new storeMod.PeerStore(options.home);
  const identity = identityMod.loadOrCreatePeerIdentity(options.home, process.env.NORDRELAY_PEER_NAME);

  if (flags.subcommand === "identity") {
    console.log(`Node ID: ${identity.public.nodeId}`);
    console.log(`Name: ${identity.public.name}`);
    console.log(`Fingerprint: ${identity.public.fingerprint}`);
    console.log(`Created: ${identity.public.createdAt}`);
    return;
  }

  if (flags.subcommand === "list") {
    const peers = store.listPublic();
    if (peers.length === 0) {
      console.log("No peers configured.");
      console.log("Create an invite with `nordrelay peer invite` or add a peer with `nordrelay peer add <url> --code <code>`.");
      return;
    }
    for (const peer of peers) {
      console.log(`${peer.id} ${peer.enabled ? "enabled" : "disabled"} ${peer.name}`);
      console.log(`  URL: ${peer.url || "-"}`);
      console.log(`  Node: ${peer.nodeId} ${peer.fingerprint}`);
      console.log(`  Direction: ${peer.direction}`);
      console.log(`  Scopes: ${peer.scopes.join(",") || "-"}`);
      console.log(`  Agents: ${peer.allowedAgents.join(",") || "all"}`);
      const aliases = Object.entries(peer.workspaceAliases || {}).map(([alias, workspace]) => `${alias}=${workspace}`).join(",");
      if (aliases) console.log(`  Workspace aliases: ${aliases}`);
      if (peer.lastSeenAt) console.log(`  Last seen: ${peer.lastSeenAt}`);
      if (peer.lastLatencyMs !== undefined) console.log(`  Latency: ${peer.lastLatencyMs}ms`);
      if (peer.remoteVersion) console.log(`  Remote version: ${peer.remoteVersion}`);
      if (peer.trustStatus) console.log(`  Trust: ${peer.trustStatus}${peer.trustWarnings?.length ? ` (${peer.trustWarnings.join("; ")})` : ""}`);
      if (peer.lastError) console.log(`  Last error: ${peer.lastError}`);
    }
    return;
  }

  if (flags.subcommand === "invite") {
    const url = process.env.NORDRELAY_PEER_PUBLIC_URL || `${process.env.NORDRELAY_PEER_TLS_ENABLED === "false" ? "http" : "https"}://${process.env.NORDRELAY_PEER_HOST || "127.0.0.1"}:${process.env.NORDRELAY_PEER_PORT || "31979"}`;
    const peerEnabled = process.env.NORDRELAY_PEER_ENABLED === "true";
    if (!peerEnabled) {
      console.log("Warning: peer server is disabled. The invite can be created, but pairing will fail until NORDRELAY_PEER_ENABLED=true and NordRelay is restarted.");
    } else {
      const probe = await clientMod.checkPeerEndpoint(url, { timeoutMs: 2500 });
      if (!probe.ok) {
        console.log(`Warning: peer endpoint is not reachable from this machine: ${probe.detail}`);
      }
    }
    const created = store.createInvitation({
      name: flags.name,
      expiresInMs: Number.isFinite(flags.expiresMinutes) ? flags.expiresMinutes * 60 * 1000 : undefined,
      scopes: csv(flags.scopes),
      allowedAgents: csv(flags.agents),
      allowedWorkspaceRoots: csv(flags.workspaces),
      workspaceAliases: aliasMap(flags.workspaceAliases),
    });
    console.log(`Pairing code: ${created.code}`);
    console.log(`Expires: ${created.invitation.expiresAt}`);
    console.log(`Fingerprint: ${identity.public.fingerprint}`);
    console.log(`Command: nordrelay peer add ${url} --code ${created.code}`);
    return;
  }

  if (flags.subcommand === "add") {
    const url = flags.url || await ask(null, "Peer URL", "");
    const code = flags.code || await ask(null, "Pairing code", "");
    const configuredPublicUrl = process.env.NORDRELAY_PEER_ENABLED === "true" ? process.env.NORDRELAY_PEER_PUBLIC_URL : undefined;
    const publicUrl = flags.publicUrl || configuredPublicUrl;
    const result = await clientMod.pairPeer({
      url,
      code,
      name: flags.name,
      publicUrl,
    }, identity, store);
    console.log(`Added peer ${result.peer.name} (${result.peer.id}).`);
    console.log(`Node: ${result.peer.nodeId}`);
    console.log(`Fingerprint: ${result.peer.fingerprint}`);
    if (result.tlsFingerprint) console.log(`TLS fingerprint: ${result.tlsFingerprint}`);
    if (publicUrl) console.log(`Shared public URL: ${publicUrl}`);
    return;
  }

  if (flags.subcommand === "test") {
    const id = flags.id || await ask(null, "Peer id", "");
    const response = await new clientMod.RemoteRelayClient(store).rpc(id, "peer.ping");
    console.log(`Peer ${id} ok: ${JSON.stringify(response)}`);
    return;
  }

  if (flags.subcommand === "check") {
    const url = flags.url || await ask(null, "Peer URL", "");
    const probe = await clientMod.checkPeerEndpoint(url, { expectedTlsFingerprint: flags.expectFingerprint });
    console.log(`Peer endpoint: ${probe.url}`);
    console.log(`Status: ${probe.ok ? "reachable" : "unreachable"}`);
    if (probe.latencyMs !== undefined) console.log(`Latency: ${probe.latencyMs}ms`);
    if (probe.statusCode !== undefined) console.log(`HTTP status: ${probe.statusCode}`);
    if (probe.tlsFingerprint) console.log(`TLS fingerprint: ${probe.tlsFingerprint}`);
    console.log(`Detail: ${probe.detail}`);
    if (!probe.ok) process.exitCode = 1;
    return;
  }

  if (flags.subcommand === "revoke") {
    const id = flags.id || await ask(null, "Peer id", "");
    console.log(store.revokePeer(id) ? `Revoked peer ${id}.` : `Peer not found: ${id}`);
    return;
  }

  if (flags.subcommand === "trust") {
    const id = flags.id || await ask(null, "Peer id", "");
    const peer = store.get(id);
    if (!peer?.url) throw new Error("Peer URL is required before TLS trust can be updated.");
    const probe = await clientMod.checkPeerIdentityEndpoint(peer.url, { timeoutMs: 5000 });
    if (!probe.ok || !probe.identity) throw new Error(`Peer identity could not be verified: ${probe.detail}`);
    if (probe.identity.nodeId !== peer.nodeId || probe.identity.publicKey !== peer.publicKey || probe.identity.fingerprint !== peer.fingerprint) {
      throw new Error("Peer identity changed. Re-pair this peer instead of trusting the TLS fingerprint.");
    }
    const updated = store.updatePeerTlsFingerprint(peer.id, probe.tlsFingerprint);
    console.log(`Trusted TLS fingerprint for ${updated.name}: ${updated.tlsFingerprint || "-"}`);
    return;
  }

  if (flags.subcommand === "rotate") {
    const id = flags.id || await ask(null, "Peer id", "");
    const url = process.env.NORDRELAY_PEER_PUBLIC_URL || `${process.env.NORDRELAY_PEER_TLS_ENABLED === "false" ? "http" : "https"}://${process.env.NORDRELAY_PEER_HOST || "127.0.0.1"}:${process.env.NORDRELAY_PEER_PORT || "31979"}`;
    const created = store.createRotationInvitation(id, { expiresInMs: Number.isFinite(flags.expiresMinutes) ? flags.expiresMinutes * 60 * 1000 : undefined });
    console.log(`Rotation invite for ${created.peer.name} (${created.peer.id}).`);
    console.log(`Pairing code: ${created.code}`);
    console.log(`Expires: ${created.invitation.expiresAt}`);
    console.log(`Command: nordrelay peer add ${url} --code ${created.code}`);
    return;
  }

  throw new Error("Usage: nordrelay peer [identity|list|invite|add|test|check|trust|rotate|revoke]");
}

async function commandService(options) {
  await mkdirp(options.home);
  loadEnvFiles(options.home);
  warnIfCliPathMissing();
  const flags = parseServiceFlags(options.rawFlags);
  const specOptions = { ...options, scriptPath: SCRIPT_PATH };

  if (flags.subcommand === "install") {
    if (flags.dryRun) {
      printServiceInstallDryRun(specOptions, flags);
      return;
    }
    if (flags.platform === "darwin") {
      await installLaunchdService(specOptions, flags);
      return;
    }
    if (flags.platform === "win32") {
      await installWindowsTask(specOptions, flags);
      return;
    }
    await installSystemdUserService(specOptions, flags);
    return;
  }

  if (flags.subcommand === "uninstall" || flags.subcommand === "remove") {
    if (flags.platform === "darwin") {
      await uninstallLaunchdService(flags);
      return;
    }
    if (flags.platform === "win32") {
      await uninstallWindowsTask(flags);
      return;
    }
    await uninstallSystemdUserService(flags);
    return;
  }

  if (flags.subcommand === "status") {
    await commandServiceStatus(flags);
    return;
  }

  throw new Error("Usage: nordrelay service [install|uninstall|status] [--no-start] [--name <name>] [--label <label>]");
}

async function installSystemdUserService(options, flags) {
  const spec = buildSystemdUserServiceSpec(options, flags);
  const unitDir = path.dirname(spec.path);
  const unitPath = spec.path;
  await mkdirp(unitDir);
  await fsp.writeFile(unitPath, spec.content);
  console.log(`Installed systemd user service: ${unitPath}`);
  for (const command of spec.commands) {
    runPlatformCommand(command.command, command.args, command.label, command.settings);
  }
  console.log(`Status: nordrelay service status`);
}

async function uninstallSystemdUserService(flags) {
  runPlatformCommand("systemctl", ["--user", "disable", "--now", `${flags.name}.service`], `Disable ${flags.name}.service`);
  const unitPath = path.join(os.homedir(), ".config", "systemd", "user", `${flags.name}.service`);
  await fsp.rm(unitPath, { force: true });
  runPlatformCommand("systemctl", ["--user", "daemon-reload"], "Reload systemd user units");
  console.log(`Removed systemd user service: ${unitPath}`);
}

async function installLaunchdService(options, flags) {
  const spec = buildLaunchdServiceSpec(options, flags);
  const launchAgentsDir = path.dirname(spec.path);
  const plistPath = spec.path;
  await mkdirp(launchAgentsDir);
  await fsp.writeFile(plistPath, spec.content);
  console.log(`Installed launchd service: ${plistPath}`);
  for (const command of spec.commands) {
    runPlatformCommand(command.command, command.args, command.label, command.settings);
  }
  if (!flags.start) {
    const domain = launchdDomain();
    console.log(`Start later with: launchctl bootstrap ${domain} ${plistPath}`);
  }
}

async function uninstallLaunchdService(flags) {
  const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${flags.label}.plist`);
  const domain = `gui/${process.getuid?.() ?? ""}`;
  runPlatformCommand("launchctl", ["bootout", domain, plistPath], `Unload ${flags.label}`, { allowFailure: true });
  await fsp.rm(plistPath, { force: true });
  console.log(`Removed launchd service: ${plistPath}`);
}

async function installWindowsTask(options, flags) {
  const spec = buildWindowsTaskServiceSpec(options, flags);
  for (const command of spec.commands) {
    runPlatformCommand(command.command, command.args, command.label, command.settings);
  }
  console.log(`Installed Windows task: ${flags.name}`);
}

async function uninstallWindowsTask(flags) {
  runPlatformCommand("schtasks", ["/Delete", "/F", "/TN", flags.name], `Delete Windows task ${flags.name}`, { allowFailure: true });
  console.log(`Removed Windows task: ${flags.name}`);
}

async function commandServiceStatus(flags) {
  if (process.platform === "darwin") {
    const domain = `gui/${process.getuid?.() ?? ""}`;
    runPlatformCommand("launchctl", ["print", `${domain}/${flags.label}`], `launchd status ${flags.label}`, { allowFailure: true });
    return;
  }
  if (process.platform === "win32") {
    runPlatformCommand("schtasks", ["/Query", "/TN", flags.name], `Windows task status ${flags.name}`, { allowFailure: true });
    return;
  }
  runPlatformCommand("systemctl", ["--user", "status", `${flags.name}.service`, "--no-pager"], `systemd user status ${flags.name}.service`, { allowFailure: true });
}

function printServiceInstallDryRun(options, flags) {
  const spec = serviceInstallSpec(options, flags);
  console.log(`Service install dry-run (${spec.platform})`);
  console.log(`Target: ${spec.path}`);
  if (spec.content) {
    console.log("--- file content ---");
    console.log(spec.content.trimEnd());
  }
  console.log("--- commands ---");
  for (const command of spec.commands) {
    console.log(formatCommand(command.command, command.args));
  }
}

function launchdDomain() {
  return `gui/${process.getuid?.() ?? ""}`;
}

function runPlatformCommand(command, args, label, settings = {}) {
  const resolved = findExecutable(command);
  if (!resolved) {
    console.log(`${label}: ${command} not found. Run this step manually if this platform service manager is available.`);
    return false;
  }
  const useShell = isWindowsShellScript(resolved);
  console.log(`${label}: ${formatCommand(resolved, args)}`);
  const result = spawnSync(useShell ? formatShellCommand(resolved, args) : resolved, useShell ? [] : args, {
    cwd: RUNTIME_ROOT,
    env: process.env,
    shell: useShell,
    stdio: "inherit",
    windowsHide: false,
  });
  if (result.status !== 0 && !settings.allowFailure) {
    throw new Error(`${label} failed with exit code ${result.status ?? "unknown"}`);
  }
  return result.status === 0;
}

function parseUserFlags(argv) {
  const copy = [...argv];
  const subcommand = copy[0] && !copy[0].startsWith("-") ? copy.shift() : "list";
  const flags = { subcommand };
  for (let i = 0; i < copy.length; i += 1) {
    const arg = copy[i];
    if (arg === "--email") flags.email = requireValue(copy, ++i, arg);
    else if (arg === "--name") flags.name = requireValue(copy, ++i, arg);
    else if (arg === "--password") flags.password = requireValue(copy, ++i, arg);
    else if (arg === "--group" || arg === "--groups") flags.groups = requireValue(copy, ++i, arg);
    else if (arg === "--telegram-user-id") flags.telegramUserId = Number.parseInt(requireValue(copy, ++i, arg), 10);
    else if (arg === "--discord-user-id") flags.discordUserId = requireValue(copy, ++i, arg);
    else if (arg === "--slack-user-id") flags.slackUserId = requireValue(copy, ++i, arg);
    else if (arg === "--slack-team-id") flags.slackTeamId = requireValue(copy, ++i, arg);
    else if (arg === "--matrix-user-id") flags.matrixUserId = requireValue(copy, ++i, arg);
    else if (arg === "--matrix-homeserver") flags.matrixHomeserver = requireValue(copy, ++i, arg);
    else if (arg === "--user-id") flags.userId = requireValue(copy, ++i, arg);
  }
  return flags;
}

async function commandUser(options) {
  await mkdirp(options.home);
  loadEnvFiles(options.home);
  const store = await createUserStore(options.home);
  const flags = parseUserFlags(options.rawFlags);
  if (flags.subcommand === "list") {
    const snapshot = store.snapshot();
    if (snapshot.users.length === 0) {
      console.log("No users configured.");
      console.log("Create the first admin with `nordrelay user create-admin --email you@example.com --name YourName`.");
      return;
    }
    for (const user of snapshot.users) {
      console.log(`${user.email} (${user.displayName}) ${user.active ? "active" : "disabled"} groups=${user.groups.map((group) => group.id).join(",") || "-"}`);
    }
    return;
  }

  if (flags.subcommand === "create-admin" || flags.subcommand === "create") {
    const email = flags.email || await ask(null, "Email", "");
    const name = flags.name || await ask(null, "Display name", email);
    const password = flags.password || await askSecret(null, "Password", "");
    const groupIds = flags.subcommand === "create-admin"
      ? ["admin"]
      : (flags.groups ? flags.groups.split(",").map((item) => item.trim()).filter(Boolean) : ["user"]);
    const created = flags.subcommand === "create-admin"
      ? store.createAdmin({ email, displayName: name, password, telegramUserId: flags.telegramUserId, discordUserId: flags.discordUserId, slackUserId: flags.slackUserId, slackTeamId: flags.slackTeamId, matrixUserId: flags.matrixUserId, matrixHomeserver: flags.matrixHomeserver })
      : store.createUser({ email, displayName: name, password, groupIds, telegramUserId: flags.telegramUserId, discordUserId: flags.discordUserId, slackUserId: flags.slackUserId, slackTeamId: flags.slackTeamId, matrixUserId: flags.matrixUserId, matrixHomeserver: flags.matrixHomeserver });
    console.log(`Created user ${created.user.email} (${created.groups.map((group) => group.name).join(", ")}).`);
    return;
  }

  if (flags.subcommand === "reset-password") {
    const email = flags.email || await ask(null, "Email", "");
    const password = flags.password || await askSecret(null, "New password", "");
    const user = store.getUserByEmail(email);
    if (!user) throw new Error(`User not found: ${email}`);
    store.setPassword(user.user.id, password);
    console.log(`Password updated for ${user.user.email}.`);
    return;
  }

  if (flags.subcommand === "link-telegram") {
    const email = flags.email || await ask(null, "Email", "");
    const telegramUserId = flags.telegramUserId || Number.parseInt(await ask(null, "Telegram user id", ""), 10);
    const user = store.getUserByEmail(email);
    if (!user) throw new Error(`User not found: ${email}`);
    store.linkTelegramUser(user.user.id, { telegramUserId });
    console.log(`Linked Telegram user ${telegramUserId} to ${user.user.email}.`);
    return;
  }

  if (flags.subcommand === "link-discord") {
    const email = flags.email || await ask(null, "Email", "");
    const discordUserId = flags.discordUserId || await ask(null, "Discord user id", "");
    const user = store.getUserByEmail(email);
    if (!user) throw new Error(`User not found: ${email}`);
    store.linkDiscordUser(user.user.id, { discordUserId });
    console.log(`Linked Discord user ${discordUserId} to ${user.user.email}.`);
    return;
  }

  if (flags.subcommand === "link-slack") {
    const email = flags.email || await ask(null, "Email", "");
    const slackUserId = flags.slackUserId || await ask(null, "Slack user id", "");
    const teamId = flags.slackTeamId || await ask(null, "Slack team id (optional)", "");
    const user = store.getUserByEmail(email);
    if (!user) throw new Error(`User not found: ${email}`);
    store.linkSlackUser(user.user.id, { slackUserId, teamId: teamId || undefined });
    console.log(`Linked Slack user ${slackUserId} to ${user.user.email}.`);
    return;
  }

  if (flags.subcommand === "link-matrix") {
    const email = flags.email || await ask(null, "Email", "");
    const matrixUserId = flags.matrixUserId || await ask(null, "Matrix user id", "");
    const homeserver = flags.matrixHomeserver || await ask(null, "Matrix homeserver (optional)", "");
    const user = store.getUserByEmail(email);
    if (!user) throw new Error(`User not found: ${email}`);
    store.linkMatrixUser(user.user.id, { matrixUserId, homeserver: homeserver || undefined });
    console.log(`Linked Matrix user ${matrixUserId} to ${user.user.email}.`);
    return;
  }

  if (flags.subcommand === "link-code" || flags.subcommand === "telegram-link-code") {
    const email = flags.email || await ask(null, "Email", "");
    const user = store.getUserByEmail(email);
    if (!user) throw new Error(`User not found: ${email}`);
    const code = store.createTelegramLinkCode(user.user.id);
    console.log(`Telegram link code for ${user.user.email}: ${code.code}`);
    console.log(`Expires: ${code.expiresAt}`);
    return;
  }

  if (flags.subcommand === "discord-link-code") {
    const email = flags.email || await ask(null, "Email", "");
    const user = store.getUserByEmail(email);
    if (!user) throw new Error(`User not found: ${email}`);
    const code = store.createDiscordLinkCode(user.user.id);
    console.log(`Discord link code for ${user.user.email}: ${code.code}`);
    console.log(`Expires: ${code.expiresAt}`);
    return;
  }

  if (flags.subcommand === "slack-link-code") {
    const email = flags.email || await ask(null, "Email", "");
    const user = store.getUserByEmail(email);
    if (!user) throw new Error(`User not found: ${email}`);
    const code = store.createSlackLinkCode(user.user.id);
    console.log(`Slack link code for ${user.user.email}: ${code.code}`);
    console.log(`Expires: ${code.expiresAt}`);
    return;
  }

  if (flags.subcommand === "matrix-link-code") {
    const email = flags.email || await ask(null, "Email", "");
    const user = store.getUserByEmail(email);
    if (!user) throw new Error(`User not found: ${email}`);
    const code = store.createMatrixLinkCode(user.user.id);
    console.log(`Matrix link code for ${user.user.email}: ${code.code}`);
    console.log(`Expires: ${code.expiresAt}`);
    return;
  }

  throw new Error("Usage: nordrelay user [list|create-admin|create|reset-password|link-telegram|link-discord|link-slack|link-matrix|link-code|telegram-link-code|discord-link-code|slack-link-code|matrix-link-code]");
}

async function commandDoctor(options) {
  await mkdirp(options.home);
  loadEnvFiles(options.home);
  const userStore = await createUserStore(options.home).catch(() => null);
  const userSnapshot = userStore?.snapshot();
  const checks = [];
  checks.push(check("Node.js >= 22", Number.parseInt(process.versions.node.split(".")[0], 10) >= 22, process.version));
  const cliPath = cliPathDiagnostics();
  const cliPathFix = cliPath.globalBin ? pathFix(cliPath.globalBin) : hintFix(cliPath.hint);
  checks.push(check("NordRelay CLI on PATH", cliPath.ok, cliPath.ok ? cliPath.detail : `${cliPath.detail}; ${cliPath.hint}`, "warn", cliPathFix));
  if (cliPath.globalBin) {
    checks.push(check("npm global bin on PATH", cliPath.pathContainsGlobalBin, cliPath.globalBin, "warn", pathFix(cliPath.globalBin)));
  }
  const webUiEnabled = isWebUiEnabled();
  const telegramRequested = process.env.TELEGRAM_ENABLED !== "false";
  const discordRequested = process.env.DISCORD_ENABLED === "true";
  const slackRequested = process.env.SLACK_ENABLED === "true";
  const matrixRequested = process.env.MATRIX_ENABLED === "true";
  const slackSocketMode = process.env.SLACK_SOCKET_MODE !== "false";
  const telegramUsable = telegramRequested && Boolean(process.env.TELEGRAM_BOT_TOKEN);
  const discordUsable = discordRequested && Boolean(process.env.DISCORD_BOT_TOKEN);
  const slackUsable = slackRequested && Boolean(process.env.SLACK_BOT_TOKEN) && (slackSocketMode ? Boolean(process.env.SLACK_APP_TOKEN) : Boolean(process.env.SLACK_SIGNING_SECRET));
  const matrixUsable = matrixRequested && Boolean(process.env.MATRIX_HOMESERVER_URL) && Boolean(process.env.MATRIX_ACCESS_TOKEN) && Boolean(process.env.MATRIX_USER_ID);
  checks.push(check(
    "WebUI enabled",
    webUiEnabled,
    webUiEnabled ? "enabled" : "disabled by NORDRELAY_WEBUI_ENABLED=false",
    "warn",
    envValueFix(options.home, "NORDRELAY_WEBUI_ENABLED", "true", "Enable the WebUI in the local env file."),
  ));
  checks.push(check(
    "Telegram bot token",
    !telegramRequested || telegramUsable,
    telegramRequested ? (telegramUsable ? "configured" : "missing; Telegram adapter will be disabled") : "disabled",
    "warn",
  ));
  checks.push(check(
    "Discord bot token",
    !discordRequested || discordUsable,
    discordRequested ? (discordUsable ? "configured" : "missing; Discord adapter will be disabled") : "disabled",
    "warn",
  ));
  checks.push(check(
    "Slack bot token",
    !slackRequested || Boolean(process.env.SLACK_BOT_TOKEN),
    slackRequested ? (process.env.SLACK_BOT_TOKEN ? "configured" : "missing; Slack adapter will be disabled") : "disabled",
    "warn",
  ));
  checks.push(check(
    slackSocketMode ? "Slack app token" : "Slack signing secret",
    !slackRequested || slackUsable,
    slackRequested ? (slackUsable ? "configured" : `missing; ${slackSocketMode ? "Socket Mode requires SLACK_APP_TOKEN" : "HTTP mode requires SLACK_SIGNING_SECRET"}`) : "disabled",
    "warn",
  ));
  checks.push(check(
    "Matrix credentials",
    !matrixRequested || matrixUsable,
    matrixRequested ? (matrixUsable ? "configured" : "missing; Matrix adapter will be disabled") : "disabled",
    "warn",
  ));
  checks.push(check(
    "Usable access surface",
    webUiEnabled || telegramUsable || discordUsable || slackUsable || matrixUsable,
    [webUiEnabled ? "WebUI" : "", telegramUsable ? "Telegram" : "", discordUsable ? "Discord" : "", slackUsable ? "Slack" : "", matrixUsable ? "Matrix" : ""].filter(Boolean).join(" and ") || "none",
    "fail",
    envValueFix(options.home, "NORDRELAY_WEBUI_ENABLED", "true", "Enable WebUI so at least one access surface is available."),
  ));
  checks.push(check("Discord client ID", !discordUsable || Boolean(process.env.DISCORD_CLIENT_ID), discordUsable ? (process.env.DISCORD_CLIENT_ID ? "configured" : "missing; slash command auto-registration disabled") : "disabled", "warn", hintFix("Set DISCORD_CLIENT_ID from the Discord Developer Portal.")));
  checks.push(check("User store", Boolean(userStore), userStore ? userStore.filePath : "missing runtime", userStore ? "pass" : "fail", runtimeBuildFix()));
  checks.push(check("Admin user", Boolean(userSnapshot?.adminConfigured), userSnapshot?.adminConfigured ? "configured" : "missing", "fail", hintFix("Run `nordrelay user create-admin` to create the first admin.")));
  checks.push(check("WebUI login", true, "required for every dashboard request"));
  checks.push(check("Telegram access", true, "requires linked active users and enabled group chats"));
  checks.push(check("Discord access", true, "requires linked active users and enabled channels"));
  checks.push(check("Slack access", true, "requires linked active users and enabled channels"));
  checks.push(check("Matrix access", true, "requires linked active users and enabled rooms"));
  const peerEnabled = process.env.NORDRELAY_PEER_ENABLED === "true";
  const peerTlsEnabled = process.env.NORDRELAY_PEER_TLS_ENABLED !== "false";
  const peerHost = process.env.NORDRELAY_PEER_HOST || "127.0.0.1";
  checks.push(check("Peer server", peerEnabled, peerEnabled ? `${peerHost}:${process.env.NORDRELAY_PEER_PORT || "31979"}` : "disabled", "warn"));
  checks.push(check("Peer TLS", !peerEnabled || peerTlsEnabled || isLoopbackName(peerHost), peerTlsEnabled ? "enabled" : "plaintext loopback only", peerEnabled ? "fail" : "warn", envValueFix(options.home, "NORDRELAY_PEER_TLS_ENABLED", "true", "Enable TLS for non-loopback peer traffic.")));
  checks.push(check("Codex enabled flag", process.env.NORDRELAY_CODEX_ENABLED !== "false", `NORDRELAY_CODEX_ENABLED=${process.env.NORDRELAY_CODEX_ENABLED ?? "true"}`));
  checks.push(check("Pi enabled flag", process.env.NORDRELAY_PI_ENABLED === "true" || process.env.NORDRELAY_PI_ENABLED === undefined, `NORDRELAY_PI_ENABLED=${process.env.NORDRELAY_PI_ENABLED ?? "false"}`, process.env.NORDRELAY_PI_ENABLED === "true" ? "pass" : "warn"));
  checks.push(check("Hermes enabled flag", process.env.NORDRELAY_HERMES_ENABLED === "true", `NORDRELAY_HERMES_ENABLED=${process.env.NORDRELAY_HERMES_ENABLED ?? "false"}`, process.env.NORDRELAY_HERMES_ENABLED === "true" ? "pass" : "warn"));
  checks.push(check("OpenClaw enabled flag", process.env.NORDRELAY_OPENCLAW_ENABLED === "true", `NORDRELAY_OPENCLAW_ENABLED=${process.env.NORDRELAY_OPENCLAW_ENABLED ?? "false"}`, process.env.NORDRELAY_OPENCLAW_ENABLED === "true" ? "pass" : "warn"));
  checks.push(check("Claude Code enabled flag", process.env.NORDRELAY_CLAUDE_CODE_ENABLED === "true", `NORDRELAY_CLAUDE_CODE_ENABLED=${process.env.NORDRELAY_CLAUDE_CODE_ENABLED ?? "false"}`, process.env.NORDRELAY_CLAUDE_CODE_ENABLED === "true" ? "pass" : "warn"));
  checks.push(check("Codex CLI", Boolean(findExecutable(process.env.CODEX_CLI_PATH || "codex")), process.env.CODEX_CLI_PATH || findExecutable("codex") || "not found", process.env.NORDRELAY_CODEX_ENABLED === "false" ? "warn" : "fail", hintFix("Install Codex CLI or set CODEX_CLI_PATH to its executable.")));
  checks.push(check("Pi CLI", Boolean(findExecutable(process.env.PI_CLI_PATH || "pi")), process.env.PI_CLI_PATH || findExecutable("pi") || "not found", process.env.NORDRELAY_PI_ENABLED === "true" ? "fail" : "warn", hintFix("Install Pi CLI or set PI_CLI_PATH to its executable.")));
  checks.push(check("Hermes CLI", Boolean(findExecutable(process.env.HERMES_CLI_PATH || "hermes")), process.env.HERMES_CLI_PATH || findExecutable("hermes") || "not found", process.env.NORDRELAY_HERMES_ENABLED === "true" ? "fail" : "warn", hintFix("Install Hermes CLI or set HERMES_CLI_PATH to its executable.")));
  checks.push(check("OpenClaw CLI", Boolean(findExecutable(process.env.OPENCLAW_CLI_PATH || "openclaw")), process.env.OPENCLAW_CLI_PATH || findExecutable("openclaw") || "not found", process.env.NORDRELAY_OPENCLAW_ENABLED === "true" ? "fail" : "warn", hintFix("Install OpenClaw CLI or set OPENCLAW_CLI_PATH to its executable.")));
  checks.push(check("Claude Code CLI", Boolean(findExecutable(process.env.CLAUDE_CODE_CLI_PATH || "claude")), process.env.CLAUDE_CODE_CLI_PATH || findExecutable("claude") || "SDK bundled runtime", "warn", hintFix("Install Claude Code CLI or set CLAUDE_CODE_CLI_PATH to its executable.")));
  const hermesApiCheck = await checkHermesApiServer();
  checks.push(check("Hermes API Server", hermesApiCheck.ok, hermesApiCheck.detail, process.env.NORDRELAY_HERMES_ENABLED === "true" ? "fail" : "warn"));
  const openClawGatewayCheck = await checkOpenClawGateway();
  checks.push(check("OpenClaw Gateway", openClawGatewayCheck.ok, openClawGatewayCheck.detail, process.env.NORDRELAY_OPENCLAW_ENABLED === "true" ? "fail" : "warn"));
  checks.push(check("ffmpeg", Boolean(findExecutable("ffmpeg")), findExecutable("ffmpeg") || "not found", "warn", hintFix("Install ffmpeg with your OS package manager to enable voice conversion.")));
  const stateBackendCheck = validateStateBackend();
  checks.push(check("State backend", stateBackendCheck.ok, stateBackendCheck.detail, "fail", hintFix("Use NORDRELAY_STATE_BACKEND=json or install/rebuild better-sqlite3 for sqlite.")));
  checks.push(check("Runtime entry", Boolean(await resolveRuntimeEntry()), RUNTIME_ROOT, "fail", runtimeBuildFix()));

  for (const item of checks) {
    console.log(`${item.icon} ${item.name}: ${item.detail}`);
    if (!item.ok && item.fix?.summary) console.log(`   Fix: ${item.fix.summary}`);
  }

  const failed = checks.filter((item) => item.status === "fail" && !item.ok);
  const warned = checks.filter((item) => item.status === "warn" && !item.ok);
  console.log(`\nSummary: ${failed.length} failed, ${warned.length} warnings.`);
  if (options.fix) {
    await runDoctorFixes(checks);
  } else if ([...failed, ...warned].some((item) => item.fix?.apply)) {
    console.log("Run `nordrelay doctor --fix` to apply safe local fixes.");
  }
  if (failed.length > 0) process.exitCode = 1;
}

async function checkHermesApiServer() {
  const baseUrl = (process.env.HERMES_API_BASE_URL || "http://127.0.0.1:8642").replace(/\/+$/, "");
  const headers = process.env.HERMES_API_KEY ? { authorization: `Bearer ${process.env.HERMES_API_KEY}` } : {};
  try {
    const response = await fetch(`${baseUrl}/health`, { headers, signal: AbortSignal.timeout(2000) });
    return {
      ok: response.ok,
      detail: response.ok ? `${baseUrl}/health ok` : `${baseUrl}/health HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      ok: false,
      detail: `${baseUrl}/health failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function checkOpenClawGateway() {
  const gatewayUrl = process.env.OPENCLAW_GATEWAY_URL || "ws://127.0.0.1:18789";
  const WebSocketClass = globalThis.WebSocket;
  if (!WebSocketClass) {
    return { ok: false, detail: "Node.js WebSocket runtime is unavailable" };
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        socket.close();
      } catch {
        // Ignore close errors during diagnostics.
      }
      resolve(value);
    };
    const timeout = setTimeout(() => {
      finish({ ok: false, detail: `${gatewayUrl} timed out` });
    }, 2000);
    timeout.unref?.();

    let socket;
    try {
      socket = new WebSocketClass(gatewayUrl);
    } catch (error) {
      clearTimeout(timeout);
      resolve({ ok: false, detail: `${gatewayUrl} failed: ${error instanceof Error ? error.message : String(error)}` });
      return;
    }

    socket.addEventListener("open", () => {
      const auth = {};
      if (process.env.OPENCLAW_GATEWAY_TOKEN) auth.token = process.env.OPENCLAW_GATEWAY_TOKEN;
      if (process.env.OPENCLAW_GATEWAY_PASSWORD) auth.password = process.env.OPENCLAW_GATEWAY_PASSWORD;
      const params = {
        client: { name: "NordRelay doctor", deviceFamily: "nordrelay" },
        role: "operator",
        subscribe: ["health"],
      };
      if (Object.keys(auth).length > 0) params.auth = auth;
      socket.send(JSON.stringify({ type: "connect", id: "doctor", params }));
    }, { once: true });
    socket.addEventListener("message", () => {
      finish({ ok: true, detail: `${gatewayUrl} reachable` });
    }, { once: true });
    socket.addEventListener("error", () => {
      finish({ ok: false, detail: `${gatewayUrl} failed` });
    }, { once: true });
  });
}

async function commandWeb(options) {
  await mkdirp(options.home);
  loadEnvFiles(options.home);
  if (!isWebUiEnabled()) {
    throw new Error("WebUI is disabled by NORDRELAY_WEBUI_ENABLED=false. Set it to true or rerun `nordrelay init --force` to enable the dashboard.");
  }
  warnIfCliPathMissing();
  await prepareRuntimeForLaunch(options);
  await ensureConnectorStartedForWeb(options);
  await startWebDashboard(options, { detached: false });
}

async function commandServiceRun(options) {
  await mkdirp(options.home);
  loadEnvFiles(options.home);
  await prepareRuntimeForLaunch(options);
  if (!isWebUiEnabled()) {
    return commandForeground(options);
  }
  await ensureConnectorStartedForWeb(options);
  await startWebDashboard(options, { detached: false, stopConnectorOnExit: true });
}

async function startWebDashboard(options, settings = {}) {
  await mkdirp(options.home);
  loadEnvFiles(options.home);
  const { host, port } = resolveDashboardEndpoint(options, { strict: true });
  const entry = await resolveWebRuntimeEntry();
  if (!entry) {
    throw new Error(`Missing dashboard runtime. Run \`npm install\` and \`npm run build\` in ${RUNTIME_ROOT}.`);
  }

  const env = {
    ...process.env,
    NORDRELAY_HOME: options.home,
    NORDRELAY_SOURCE_ROOT: RUNTIME_ROOT,
    NORDRELAY_WORKSPACE: resolveLaunchWorkspace(),
    NORDRELAY_DASHBOARD_HOST: host,
    NORDRELAY_DASHBOARD_PORT: String(port),
  };
  let child = null;
  let stdio = null;
  let alreadyRunning = false;
  await withLifecycleLock(pidFileLock(options.webPidFile), async () => {
    const currentPid = await readWebPid(options);
    if (await isManagedWebPid(options, currentPid)) {
      console.log(`NordRelay dashboard already running with PID ${currentPid}.`);
      console.log(`NordRelay dashboard: ${formatDashboardUrl({ host, port })}`);
      alreadyRunning = true;
      return;
    }
    if (currentPid) {
      await fsp.rm(options.webPidFile, { force: true });
    }

    await writeWebState(options, {
      status: "starting",
      pid: null,
      host,
      port,
      url: formatDashboardUrl({ host, port }),
    });
    stdio = settings.detached
      ? ["ignore", fs.openSync(options.webLogFile, "a"), fs.openSync(options.webLogFile, "a")]
      : "inherit";
    child = spawn(entry.command, [...entry.args, "--host", host, "--port", String(port), "--home", options.home], {
      cwd: RUNTIME_ROOT,
      env,
      detached: Boolean(settings.detached),
      stdio,
    });
    await writePidAtomic(options.webPidFile, child.pid);
    await writeWebState(options, {
      status: "running",
      pid: child.pid,
      host,
      port,
      url: formatDashboardUrl({ host, port }),
    });
  });

  if (alreadyRunning || !child) {
    return;
  }

  if (settings.detached) {
    child.unref();
    if (Array.isArray(stdio)) {
      fs.closeSync(stdio[1]);
      fs.closeSync(stdio[2]);
    }
    console.log(`NordRelay dashboard started with PID ${child.pid}.`);
    console.log(`NordRelay dashboard: ${formatDashboardUrl({ host, port })}`);
    console.log(`WebUI log: ${options.webLogFile}`);
    return;
  }

  const forwardSignal = (signal) => {
    if (isProcessRunning(child.pid)) {
      child.kill(signal);
    }
  };
  process.once("SIGINT", () => forwardSignal("SIGINT"));
  process.once("SIGTERM", () => forwardSignal("SIGTERM"));

  const exit = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const pid = await readWebPid(options);
  if (pid === child.pid) {
    await fsp.rm(options.webPidFile, { force: true });
  }
  await writeWebState(options, {
    status: exit.code === 0 ? "stopped" : "error",
    pid: null,
    host,
    port,
    url: formatDashboardUrl({ host, port }),
    exitCode: exit.code,
    signal: exit.signal,
  });
  if (settings.stopConnectorOnExit) {
    await commandStop(options, { keepWeb: true });
  }
  if (exit.signal) {
    process.kill(process.pid, exit.signal);
    return;
  }
  process.exit(exit.code ?? 0);
}

async function commandForeground(options) {
  await mkdirp(options.home);
  loadEnvFiles(options.home);
  await prepareRuntimeForLaunch(options);
  const launchWorkspace = resolveLaunchWorkspace();
  process.chdir(RUNTIME_ROOT);

  if (!process.env.NORDRELAY_WRAPPER_PID) {
    await withLifecycleLock(pidFileLock(options.pidFile), async () => {
      const currentPid = await readPid(options.pidFile);
      if (currentPid && currentPid !== process.pid && await isManagedConnectorPid(options, currentPid)) {
        console.log(`NordRelay connector already running with PID ${currentPid}.`);
        process.exit(0);
      }
      await writePidAtomic(options.pidFile, process.pid);
    });
  }

  await writeJsonAtomic(options.stateFile, {
    status: "starting",
    pid: process.pid,
    updatedAt: nowIso(),
    logFile: options.logFile,
  });

  const entry = await resolveRuntimeEntry();
  if (!entry) {
    const message = `Missing runtime. Run \`npm install\` and \`npm run build\` in ${RUNTIME_ROOT}.`;
    await writeJsonAtomic(options.stateFile, {
      status: "error",
      pid: process.pid,
      updatedAt: nowIso(),
      error: message,
      logFile: options.logFile,
    });
    throw new Error(message);
  }

  const env = {
    ...process.env,
    NORDRELAY_HOME: options.home,
    NORDRELAY_SOURCE_ROOT: RUNTIME_ROOT,
    NORDRELAY_WORKSPACE: launchWorkspace,
    NORDRELAY_STATE_FILE: options.stateFile,
    NORDRELAY_WRAPPER_PID: String(process.pid),
    NORDRELAY_DROP_PENDING_UPDATES: options.dropPendingUpdates ? "1" : "0",
  };

  const child = spawn(entry.command, entry.args, {
    cwd: RUNTIME_ROOT,
    env,
    stdio: "inherit",
  });

  const forwardSignal = (signal) => {
    if (isProcessRunning(child.pid)) {
      child.kill(signal);
    }
  };

  process.once("SIGINT", () => forwardSignal("SIGINT"));
  process.once("SIGTERM", () => forwardSignal("SIGTERM"));

  const exit = await new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  const previousState = await readJson(options.stateFile, {});
  const stoppedBySignal = exit.signal === "SIGTERM" || exit.signal === "SIGINT";
  const stopped = exit.code === 0 || stoppedBySignal;
  await writeJsonAtomic(options.stateFile, {
    status: stopped ? "stopped" : "error",
    pid: process.pid,
    updatedAt: nowIso(),
    exitCode: exit.code,
    signal: exit.signal,
    error: stopped ? undefined : previousState.error,
    logFile: options.logFile,
  });

  if (exit.signal && !stoppedBySignal) {
    process.kill(process.pid, exit.signal);
    return;
  }
  process.exit(stopped ? 0 : exit.code ?? 1);
}

async function resolveRuntimeEntry() {
  const distEntry = path.join(RUNTIME_ROOT, "dist", "index.js");
  if (fs.existsSync(distEntry)) {
    return { command: process.execPath, args: [distEntry] };
  }

  const tsEntry = path.join(RUNTIME_ROOT, "src", "index.ts");
  const tsxBin = path.join(RUNTIME_ROOT, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
  if (fs.existsSync(tsEntry) && fs.existsSync(tsxBin)) {
    return { command: tsxBin, args: [tsEntry] };
  }

  return null;
}

async function prepareRuntimeForLaunch(options) {
  if (options.buildBeforeStart) {
    await buildRuntime();
    options.buildBeforeStart = false;
    return;
  }
  warnIfRuntimeBuildIsStale();
}

function runtimeForwardFlags(flags) {
  return flags.filter((flag) => flag !== "--build");
}

async function buildRuntime() {
  if (!isSourceRuntime()) {
    throw new Error(`Runtime build is only available from a source checkout. Current runtime: ${RUNTIME_ROOT}`);
  }
  const npm = resolveNpmSpawnCommand();
  if (!npm) {
    throw new Error("npm was not found. Install Node.js/npm or add npm to PATH.");
  }
  console.log("Building NordRelay runtime...");
  await runInteractiveStep("Build runtime", npm.command, [...npm.argsPrefix, "run", "build"], {
    cwd: RUNTIME_ROOT,
    shell: npm.shell,
  });
}

function warnIfRuntimeBuildIsStale() {
  const status = runtimeBuildStatus();
  if (!status || !status.stale) {
    return;
  }
  const source = status.sourcePath ? path.relative(RUNTIME_ROOT, status.sourcePath) : "source files";
  const target = status.targetPath ? path.relative(RUNTIME_ROOT, status.targetPath) : "dist";
  const reason = status.missing
    ? `missing ${target}`
    : `${source} is newer than ${target}`;
  console.warn(`Warning: NordRelay runtime build may be stale (${reason}). Run \`nordrelay restart --build\` or \`npm run build\`.`);
}

function runtimeBuildStatus() {
  if (!isSourceRuntime()) {
    return null;
  }
  const source = newestMtime([
    path.join(RUNTIME_ROOT, "src"),
    path.join(RUNTIME_ROOT, "plugins", "nordrelay", "scripts"),
    path.join(RUNTIME_ROOT, "scripts"),
    path.join(RUNTIME_ROOT, "package.json"),
    path.join(RUNTIME_ROOT, "tsconfig.json"),
    path.join(RUNTIME_ROOT, "tsconfig.webui.json"),
  ]);
  const distTargets = [
    path.join(RUNTIME_ROOT, "dist", "index.js"),
    path.join(RUNTIME_ROOT, "dist", "web", "web-dashboard.js"),
    path.join(RUNTIME_ROOT, "dist", "webui-assets", "dashboard.js"),
    path.join(RUNTIME_ROOT, "dist", "webui-assets", "dashboard.css"),
  ];
  const missingTarget = distTargets.find((target) => !fs.existsSync(target));
  if (missingTarget) {
    return {
      stale: true,
      missing: true,
      sourcePath: source.path,
      sourceMtimeMs: source.mtimeMs,
      targetPath: missingTarget,
      targetMtimeMs: 0,
    };
  }
  const target = oldestMtime(distTargets);
  return {
    stale: source.mtimeMs > target.mtimeMs,
    missing: false,
    sourcePath: source.path,
    sourceMtimeMs: source.mtimeMs,
    targetPath: target.path,
    targetMtimeMs: target.mtimeMs,
  };
}

function isSourceRuntime() {
  return fs.existsSync(path.join(RUNTIME_ROOT, "src", "index.ts")) &&
    fs.existsSync(path.join(RUNTIME_ROOT, "scripts", "build-web-assets.mjs"));
}

function newestMtime(paths) {
  let newest = { path: null, mtimeMs: 0 };
  for (const itemPath of paths) {
    const candidate = newestMtimeForPath(itemPath);
    if (candidate.mtimeMs > newest.mtimeMs) {
      newest = candidate;
    }
  }
  return newest;
}

function newestMtimeForPath(itemPath) {
  if (!fs.existsSync(itemPath)) {
    return { path: itemPath, mtimeMs: 0 };
  }
  const stat = fs.statSync(itemPath);
  if (!stat.isDirectory()) {
    return { path: itemPath, mtimeMs: stat.mtimeMs };
  }
  let newest = { path: itemPath, mtimeMs: stat.mtimeMs };
  for (const entry of fs.readdirSync(itemPath, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") {
      continue;
    }
    const candidate = newestMtimeForPath(path.join(itemPath, entry.name));
    if (candidate.mtimeMs > newest.mtimeMs) {
      newest = candidate;
    }
  }
  return newest;
}

function oldestMtime(paths) {
  let oldest = { path: null, mtimeMs: Number.POSITIVE_INFINITY };
  for (const itemPath of paths) {
    const mtimeMs = fs.statSync(itemPath).mtimeMs;
    if (mtimeMs < oldest.mtimeMs) {
      oldest = { path: itemPath, mtimeMs };
    }
  }
  return oldest;
}

async function runInteractiveStep(label, command, args, settings = {}) {
  console.log(`${label}: ${formatCommand(command, args)}`);
  const useShell = Boolean(settings.shell);
  const child = spawn(useShell ? formatShellCommand(command, args) : command, useShell ? [] : args, {
    cwd: settings.cwd || RUNTIME_ROOT,
    env: process.env,
    shell: useShell,
    stdio: "inherit",
    windowsHide: false,
  });
  const exit = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  if (exit.signal) {
    throw new Error(`${label} stopped with signal ${exit.signal}`);
  }
  if (exit.code !== 0) {
    throw new Error(`${label} failed with exit code ${exit.code ?? "unknown"}`);
  }
}

async function resolveWebRuntimeEntry() {
  const distEntry = path.join(RUNTIME_ROOT, "dist", "web", "web-dashboard.js");
  if (fs.existsSync(distEntry)) {
    return { command: process.execPath, args: [distEntry] };
  }

  const tsEntry = path.join(RUNTIME_ROOT, "src", "web", "web-dashboard.ts");
  const tsxBin = path.join(RUNTIME_ROOT, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
  if (fs.existsSync(tsEntry) && fs.existsSync(tsxBin)) {
    return { command: tsxBin, args: [tsEntry] };
  }

  return null;
}

function findRuntimeRoot() {
  const candidates = [
    process.env.NORDRELAY_SOURCE_ROOT,
    DEFAULT_MARKETPLACE_ROOT,
    process.cwd(),
  ].filter(Boolean);

  for (const candidate of candidates) {
    const root = path.resolve(candidate);
    const packageJson = path.join(root, "package.json");
    const distEntry = path.join(root, "dist", "index.js");
    const srcEntry = path.join(root, "src", "index.ts");
    if (!fs.existsSync(packageJson)) continue;
    if (!fs.existsSync(distEntry) && !fs.existsSync(srcEntry)) continue;

    try {
      const pkg = JSON.parse(fs.readFileSync(packageJson, "utf8"));
      if (pkg?.name === APP_NAME || pkg?.name === "nordrelay" || pkg?.name === "@nordbyte/nordrelay") {
        return root;
      }
    } catch {
      // Try the next candidate.
    }
  }

  return DEFAULT_MARKETPLACE_ROOT;
}

async function ask(rl, label, defaultValue) {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  if (rl) {
    const answer = (await rl.question(`${label}${suffix}: `)).trim();
    return answer || defaultValue;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) return defaultValue;
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await prompt.question(`${label}${suffix}: `)).trim();
    return answer || defaultValue;
  } finally {
    prompt.close();
  }
}

async function askSecret(rl, label, defaultValue) {
  void rl;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return defaultValue;
  const suffix = defaultValue ? " [hidden default]" : "";
  return await new Promise((resolve) => {
    const input = process.stdin;
    const output = process.stdout;
    const wasRaw = input.isRaw;
    let value = "";
    output.write(`${label}${suffix}: `);
    input.setRawMode(true);
    input.resume();
    const cleanup = () => {
      input.off("data", onData);
      input.setRawMode(Boolean(wasRaw));
      input.pause();
    };
    const finish = () => {
      cleanup();
      output.write("\n");
      resolve(value || defaultValue);
    };
    const onData = (chunk) => {
      const text = chunk.toString("utf8");
      for (const char of text) {
        if (char === "\u0003") {
          cleanup();
          output.write("\n");
          process.exit(130);
        }
        if (char === "\r" || char === "\n") {
          finish();
          return;
        }
        if (char === "\u007f" || char === "\b") {
          if (value.length > 0) {
            value = value.slice(0, -1);
            output.write("\b \b");
          }
          continue;
        }
        value += char;
        output.write("*");
      }
    };
    input.on("data", onData);
  });
}

async function askChoice(rl, label, defaultValue) {
  const value = (await ask(rl, label, defaultValue)).toLowerCase();
  if (["1", "yes", "y", "true", "on"].includes(value)) return "true";
  if (["0", "no", "n", "false", "off"].includes(value)) return "false";
  return value || defaultValue;
}

function check(name, ok, detail, status = "fail", fix = null) {
  return {
    name,
    ok,
    detail,
    status,
    fix,
    icon: ok ? "✅" : status === "warn" ? "⚠️" : "❌",
  };
}

function hintFix(summary) {
  return summary ? { summary } : null;
}

function envValueFix(home, key, value, summary) {
  return {
    id: `env:${key}`,
    summary: `${summary} (${key}=${value})`,
    apply: async () => {
      const envPath = await writeEnvValue(home, key, value);
      process.env[key] = value;
      return `Set ${key}=${value} in ${envPath}`;
    },
  };
}

function pathFix(dir) {
  const profilePath = resolveShellProfilePath();
  if (!profilePath) {
    return hintFix(`Add ${dir} to PATH for your shell.`);
  }
  return {
    id: `path:${dir}`,
    summary: `Add ${dir} to PATH in ${profilePath}.`,
    apply: async () => addPathToShellProfile(profilePath, dir),
  };
}

function runtimeBuildFix() {
  if (!isSourceRuntime()) {
    return hintFix("Reinstall NordRelay or run `npm install -g @nordbyte/nordrelay`.");
  }
  return {
    id: "runtime-build",
    summary: "Build the local source runtime with npm.",
    apply: async () => {
      await buildRuntime();
      return "Built local source runtime.";
    },
  };
}

async function runDoctorFixes(checks) {
  const seen = new Set();
  const fixable = checks.filter((item) => {
    if (item.ok || typeof item.fix?.apply !== "function") return false;
    const id = item.fix.id || item.fix.summary || item.name;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  if (!fixable.length) {
    console.log("\nNo automatic fixes are available for the current findings.");
    return;
  }
  console.log("\nAuto-fixes:");
  for (const item of fixable) {
    try {
      const message = await item.fix.apply();
      console.log(`✅ ${item.name}: ${message}`);
    } catch (error) {
      console.log(`❌ ${item.name}: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }
  console.log("\nRun `nordrelay doctor` again to verify the updated setup.");
}

async function writeEnvValue(home, key, value) {
  const envPath = resolveEnvPath(home);
  await mkdirp(path.dirname(envPath));
  let text = "";
  try {
    text = await fsp.readFile(envPath, "utf8");
  } catch {
    text = "# NordRelay local runtime config.\n";
  }
  const lines = text.split(/\r?\n/);
  const pattern = new RegExp(`^(?:export\\s+)?${escapeRegExp(key)}\\s*=`);
  let updated = false;
  const next = lines.map((line) => {
    if (!pattern.test(line.trim())) return line;
    updated = true;
    return `${key}=${value}`;
  });
  if (!updated) {
    if (next.length && next[next.length - 1] !== "") next.push("");
    next.push(`${key}=${value}`);
  }
  await fsp.writeFile(envPath, `${next.join("\n").replace(/\n+$/, "")}\n`, { mode: 0o600 });
  await fsp.chmod(envPath, 0o600).catch(() => {});
  return envPath;
}

function resolveShellProfilePath() {
  if (process.platform === "win32") return null;
  const home = os.homedir();
  const shell = path.basename(process.env.SHELL || "");
  if (shell === "zsh") return path.join(home, ".zprofile");
  if (shell === "bash") return path.join(home, ".bashrc");
  return path.join(home, ".profile");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function addPathToShellProfile(profilePath, dir) {
  await mkdirp(path.dirname(profilePath));
  let text = "";
  try {
    text = await fsp.readFile(profilePath, "utf8");
  } catch {}
  if (text.includes(dir)) return `${dir} is already mentioned in ${profilePath}`;
  const block = [
    "",
    "# Added by nordrelay doctor --fix",
    `case ":$PATH:" in *":${dir}:"*) ;; *) export PATH="${dir}:$PATH" ;; esac`,
    "",
  ].join("\n");
  await fsp.appendFile(profilePath, block, "utf8");
  return `Added ${dir} to ${profilePath}. Open a new shell or source the profile.`;
}

function findExecutable(command, pathValue = process.env.PATH, pathextValue = process.env.PATHEXT) {
  if (!command) return null;
  if (command.includes(path.sep) && fs.existsSync(command)) return command;
  const paths = (pathValue || "").split(path.delimiter);
  const extensions = process.platform === "win32"
    ? windowsExecutableExtensions(pathextValue)
    : [""];
  for (const dir of paths) {
    for (const extension of extensions) {
      const candidate = path.join(dir, `${command}${extension}`);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function resolveNpmGlobalBinDir(env = process.env) {
  const prefix = resolveNpmGlobalPrefix(env);
  if (!prefix) {
    return null;
  }
  return process.platform === "win32" ? prefix : path.join(prefix, "bin");
}

function resolveNpmGlobalPrefix(env = process.env) {
  if (env.npm_config_prefix) {
    return path.resolve(env.npm_config_prefix);
  }
  const npm = resolveNpmSpawnCommand(env);
  if (!npm) {
    return null;
  }
  const command = npm.shell
    ? formatShellCommand(npm.command, [...npm.argsPrefix, "prefix", "-g"])
    : npm.command;
  const args = npm.shell ? [] : [...npm.argsPrefix, "prefix", "-g"];
  const result = spawnSync(command, args, {
    cwd: os.homedir(),
    env,
    shell: npm.shell,
    encoding: "utf8",
    windowsHide: true,
    timeout: 5000,
  });
  if (result.status !== 0) {
    return null;
  }
  const prefix = String(result.stdout || "").trim().split(/\r?\n/).at(-1)?.trim();
  return prefix ? path.resolve(prefix) : null;
}

function pathListIncludes(directory, pathValue = process.env.PATH) {
  const normalized = normalizePathForCompare(directory);
  return (pathValue || "")
    .split(path.delimiter)
    .filter(Boolean)
    .some((entry) => normalizePathForCompare(entry) === normalized);
}

function pathsEqualOrLinked(left, right) {
  if (!left || !right) {
    return false;
  }
  const normalizedLeft = normalizePathForCompare(left);
  const normalizedRight = normalizePathForCompare(right);
  if (normalizedLeft === normalizedRight) {
    return true;
  }
  try {
    return normalizePathForCompare(fs.realpathSync(left)) === normalizePathForCompare(fs.realpathSync(right));
  } catch {
    return false;
  }
}

function normalizePathForCompare(value) {
  const resolved = path.resolve(value || "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function windowsExecutableExtensions(pathextValue) {
  const pathext = (pathextValue || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((extension) => extension.trim())
    .filter(Boolean)
    .map((extension) => extension.startsWith(".") ? extension : `.${extension}`);
  return [...new Set([...pathext, ""])];
}

function isWindowsShellScript(filePath) {
  return process.platform === "win32" && /\.(?:cmd|bat)$/i.test(filePath);
}

function isLoopbackName(host) {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function validateStateBackend() {
  const backend = process.env.NORDRELAY_STATE_BACKEND || "json";
  if (backend === "json") return { ok: true, detail: "NORDRELAY_STATE_BACKEND=json" };
  if (backend !== "sqlite") return { ok: false, detail: `Invalid NORDRELAY_STATE_BACKEND=${backend}` };
  try {
    const Database = require("better-sqlite3");
    const workspace = path.resolve(process.env.NORDRELAY_WORKSPACE || process.cwd());
    const filePath = path.join(workspace, ".nordrelay", "state.sqlite");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const db = new Database(filePath);
    db.exec([
      "CREATE TABLE IF NOT EXISTS documents (",
      "key TEXT PRIMARY KEY,",
      "json TEXT NOT NULL,",
      "updated_at TEXT NOT NULL",
      ")",
    ].join(" "));
    db.close?.();
    return { ok: true, detail: `NORDRELAY_STATE_BACKEND=sqlite (${filePath})` };
  } catch (error) {
    return {
      ok: false,
      detail: `NORDRELAY_STATE_BACKEND=sqlite is configured but unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function readStartupError(logFile) {
  try {
    const lines = (await fsp.readFile(logFile, "utf8")).split(/\r?\n/).filter(Boolean).slice(-80).reverse();
    const startupLine = lines.find((line) => line.includes("Failed to start NordRelay:"));
    if (startupLine) return startupLine.replace(/^.*Failed to start NordRelay:\s*/, "");
    const errorLine = lines.find((line) => /\bERROR\b/i.test(line));
    if (errorLine) return errorLine;
    return lines[0] || null;
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printHelp() {
  console.log(`${APP_NAME} ${VERSION}`);
  console.log("");
  console.log("Usage: nordrelay <command> [options]");
  console.log("");
  console.log("Commands:");
  console.log("  init                 Create local config and first admin user");
  console.log("  user                 Manage users, groups, and channel links");
  console.log("  peer                 Manage secure NordRelay peer federation");
  console.log("  service              Install, remove, or inspect the OS service");
  console.log("  doctor [--fix]       Validate the local setup and apply safe fixes");
  console.log("  web, dashboard       Start the WebUI and connector");
  console.log("  start                Start the connector");
  console.log("  stop                 Stop the connector and WebUI");
  console.log("  restart              Restart the connector");
  console.log("  status               Show connector and WebUI status");
  console.log("  update               Update NordRelay");
  console.log("  foreground           Run the connector in the foreground");
  console.log("  version              Print the installed version");
  console.log("");
  console.log("Options:");
  console.log("  --home <path>        Runtime home directory");
  console.log("  --host <host>        WebUI bind host");
  console.log("  --port <port>        WebUI port");
  console.log("  service install --dry-run [--platform linux|darwin|win32]");
  console.log("  --build              Build source runtime before start/web/restart");
  console.log("  --fix                Apply safe local fixes during doctor");
  console.log("  --force              Overwrite existing config during init");
  console.log("  --disable-webui      Disable the WebUI during init");
  console.log("  --help, -h           Show this help");
  console.log("  --version, -v        Show the installed version");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === "help") {
    printHelp();
    return;
  }
  if (options.command === "start") return commandStart(options);
  if (options.command === "stop") return commandStop(options);
  if (options.command === "status") return commandStatus(options);
  if (options.command === "init") return commandInit(options);
  if (options.command === "user") return commandUser(options);
  if (options.command === "peer") return commandPeer(options);
  if (options.command === "service") return commandService(options);
  if (options.command === "doctor") return commandDoctor(options);
  if (options.command === "update") return commandUpdate(options);
  if (options.command === "web" || options.command === "dashboard") return commandWeb(options);
  if (options.command === "restart") {
    await mkdirp(options.home);
    loadEnvFiles(options.home);
    await prepareRuntimeForLaunch(options);
    const webWasRunning = await isWebDashboardRunning(options);
    await commandStop(options);
    await commandStart(options);
    if (webWasRunning && process.exitCode !== 1) {
      await startWebDashboard(options, { detached: true });
    }
    return;
  }
  if (options.command === "foreground") return commandForeground(options);
  if (options.command === "service-run") return commandServiceRun(options);
  if (options.command === "--version" || options.command === "version") {
    console.log(`${APP_NAME} ${VERSION}`);
    return;
  }

  console.error(`Unknown command: ${options.command}`);
  console.error("Usage: nordrelay [init|user|peer|service|doctor|web|start|stop|restart|status|update|foreground|version]");
  console.error("Run `nordrelay --help` for details.");
  process.exitCode = 2;
}

export {
  buildLaunchdServiceSpec,
  buildSystemdUserServiceSpec,
  buildWindowsTaskServiceSpec,
  parseServiceFlags,
  serviceInstallSpec,
};

if (isMainScript(process.argv[1])) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
