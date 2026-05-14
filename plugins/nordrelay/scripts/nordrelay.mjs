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
  };

  for (let i = 0; i < copy.length; i += 1) {
    const arg = copy[i];
    if (arg === "--home") options.home = requireValue(copy, ++i, arg);
    else if (arg === "--keep-pending-updates") options.dropPendingUpdates = false;
    else if (arg === "--force") options.force = true;
    else if (arg === "--host") options.host = requireValue(copy, ++i, arg);
    else if (arg === "--port") options.port = Number.parseInt(requireValue(copy, ++i, arg), 10);
    else if (arg === "--method") options.updateMethod = requireValue(copy, ++i, arg);
    else if (arg === "--no-restart") options.restartAfterUpdate = false;
    else if (arg === "--restart") options.restartAfterUpdate = true;
    else if (arg === "--token") options.telegramBotToken = requireValue(copy, ++i, arg);
    else if (arg === "--admin-email") options.adminEmail = requireValue(copy, ++i, arg);
    else if (arg === "--admin-name") options.adminName = requireValue(copy, ++i, arg);
    else if (arg === "--admin-password") options.adminPassword = requireValue(copy, ++i, arg);
    else if (arg === "--telegram-user-id") options.telegramUserId = requireValue(copy, ++i, arg);
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
  const child = spawn(process.execPath, [SCRIPT_PATH, "foreground", ...options.rawFlags], {
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
      console.log(`WebUI: ${formatDashboardUrl(dashboard)} (run \`nordrelay web\` to start it)`);
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
    console.log(`WebUI: ${formatDashboardUrl(dashboard)} (run \`nordrelay web\` to start it)`);
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

async function commandStop(options) {
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
  const state = await readJson(options.stateFile, {});
  const running = isProcessRunning(pid);
  console.log(`Status: ${state.status || (running ? "running" : "stopped")}`);
  console.log(`PID: ${pid || "-"} (${running ? "running" : "not running"})`);
  console.log(`Workspace: ${state.workspace || "-"}`);
  console.log(`Mode: ${state.sessionMode || "per Telegram context"}`);
  console.log(`Auth: ${state.authenticated === undefined ? "-" : state.authenticated ? "yes" : "no"}`);
  console.log(`Codex CLI: ${state.codexCli || "-"}`);
  console.log(`Pi CLI: ${state.piCli || "-"}`);
  console.log(`Hermes CLI: ${state.hermesCli || "-"}`);
  console.log(`OpenClaw CLI: ${state.openClawCli || "-"}`);
  console.log(`Claude Code CLI: ${state.claudeCodeCli || "-"}`);
  console.log(`OpenClaw Gateway: ${state.openClawGateway || process.env.OPENCLAW_GATEWAY_URL || "-"}`);
  console.log(`WebUI: ${formatDashboardUrl(dashboard)}`);
  console.log(`Log: ${options.logFile}`);
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
  const child = spawn(command, args, {
    cwd: settings.cwd || RUNTIME_ROOT,
    env: process.env,
    shell: Boolean(settings.shell),
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

async function commandInit(options) {
  await mkdirp(options.home);
  const envPath = path.join(options.home, "nordrelay.env");
  const userStore = await createUserStore(options.home);
  if (fs.existsSync(envPath) && !options.force) {
    console.log(`Config already exists: ${envPath}`);
    console.log("Run with --force to overwrite.");
    return;
  }

  const telegramBotToken = options.telegramBotToken ||
    process.env.TELEGRAM_BOT_TOKEN ||
    await ask(null, "Telegram bot token", "");
  const adminEmail = options.adminEmail || await ask(null, "Admin email", "");
  const adminName = options.adminName || await ask(null, "Admin name", "Admin");
  const adminPassword = options.adminPassword || await askSecret(null, "Admin password", "");
  const telegramUserId = options.telegramUserId || await ask(null, "Optional Telegram user id to link", "");
  const enableCodex = options.disableCodex ? "false" : await askChoice(null, "Enable Codex", "true");
  const enablePi = options.enablePi ? "true" : await askChoice(null, "Enable Pi", "false");
  const enableHermes = options.enableHermes ? "true" : await askChoice(null, "Enable Hermes", "false");
  const enableOpenClaw = options.enableOpenClaw ? "true" : await askChoice(null, "Enable OpenClaw", "false");
  const enableClaudeCode = options.enableClaudeCode ? "true" : await askChoice(null, "Enable Claude Code", "false");
  const stateBackend = options.stateBackend || await askChoice(null, "State backend (json/sqlite)", "json");

  if (!telegramBotToken) throw new Error("Telegram bot token is required.");
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
    `TELEGRAM_BOT_TOKEN=${telegramBotToken}`,
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
      ? store.createAdmin({ email, displayName: name, password, telegramUserId: flags.telegramUserId })
      : store.createUser({ email, displayName: name, password, groupIds, telegramUserId: flags.telegramUserId });
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

  if (flags.subcommand === "link-code") {
    const email = flags.email || await ask(null, "Email", "");
    const user = store.getUserByEmail(email);
    if (!user) throw new Error(`User not found: ${email}`);
    const code = store.createTelegramLinkCode(user.user.id);
    console.log(`Telegram link code for ${user.user.email}: ${code.code}`);
    console.log(`Expires: ${code.expiresAt}`);
    return;
  }

  throw new Error("Usage: nordrelay user [list|create-admin|create|reset-password|link-telegram|link-code]");
}

async function commandDoctor(options) {
  await mkdirp(options.home);
  loadEnvFiles(options.home);
  const userStore = await createUserStore(options.home).catch(() => null);
  const userSnapshot = userStore?.snapshot();
  const checks = [];
  checks.push(check("Node.js >= 22", Number.parseInt(process.versions.node.split(".")[0], 10) >= 22, process.version));
  checks.push(check("Telegram bot token", Boolean(process.env.TELEGRAM_BOT_TOKEN), process.env.TELEGRAM_BOT_TOKEN ? "configured" : "missing"));
  checks.push(check("User store", Boolean(userStore), userStore ? userStore.filePath : "missing runtime", userStore ? "pass" : "fail"));
  checks.push(check("Admin user", Boolean(userSnapshot?.adminConfigured), userSnapshot?.adminConfigured ? "configured" : "missing"));
  checks.push(check("WebUI login", true, "required for every dashboard request"));
  checks.push(check("Telegram access", true, "requires linked active users and enabled group chats"));
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
  const { host, port } = resolveDashboardEndpoint(options, { strict: true });
  await ensureConnectorStartedForWeb(options);
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
  const child = spawn(entry.command, [...entry.args, "--host", host, "--port", String(port), "--home", options.home], {
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
  if (exit.signal) {
    process.kill(process.pid, exit.signal);
    return;
  }
  process.exit(exit.code ?? 0);
}

async function commandForeground(options) {
  await mkdirp(options.home);
  loadEnvFiles(options.home);
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

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === "start") return commandStart(options);
  if (options.command === "stop") return commandStop(options);
  if (options.command === "status") return commandStatus(options);
  if (options.command === "init") return commandInit(options);
  if (options.command === "user") return commandUser(options);
  if (options.command === "doctor") return commandDoctor(options);
  if (options.command === "update") return commandUpdate(options);
  if (options.command === "web" || options.command === "dashboard") return commandWeb(options);
  if (options.command === "restart") {
    await commandStop(options);
    return commandStart(options);
  }
  if (options.command === "foreground") return commandForeground(options);
  if (options.command === "--version" || options.command === "version") {
    console.log(`${APP_NAME} ${VERSION}`);
    return;
  }

  console.error(`Unknown command: ${options.command}`);
  console.error("Usage: nordrelay [init|user|doctor|web|start|stop|restart|status|update|foreground|version]");
  process.exitCode = 2;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
