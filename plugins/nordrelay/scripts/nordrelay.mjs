#!/usr/bin/env node
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const VERSION = "0.2.1";
const require = createRequire(import.meta.url);
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
    const stateBackend = options.stateBackend || await askChoice(rl, "State backend (json/sqlite)", "json");

    if (!telegramBotToken) throw new Error("Telegram bot token is required.");
    if (!telegramAdminUserIds) throw new Error("Telegram admin user id is required.");
    if (enableCodex !== "true" && enablePi !== "true") throw new Error("At least one agent must be enabled.");

    const lines = [
      "# NordRelay local runtime config.",
      "# Keep this file private; it contains bot credentials.",
      `TELEGRAM_BOT_TOKEN=${telegramBotToken}`,
      `TELEGRAM_ADMIN_USER_IDS=${telegramAdminUserIds}`,
      "TELEGRAM_ALLOW_ANY_CHAT=false",
      `NORDRELAY_CODEX_ENABLED=${enableCodex}`,
      `NORDRELAY_PI_ENABLED=${enablePi}`,
      `NORDRELAY_DEFAULT_AGENT=${enableCodex === "true" ? "codex" : "pi"}`,
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
  checks.push(check("Codex CLI", Boolean(findExecutable(process.env.CODEX_CLI_PATH || "codex")), process.env.CODEX_CLI_PATH || findExecutable("codex") || "not found", process.env.NORDRELAY_CODEX_ENABLED === "false" ? "warn" : "fail"));
  checks.push(check("Pi CLI", Boolean(findExecutable(process.env.PI_CLI_PATH || "pi")), process.env.PI_CLI_PATH || findExecutable("pi") || "not found", process.env.NORDRELAY_PI_ENABLED === "true" ? "fail" : "warn"));
  checks.push(check("ffmpeg", Boolean(findExecutable("ffmpeg")), findExecutable("ffmpeg") || "not found", "warn"));
  checks.push(check("State backend", validateStateBackend(), `NORDRELAY_STATE_BACKEND=${process.env.NORDRELAY_STATE_BACKEND ?? "json"}`));
  checks.push(check("Runtime entry", Boolean(await resolveRuntimeEntry()), RUNTIME_ROOT));

  for (const item of checks) {
    console.log(`${item.icon} ${item.name}: ${item.detail}`);
  }

  const failed = checks.filter((item) => item.status === "fail" && !item.ok);
  const warned = checks.filter((item) => item.status === "warn" && !item.ok);
  console.log(`\nSummary: ${failed.length} failed, ${warned.length} warnings.`);
  if (failed.length > 0) process.exitCode = 1;
}

async function commandWeb(options) {
  await mkdirp(options.home);
  loadEnvFiles(options.home);
  const host = options.host || "127.0.0.1";
  const port = Number.isFinite(options.port) ? options.port : 31878;
  const server = http.createServer(async (req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok\n");
      return;
    }
    const html = await renderDashboard(options);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  await new Promise((resolve) => server.listen(port, host, resolve));
  console.log(`NordRelay dashboard: http://${host}:${port}/`);
  await new Promise((resolve) => {
    const shutdown = () => server.close(resolve);
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
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
  if (backend === "json") return true;
  if (backend !== "sqlite") return false;
  try {
    require("better-sqlite3");
    return true;
  } catch {
    return false;
  }
}

async function renderDashboard(options) {
  const state = await readJson(options.stateFile, {});
  const workspace = state.workspace || process.cwd();
  const contexts = readStateDocument(workspace, "contexts.json", "contexts", []);
  const prompts = readStateDocument(workspace, "prompts.json", "prompts", {});
  const audit = readStateDocument(workspace, "audit.json", "audit", {});
  const logTail = await readTextTail(options.logFile, 80);
  const queueCount = Object.values(prompts.queues || {}).reduce((sum, queue) => sum + (Array.isArray(queue) ? queue.length : 0), 0);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>NordRelay Dashboard</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;margin:0;background:#f7f7f4;color:#181818}
    main{max-width:1100px;margin:0 auto;padding:32px}
    h1{font-size:28px;margin:0 0 18px}
    section{margin:18px 0;padding:18px;border:1px solid #d9d9d2;background:#fff;border-radius:8px}
    .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}
    .metric{padding:12px;border:1px solid #ecece6;border-radius:6px;background:#fbfbf8}
    .label{color:#5f625c;font-size:12px;text-transform:uppercase}
    .value{font-size:20px;margin-top:4px}
    pre{white-space:pre-wrap;word-break:break-word;max-height:360px;overflow:auto;background:#111;color:#f1f1ed;padding:14px;border-radius:6px}
    code{background:#efefea;padding:2px 4px;border-radius:4px}
  </style>
</head>
<body>
<main>
  <h1>NordRelay Dashboard</h1>
  <section class="grid">
    ${metric("Status", state.status || "unknown")}
    ${metric("Workspace", workspace)}
    ${metric("Contexts", Array.isArray(contexts) ? contexts.length : 0)}
    ${metric("Queued prompts", queueCount)}
    ${metric("Audit events", Array.isArray(audit.events) ? audit.events.length : 0)}
  </section>
  <section><h2>Runtime</h2><pre>${escapeHtml(JSON.stringify(state, null, 2))}</pre></section>
  <section><h2>Recent contexts</h2><pre>${escapeHtml(JSON.stringify(Array.isArray(contexts) ? contexts.slice(0, 20) : contexts, null, 2))}</pre></section>
  <section><h2>Log tail</h2><pre>${escapeHtml(logTail)}</pre></section>
</main>
</body>
</html>`;
}

function readStateDocument(workspace, fileName, sqliteKey, fallback) {
  if ((process.env.NORDRELAY_STATE_BACKEND || "json") === "sqlite") {
    const sqlite = readSqliteDocument(path.join(workspace, ".nordrelay", "state.sqlite"), sqliteKey);
    if (sqlite !== undefined) return sqlite;
  }
  return readJsonSync(path.join(workspace, ".nordrelay", fileName), fallback);
}

function readJsonSync(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function readSqliteDocument(filePath, sqliteKey) {
  if (!fs.existsSync(filePath)) return undefined;
  try {
    const Database = require("better-sqlite3");
    const db = new Database(filePath, { readonly: true, fileMustExist: true });
    const row = db.prepare("SELECT json FROM documents WHERE key = ?").get(sqliteKey);
    db.close?.();
    return typeof row?.json === "string" ? JSON.parse(row.json) : undefined;
  } catch {
    return undefined;
  }
}

function metric(label, value) {
  return `<div class="metric"><div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(String(value))}</div></div>`;
}

async function readTextTail(filePath, lines) {
  try {
    const text = await fsp.readFile(filePath, "utf8");
    return text.split(/\r?\n/).slice(-lines).join("\n").trim();
  } catch (error) {
    return `Cannot read ${filePath}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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
