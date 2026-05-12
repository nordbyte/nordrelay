#!/usr/bin/env node
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const VERSION = "0.2.0";
const APP_NAME = "nordrelay";
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PLUGIN_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const DEFAULT_MARKETPLACE_ROOT = path.resolve(PLUGIN_ROOT, "../..");
const RUNTIME_ROOT = findRuntimeRoot();
const DEFAULT_HOME = path.join(os.homedir(), ".codex", "nordrelay");

function nowIso() {
  return new Date().toISOString();
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
  };

  for (let i = 0; i < copy.length; i += 1) {
    const arg = copy[i];
    if (arg === "--home") options.home = requireValue(copy, ++i, arg);
    else if (arg === "--keep-pending-updates") options.dropPendingUpdates = false;
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
  const files = [
    path.join(process.cwd(), ".env"),
    path.join(RUNTIME_ROOT, ".env"),
    path.join(PLUGIN_ROOT, ".env"),
    path.join(home, "nordrelay.env"),
  ];

  for (const envPath of files) {
    loadEnvFile(envPath);
  }

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
    console.log(state.error || "Unknown error");
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
  console.log(`Log: ${options.logFile}`);
  if (state.error) console.log(`Error: ${state.error}`);
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

  await writeJsonAtomic(options.stateFile, {
    status: exit.code === 0 ? "stopped" : "error",
    pid: process.pid,
    updatedAt: nowIso(),
    exitCode: exit.code,
    signal: exit.signal,
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
      if (pkg?.name === APP_NAME || pkg?.name === "nordrelay") {
        return root;
      }
    } catch {
      // Try the next candidate.
    }
  }

  return DEFAULT_MARKETPLACE_ROOT;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === "start") return commandStart(options);
  if (options.command === "stop") return commandStop(options);
  if (options.command === "status") return commandStatus(options);
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
  console.error("Usage: nordrelay [start|stop|restart|status|foreground]");
  process.exitCode = 2;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
