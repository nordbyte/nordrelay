#!/usr/bin/env node
import fs from "node:fs";
import fsp from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

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
  if (copy[0] && !copy[0].startsWith("-")) {
    command = copy.shift();
  }

  const options = {
    command,
    rawFlags: copy,
    home: process.env.NORDRELAY_HOME || DEFAULT_HOME,
    dropPendingUpdates: !envFlag("NORDRELAY_KEEP_PENDING_UPDATES"),
    force: false,
    host: process.env.NORDRELAY_DASHBOARD_HOST || "127.0.0.1",
    port: Number.parseInt(process.env.NORDRELAY_DASHBOARD_PORT || "31878", 10),
  };

  for (let i = 0; i < copy.length; i += 1) {
    const arg = copy[i];
    if (arg === "--home") options.home = requireValue(copy, ++i, arg);
    else if (arg === "--keep-pending-updates") options.dropPendingUpdates = false;
    else if (arg === "--force") options.force = true;
    else if (arg === "--host") options.host = requireValue(copy, ++i, arg);
    else if (arg === "--port") options.port = Number.parseInt(requireValue(copy, ++i, arg), 10);
    else if (arg === "--token") options.telegramBotToken = requireValue(copy, ++i, arg);
    else if (arg === "--admin-id") options.telegramAdminUserIds = requireValue(copy, ++i, arg);
    else if (arg === "--state-backend") options.stateBackend = requireValue(copy, ++i, arg);
    else if (arg === "--enable-pi") options.enablePi = true;
    else if (arg === "--enable-hermes") options.enableHermes = true;
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
  if (!process.env.TELEGRAM_ALLOWED_USER_IDS && process.env.TELEGRAM_ALLOWED_CHAT_IDS) {
    process.env.TELEGRAM_ALLOWED_USER_IDS = process.env.TELEGRAM_ALLOWED_CHAT_IDS;
  }

  if (!process.env.TELEGRAM_ALLOWED_CHAT_IDS && process.env.TELEGRAM_ALLOWED_USER_IDS) {
    process.env.TELEGRAM_ALLOWED_CHAT_IDS = process.env.TELEGRAM_ALLOWED_USER_IDS;
  }

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

async function commandStart(options) {
  await mkdirp(options.home);
  loadEnvFiles(options.home);

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
  console.log(`Startup is still in progress. Log: ${options.logFile}`);
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
  console.log(`Log: ${options.logFile}`);
  if (state.error) console.log(`Error: ${state.error}`);
}

async function commandInit(options) {
  await mkdirp(options.home);
  const envPath = path.join(options.home, "nordrelay.env");
  if (fs.existsSync(envPath) && !options.force) {
    console.log(`Config already exists: ${envPath}`);
    console.log("Run with --force to overwrite.");
    return;
  }

  const rl = process.stdin.isTTY
    ? readline.createInterface({ input: process.stdin, output: process.stdout })
    : null;
  try {
    const telegramBotToken = options.telegramBotToken ||
      process.env.TELEGRAM_BOT_TOKEN ||
      await ask(rl, "Telegram bot token", "");
    const telegramAdminUserIds = options.telegramAdminUserIds ||
      process.env.TELEGRAM_ADMIN_USER_IDS ||
      await ask(rl, "Telegram admin user id", "");
    const enableCodex = options.disableCodex ? "false" : await askChoice(rl, "Enable Codex", "true");
    const enablePi = options.enablePi ? "true" : await askChoice(rl, "Enable Pi", "false");
    const enableHermes = options.enableHermes ? "true" : await askChoice(rl, "Enable Hermes", "false");
    const stateBackend = options.stateBackend || await askChoice(rl, "State backend (json/sqlite)", "json");

    if (!telegramBotToken) throw new Error("Telegram bot token is required.");
    if (!telegramAdminUserIds) throw new Error("Telegram admin user id is required.");
    if (enableCodex !== "true" && enablePi !== "true" && enableHermes !== "true") throw new Error("At least one agent must be enabled.");
    const defaultAgent = enableCodex === "true" ? "codex" : enablePi === "true" ? "pi" : "hermes";

    const lines = [
      "# NordRelay local runtime config.",
      "# Keep this file private; it contains bot credentials.",
      `TELEGRAM_BOT_TOKEN=${telegramBotToken}`,
      `TELEGRAM_ADMIN_USER_IDS=${telegramAdminUserIds}`,
      "TELEGRAM_ALLOW_ANY_CHAT=false",
      `NORDRELAY_CODEX_ENABLED=${enableCodex}`,
      `NORDRELAY_PI_ENABLED=${enablePi}`,
      `NORDRELAY_HERMES_ENABLED=${enableHermes}`,
      `NORDRELAY_DEFAULT_AGENT=${defaultAgent}`,
      "PI_DEFAULT_PROFILE=default",
      "HERMES_API_BASE_URL=http://127.0.0.1:8642",
      "HERMES_DEFAULT_PROFILE=default",
      `NORDRELAY_STATE_BACKEND=${stateBackend === "sqlite" ? "sqlite" : "json"}`,
      "TELEGRAM_TRANSPORT=polling",
      "TELEGRAM_AUTO_SEND_ARTIFACTS=false",
      "",
    ];

    await fsp.writeFile(envPath, lines.join("\n"), { mode: 0o600 });
    await fsp.chmod(envPath, 0o600).catch(() => {});
    console.log(`Wrote ${envPath}`);
    console.log("Run `nordrelay doctor` to validate the setup.");
  } finally {
    rl?.close();
  }
}

async function commandDoctor(options) {
  await mkdirp(options.home);
  loadEnvFiles(options.home);
  const checks = [];
  checks.push(check("Node.js >= 22", Number.parseInt(process.versions.node.split(".")[0], 10) >= 22, process.version));
  checks.push(check("Telegram bot token", Boolean(process.env.TELEGRAM_BOT_TOKEN), process.env.TELEGRAM_BOT_TOKEN ? "configured" : "missing"));
  checks.push(check("Telegram admin ids", Boolean(process.env.TELEGRAM_ADMIN_USER_IDS), process.env.TELEGRAM_ADMIN_USER_IDS ? "configured" : "missing"));
  checks.push(check("Private by default", process.env.TELEGRAM_ALLOW_ANY_CHAT !== "true", "TELEGRAM_ALLOW_ANY_CHAT is not true"));
  checks.push(check("Codex enabled flag", process.env.NORDRELAY_CODEX_ENABLED !== "false", `NORDRELAY_CODEX_ENABLED=${process.env.NORDRELAY_CODEX_ENABLED ?? "true"}`));
  checks.push(check("Pi enabled flag", process.env.NORDRELAY_PI_ENABLED === "true" || process.env.NORDRELAY_PI_ENABLED === undefined, `NORDRELAY_PI_ENABLED=${process.env.NORDRELAY_PI_ENABLED ?? "false"}`, process.env.NORDRELAY_PI_ENABLED === "true" ? "pass" : "warn"));
  checks.push(check("Hermes enabled flag", process.env.NORDRELAY_HERMES_ENABLED === "true", `NORDRELAY_HERMES_ENABLED=${process.env.NORDRELAY_HERMES_ENABLED ?? "false"}`, process.env.NORDRELAY_HERMES_ENABLED === "true" ? "pass" : "warn"));
  checks.push(check("Codex CLI", Boolean(findExecutable(process.env.CODEX_CLI_PATH || "codex")), process.env.CODEX_CLI_PATH || findExecutable("codex") || "not found", process.env.NORDRELAY_CODEX_ENABLED === "false" ? "warn" : "fail"));
  checks.push(check("Pi CLI", Boolean(findExecutable(process.env.PI_CLI_PATH || "pi")), process.env.PI_CLI_PATH || findExecutable("pi") || "not found", process.env.NORDRELAY_PI_ENABLED === "true" ? "fail" : "warn"));
  checks.push(check("Hermes CLI", Boolean(findExecutable(process.env.HERMES_CLI_PATH || "hermes")), process.env.HERMES_CLI_PATH || findExecutable("hermes") || "not found", process.env.NORDRELAY_HERMES_ENABLED === "true" ? "fail" : "warn"));
  const hermesApiCheck = await checkHermesApiServer();
  checks.push(check("Hermes API Server", hermesApiCheck.ok, hermesApiCheck.detail, process.env.NORDRELAY_HERMES_ENABLED === "true" ? "fail" : "warn"));
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

async function commandWeb(options) {
  await mkdirp(options.home);
  loadEnvFiles(options.home);
  const host = options.host || "127.0.0.1";
  const port = Number.isFinite(options.port) ? options.port : 31878;
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
  await writeJsonAtomic(options.stateFile, {
    status: exit.code === 0 ? "stopped" : "error",
    pid: process.pid,
    updatedAt: nowIso(),
    exitCode: exit.code,
    signal: exit.signal,
    error: exit.code === 0 ? undefined : previousState.error,
    logFile: options.logFile,
  });

  if (exit.signal) {
    process.kill(process.pid, exit.signal);
    return;
  }
  process.exit(exit.code ?? 0);
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
  if (!rl) return defaultValue;
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  const answer = (await rl.question(`${label}${suffix}: `)).trim();
  return answer || defaultValue;
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

function findExecutable(command) {
  if (!command) return null;
  if (command.includes(path.sep) && fs.existsSync(command)) return command;
  const paths = (process.env.PATH || "").split(path.delimiter);
  for (const dir of paths) {
    const candidate = path.join(dir, command);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
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
  if (options.command === "doctor") return commandDoctor(options);
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
  console.error("Usage: nordrelay [init|doctor|web|start|stop|restart|status|foreground|version]");
  process.exitCode = 2;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
