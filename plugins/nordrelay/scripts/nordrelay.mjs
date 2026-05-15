#!/usr/bin/env node
import fs from "node:fs";
import fsp from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const FALLBACK_VERSION = "0.3.1";
const require = createRequire(import.meta.url);
const APP_NAME = "nordrelay";
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PLUGIN_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const DEFAULT_MARKETPLACE_ROOT = path.resolve(PLUGIN_ROOT, "../..");
const RUNTIME_ROOT = findRuntimeRoot();
const VERSION = readRuntimePackageVersion() || FALLBACK_VERSION;
const DEFAULT_HOME = path.join(os.homedir(), ".nordrelay");

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
    else if (arg === "--no-restart") options.restartAfterUpdate = false;
    else if (arg === "--restart") options.restartAfterUpdate = true;
    else if (arg === "--token") options.telegramBotToken = requireValue(copy, ++i, arg);
    else if (arg === "--disable-telegram") options.disableTelegram = true;
    else if (arg === "--enable-discord") options.enableDiscord = true;
    else if (arg === "--discord-token") options.discordBotToken = requireValue(copy, ++i, arg);
    else if (arg === "--discord-client-id") options.discordClientId = requireValue(copy, ++i, arg);
    else if (arg === "--enable-slack") options.enableSlack = true;
    else if (arg === "--slack-bot-token") options.slackBotToken = requireValue(copy, ++i, arg);
    else if (arg === "--slack-app-token") options.slackAppToken = requireValue(copy, ++i, arg);
    else if (arg === "--slack-signing-secret") options.slackSigningSecret = requireValue(copy, ++i, arg);
    else if (arg === "--admin-email") options.adminEmail = requireValue(copy, ++i, arg);
    else if (arg === "--admin-name") options.adminName = requireValue(copy, ++i, arg);
    else if (arg === "--admin-password") options.adminPassword = requireValue(copy, ++i, arg);
    else if (arg === "--telegram-user-id") options.telegramUserId = requireValue(copy, ++i, arg);
    else if (arg === "--slack-user-id") options.slackUserId = requireValue(copy, ++i, arg);
    else if (arg === "--slack-team-id") options.slackTeamId = requireValue(copy, ++i, arg);
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
  const envPath = process.env.NORDRELAY_ENV_FILE
    ? path.resolve(process.env.NORDRELAY_ENV_FILE)
    : path.join(home, "nordrelay.env");

  loadEnvFile(envPath);

  normalizeEnvAliases();
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

async function readPid(pidFile) {
  try {
    const value = Number.parseInt((await fsp.readFile(pidFile, "utf8")).trim(), 10);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

async function readWebState(options) {
  return await readJson(options.webStateFile, {});
}

async function readWebPid(options) {
  return await readPid(options.webPidFile);
}

async function isWebDashboardRunning(options) {
  return isProcessRunning(await readWebPid(options));
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

function formatDashboardUrl(endpoint) {
  const host = endpoint.host || "127.0.0.1";
  const displayHost = host === "0.0.0.0" || host === "" ? "127.0.0.1" : host === "::" ? "::1" : host;
  const formattedHost = displayHost.includes(":") && !displayHost.startsWith("[") ? `[${displayHost}]` : displayHost;
  const bindHint = displayHost === host ? "" : ` (binds ${host || "all interfaces"})`;
  return `http://${formattedHost}:${endpoint.port}/${bindHint}`;
}

async function commandStart(options, settings = {}) {
  await mkdirp(options.home);
  loadEnvFiles(options.home);
  await prepareRuntimeForLaunch(options);
  const dashboard = resolveDashboardEndpoint(options);

  const currentPid = await readPid(options.pidFile);
  if (isProcessRunning(currentPid)) {
    console.log(`Already running with PID ${currentPid}`);
    await commandStatus(options);
    return;
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
    env: process.env,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  fs.closeSync(logFd);

  await fsp.writeFile(options.pidFile, `${child.pid}\n`);

  const state = await waitForState(options.stateFile, child.pid, 8000);
  if (state?.status === "ready") {
    console.log(`Started ${APP_NAME} ${VERSION} with PID ${child.pid}`);
    console.log(`Workspace: ${state.workspace || "-"}`);
    console.log(`Mode: ${state.sessionMode || "per Telegram context"}`);
    if (!settings.skipWebHint) {
      const webPid = await readWebPid(options);
      const webHint = isProcessRunning(webPid) ? `(running with PID ${webPid})` : "(run `nordrelay web` to start it)";
      console.log(`WebUI: ${formatDashboardUrl(dashboard)} ${webHint}`);
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
    const webPid = await readWebPid(options);
    const webHint = isProcessRunning(webPid) ? `(running with PID ${webPid})` : "(run `nordrelay web` to start it)";
    console.log(`WebUI: ${formatDashboardUrl(dashboard)} ${webHint}`);
  }
  console.log(`Startup is still in progress. Log: ${options.logFile}`);
}

async function ensureConnectorStartedForWeb(options) {
  const currentPid = await readPid(options.pidFile);
  if (isProcessRunning(currentPid)) {
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
  if (!isProcessRunning(pid)) {
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
  if (!isProcessRunning(pid)) {
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
  const running = isProcessRunning(pid);
  const webRunning = isProcessRunning(webPid);
  const webStatus = webRunning ? "running" : webState.status === "running" || webState.status === "starting" ? "stale" : webState.status || "stopped";
  if (!webRunning && (webState.status === "running" || webState.status === "starting")) {
    await fsp.rm(options.webPidFile, { force: true });
    await writeWebState(options, { status: "stopped", pid: null });
  }
  console.log(`Status: ${state.status || (running ? "running" : "stopped")}`);
  console.log(`PID: ${pid || "-"} (${running ? "running" : "not running"})`);
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

async function commandUpdate(options) {
  await mkdirp(options.home);
  loadEnvFiles(options.home);
  const method = resolveUpdateMethod(options);
  const updateLog = path.join(options.home, "update.log");
  await mkdirp(path.dirname(updateLog));
  const log = fs.createWriteStream(updateLog, { flags: "a" });
  const sourceRoot = RUNTIME_ROOT;
  const wasRunning = isProcessRunning(await readPid(options.pidFile));
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
  const envPath = path.join(options.home, "nordrelay.env");
  const userStore = await createUserStore(options.home);
  if (fs.existsSync(envPath) && !options.force) {
    console.log(`Config already exists: ${envPath}`);
    console.log("Run with --force to overwrite.");
    return;
  }

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
  const adminEmail = options.adminEmail || await ask(null, "Admin email", "");
  const adminName = options.adminName || await ask(null, "Admin name", "Admin");
  const adminPassword = options.adminPassword || await askSecret(null, "Admin password", "");
  const telegramUserId = options.telegramUserId || await ask(null, "Optional Telegram user id to link", "");
  const slackUserId = options.slackUserId || await ask(null, "Optional Slack user id to link", "");
  const slackTeamId = slackUserId ? (options.slackTeamId || await ask(null, "Optional Slack team id for linked user", "")) : "";
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
  if (enableTelegram !== "true" && enableDiscord !== "true" && enableSlack !== "true") throw new Error("At least one chat adapter must be enabled.");
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
    slackUserId: slackUserId || undefined,
    slackTeamId: slackTeamId || undefined,
  });
  console.log(`Wrote ${envPath}`);
  console.log(`Created admin user ${adminEmail}.`);
  console.log("Run `nordrelay doctor` to validate the setup.");
}

async function createUserStore(home) {
  const modulePath = path.join(RUNTIME_ROOT, "dist", "user-management.js");
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
    const modulePath = path.join(RUNTIME_ROOT, "dist", file);
    if (!fs.existsSync(modulePath)) {
      throw new Error(`Missing peer runtime. Run \`npm run build\` in ${RUNTIME_ROOT}.`);
    }
  }
  const [store, identity, client] = await Promise.all(required.map((file) => import(pathToFileURL(path.join(RUNTIME_ROOT, "dist", file)).href)));
  return { store, identity, client };
}

function parsePeerFlags(argv) {
  const copy = [...argv];
  const subcommand = copy[0] && !copy[0].startsWith("-") ? copy.shift() : "list";
  const flags = { subcommand, url: undefined };
  if (["add", "test", "check", "revoke"].includes(subcommand) && copy[0] && !copy[0].startsWith("-")) {
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

  throw new Error("Usage: nordrelay peer [identity|list|invite|add|test|check|revoke]");
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
      ? store.createAdmin({ email, displayName: name, password, telegramUserId: flags.telegramUserId, discordUserId: flags.discordUserId, slackUserId: flags.slackUserId, slackTeamId: flags.slackTeamId })
      : store.createUser({ email, displayName: name, password, groupIds, telegramUserId: flags.telegramUserId, discordUserId: flags.discordUserId, slackUserId: flags.slackUserId, slackTeamId: flags.slackTeamId });
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

  throw new Error("Usage: nordrelay user [list|create-admin|create|reset-password|link-telegram|link-discord|link-slack|link-code|telegram-link-code|discord-link-code|slack-link-code]");
}

async function commandDoctor(options) {
  await mkdirp(options.home);
  loadEnvFiles(options.home);
  const userStore = await createUserStore(options.home).catch(() => null);
  const userSnapshot = userStore?.snapshot();
  const checks = [];
  checks.push(check("Node.js >= 22", Number.parseInt(process.versions.node.split(".")[0], 10) >= 22, process.version));
  const telegramRequested = process.env.TELEGRAM_ENABLED !== "false";
  const discordRequested = process.env.DISCORD_ENABLED === "true";
  const slackRequested = process.env.SLACK_ENABLED === "true";
  const slackSocketMode = process.env.SLACK_SOCKET_MODE !== "false";
  const telegramUsable = telegramRequested && Boolean(process.env.TELEGRAM_BOT_TOKEN);
  const discordUsable = discordRequested && Boolean(process.env.DISCORD_BOT_TOKEN);
  const slackUsable = slackRequested && Boolean(process.env.SLACK_BOT_TOKEN) && (slackSocketMode ? Boolean(process.env.SLACK_APP_TOKEN) : Boolean(process.env.SLACK_SIGNING_SECRET));
  checks.push(check(
    "Telegram bot token",
    !telegramRequested || telegramUsable,
    telegramRequested ? (telegramUsable ? "configured" : "missing; Telegram adapter will be disabled") : "disabled",
    telegramRequested && !discordUsable && !slackUsable ? "fail" : "warn",
  ));
  checks.push(check(
    "Discord bot token",
    !discordRequested || discordUsable,
    discordRequested ? (discordUsable ? "configured" : "missing; Discord adapter will be disabled") : "disabled",
    discordRequested && !telegramUsable && !slackUsable ? "fail" : "warn",
  ));
  checks.push(check(
    "Slack bot token",
    !slackRequested || Boolean(process.env.SLACK_BOT_TOKEN),
    slackRequested ? (process.env.SLACK_BOT_TOKEN ? "configured" : "missing; Slack adapter will be disabled") : "disabled",
    slackRequested && !telegramUsable && !discordUsable ? "fail" : "warn",
  ));
  checks.push(check(
    slackSocketMode ? "Slack app token" : "Slack signing secret",
    !slackRequested || slackUsable,
    slackRequested ? (slackUsable ? "configured" : `missing; ${slackSocketMode ? "Socket Mode requires SLACK_APP_TOKEN" : "HTTP mode requires SLACK_SIGNING_SECRET"}`) : "disabled",
    slackRequested && !telegramUsable && !discordUsable ? "fail" : "warn",
  ));
  checks.push(check(
    "Usable chat adapter",
    telegramUsable || discordUsable || slackUsable,
    [telegramUsable ? "Telegram" : "", discordUsable ? "Discord" : "", slackUsable ? "Slack" : ""].filter(Boolean).join(" and ") || "none",
    "fail",
  ));
  checks.push(check("Discord client ID", !discordUsable || Boolean(process.env.DISCORD_CLIENT_ID), discordUsable ? (process.env.DISCORD_CLIENT_ID ? "configured" : "missing; slash command auto-registration disabled") : "disabled", "warn"));
  checks.push(check("User store", Boolean(userStore), userStore ? userStore.filePath : "missing runtime", userStore ? "pass" : "fail"));
  checks.push(check("Admin user", Boolean(userSnapshot?.adminConfigured), userSnapshot?.adminConfigured ? "configured" : "missing"));
  checks.push(check("WebUI login", true, "required for every dashboard request"));
  checks.push(check("Telegram access", true, "requires linked active users and enabled group chats"));
  checks.push(check("Discord access", true, "requires linked active users and enabled channels"));
  checks.push(check("Slack access", true, "requires linked active users and enabled channels"));
  const peerEnabled = process.env.NORDRELAY_PEER_ENABLED === "true";
  const peerTlsEnabled = process.env.NORDRELAY_PEER_TLS_ENABLED !== "false";
  const peerHost = process.env.NORDRELAY_PEER_HOST || "127.0.0.1";
  checks.push(check("Peer server", peerEnabled, peerEnabled ? `${peerHost}:${process.env.NORDRELAY_PEER_PORT || "31979"}` : "disabled", "warn"));
  checks.push(check("Peer TLS", !peerEnabled || peerTlsEnabled || isLoopbackName(peerHost), peerTlsEnabled ? "enabled" : "plaintext loopback only", peerEnabled ? "fail" : "warn"));
  checks.push(check("Codex enabled flag", process.env.NORDRELAY_CODEX_ENABLED !== "false", `NORDRELAY_CODEX_ENABLED=${process.env.NORDRELAY_CODEX_ENABLED ?? "true"}`));
  checks.push(check("Pi enabled flag", process.env.NORDRELAY_PI_ENABLED === "true" || process.env.NORDRELAY_PI_ENABLED === undefined, `NORDRELAY_PI_ENABLED=${process.env.NORDRELAY_PI_ENABLED ?? "false"}`, process.env.NORDRELAY_PI_ENABLED === "true" ? "pass" : "warn"));
  checks.push(check("Hermes enabled flag", process.env.NORDRELAY_HERMES_ENABLED === "true", `NORDRELAY_HERMES_ENABLED=${process.env.NORDRELAY_HERMES_ENABLED ?? "false"}`, process.env.NORDRELAY_HERMES_ENABLED === "true" ? "pass" : "warn"));
  checks.push(check("OpenClaw enabled flag", process.env.NORDRELAY_OPENCLAW_ENABLED === "true", `NORDRELAY_OPENCLAW_ENABLED=${process.env.NORDRELAY_OPENCLAW_ENABLED ?? "false"}`, process.env.NORDRELAY_OPENCLAW_ENABLED === "true" ? "pass" : "warn"));
  checks.push(check("Claude Code enabled flag", process.env.NORDRELAY_CLAUDE_CODE_ENABLED === "true", `NORDRELAY_CLAUDE_CODE_ENABLED=${process.env.NORDRELAY_CLAUDE_CODE_ENABLED ?? "false"}`, process.env.NORDRELAY_CLAUDE_CODE_ENABLED === "true" ? "pass" : "warn"));
  checks.push(check("Codex CLI", Boolean(findExecutable(process.env.CODEX_CLI_PATH || "codex")), process.env.CODEX_CLI_PATH || findExecutable("codex") || "not found", process.env.NORDRELAY_CODEX_ENABLED === "false" ? "warn" : "fail"));
  checks.push(check("Pi CLI", Boolean(findExecutable(process.env.PI_CLI_PATH || "pi")), process.env.PI_CLI_PATH || findExecutable("pi") || "not found", process.env.NORDRELAY_PI_ENABLED === "true" ? "fail" : "warn"));
  checks.push(check("Hermes CLI", Boolean(findExecutable(process.env.HERMES_CLI_PATH || "hermes")), process.env.HERMES_CLI_PATH || findExecutable("hermes") || "not found", process.env.NORDRELAY_HERMES_ENABLED === "true" ? "fail" : "warn"));
  checks.push(check("OpenClaw CLI", Boolean(findExecutable(process.env.OPENCLAW_CLI_PATH || "openclaw")), process.env.OPENCLAW_CLI_PATH || findExecutable("openclaw") || "not found", process.env.NORDRELAY_OPENCLAW_ENABLED === "true" ? "fail" : "warn"));
  checks.push(check("Claude Code CLI", Boolean(findExecutable(process.env.CLAUDE_CODE_CLI_PATH || "claude")), process.env.CLAUDE_CODE_CLI_PATH || findExecutable("claude") || "SDK bundled runtime", "warn"));
  const hermesApiCheck = await checkHermesApiServer();
  checks.push(check("Hermes API Server", hermesApiCheck.ok, hermesApiCheck.detail, process.env.NORDRELAY_HERMES_ENABLED === "true" ? "fail" : "warn"));
  const openClawGatewayCheck = await checkOpenClawGateway();
  checks.push(check("OpenClaw Gateway", openClawGatewayCheck.ok, openClawGatewayCheck.detail, process.env.NORDRELAY_OPENCLAW_ENABLED === "true" ? "fail" : "warn"));
  checks.push(check("ffmpeg", Boolean(findExecutable("ffmpeg")), findExecutable("ffmpeg") || "not found", "warn"));
  const stateBackendCheck = validateStateBackend();
  checks.push(check("State backend", stateBackendCheck.ok, stateBackendCheck.detail));
  checks.push(check("Runtime entry", Boolean(await resolveRuntimeEntry()), RUNTIME_ROOT));

  for (const item of checks) {
    console.log(`${item.icon} ${item.name}: ${item.detail}`);
  }

  const failed = checks.filter((item) => item.status === "fail" && !item.ok);
  const warned = checks.filter((item) => item.status === "warn" && !item.ok);
  console.log(`\nSummary: ${failed.length} failed, ${warned.length} warnings.`);
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
  await prepareRuntimeForLaunch(options);
  await ensureConnectorStartedForWeb(options);
  await startWebDashboard(options, { detached: false });
}

async function startWebDashboard(options, settings = {}) {
  await mkdirp(options.home);
  loadEnvFiles(options.home);
  const { host, port } = resolveDashboardEndpoint(options, { strict: true });
  const currentPid = await readWebPid(options);
  if (isProcessRunning(currentPid)) {
    console.log(`NordRelay dashboard already running with PID ${currentPid}.`);
    console.log(`NordRelay dashboard: ${formatDashboardUrl({ host, port })}`);
    return;
  }
  await fsp.rm(options.webPidFile, { force: true });
  const entry = await resolveWebRuntimeEntry();
  if (!entry) {
    throw new Error(`Missing dashboard runtime. Run \`npm install\` and \`npm run build\` in ${RUNTIME_ROOT}.`);
  }

  const env = {
    ...process.env,
    NORDRELAY_HOME: options.home,
    NORDRELAY_SOURCE_ROOT: RUNTIME_ROOT,
    NORDRELAY_DASHBOARD_HOST: host,
    NORDRELAY_DASHBOARD_PORT: String(port),
  };
  await writeWebState(options, {
    status: "starting",
    pid: null,
    host,
    port,
    url: formatDashboardUrl({ host, port }),
  });
  const stdio = settings.detached
    ? ["ignore", fs.openSync(options.webLogFile, "a"), fs.openSync(options.webLogFile, "a")]
    : "inherit";
  const child = spawn(entry.command, [...entry.args, "--host", host, "--port", String(port), "--home", options.home], {
    cwd: RUNTIME_ROOT,
    env,
    detached: Boolean(settings.detached),
    stdio,
  });
  await fsp.writeFile(options.webPidFile, `${child.pid}\n`);
  await writeWebState(options, {
    status: "running",
    pid: child.pid,
    host,
    port,
    url: formatDashboardUrl({ host, port }),
  });

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
  process.chdir(RUNTIME_ROOT);

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
    path.join(RUNTIME_ROOT, "dist", "web-dashboard.js"),
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
  const distEntry = path.join(RUNTIME_ROOT, "dist", "web-dashboard.js");
  if (fs.existsSync(distEntry)) {
    return { command: process.execPath, args: [distEntry] };
  }

  const tsEntry = path.join(RUNTIME_ROOT, "src", "web-dashboard.ts");
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

function check(name, ok, detail, status = "fail") {
  return {
    name,
    ok,
    detail,
    status,
    icon: ok ? "✅" : status === "warn" ? "⚠️" : "❌",
  };
}

function findExecutable(command, pathValue = process.env.PATH, pathextValue = process.env.PATHEXT) {
  if (!command) return null;
  if (command.includes(path.sep) && fs.existsSync(command)) return command;
  const paths = (pathValue || "").split(path.delimiter);
  const extensions = process.platform === "win32"
    ? ["", ...(pathextValue || ".COM;.EXE;.BAT;.CMD").split(";")]
    : [""];
  for (const dir of paths) {
    for (const extension of extensions) {
      const candidate = path.join(dir, `${command}${extension}`);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
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
    const filePath = path.join(process.cwd(), ".nordrelay", "state.sqlite");
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
      detail: `NORDRELAY_STATE_BACKEND=sqlite failed: ${error instanceof Error ? error.message : String(error)}`,
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
  console.log("  doctor               Validate the local setup");
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
  console.log("  --build              Build source runtime before start/web/restart");
  console.log("  --force              Overwrite existing config during init");
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
  if (options.command === "--version" || options.command === "version") {
    console.log(`${APP_NAME} ${VERSION}`);
    return;
  }

  console.error(`Unknown command: ${options.command}`);
  console.error("Usage: nordrelay [init|user|peer|doctor|web|start|stop|restart|status|update|foreground|version]");
  console.error("Run `nordrelay --help` for details.");
  process.exitCode = 2;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
