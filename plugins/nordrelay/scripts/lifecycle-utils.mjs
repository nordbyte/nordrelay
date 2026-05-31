import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export function commonNpmGlobalBinDirs(env = process.env) {
  if (process.platform === "win32") {
    return [
      env.APPDATA ? path.join(env.APPDATA, "npm") : null,
      path.dirname(process.execPath),
    ].filter(Boolean);
  }
  const home = os.homedir();
  return [
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".npm-packages", "bin"),
    path.join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    path.dirname(process.execPath),
  ];
}

export function npmSelfUpdatePermissionCheck(npm, env = process.env) {
  if (!npm) return { ok: false, detail: "npm was not found; npm self-update cannot run.", fix: "Install Node.js/npm or add npm to PATH." };
  const cache = resolveNpmConfigValue(npm, ["config", "get", "cache"], env);
  const root = resolveNpmConfigValue(npm, ["root", "-g"], env);
  const prefix = env.npm_config_prefix ? path.resolve(env.npm_config_prefix) : resolveNpmConfigValue(npm, ["prefix", "-g"], env);
  const issues = [];
  const fixPaths = new Set();
  for (const target of [
    { label: "npm cache", path: cache, scanOwnership: true },
    { label: "npm global package root", path: root, scanOwnership: false },
    { label: "NordRelay package scope", path: root ? path.join(root, "@nordbyte") : null, scanOwnership: true },
    { label: "NordRelay package", path: root ? path.join(root, "@nordbyte", "nordrelay") : null, scanOwnership: true },
  ]) {
    const result = checkNpmUpdatePath(target.path, target.label, target.scanOwnership);
    if (result.ok) continue;
    issues.push(result.detail);
    for (const fixPath of [cache, prefix, result.path].filter(Boolean)) {
      if (isPathInsideHome(fixPath)) fixPaths.add(path.resolve(fixPath));
    }
  }
  if (!issues.length) return { ok: true, detail: `ok${cache ? `; cache ${cache}` : ""}${root ? `; global root ${root}` : ""}` };
  return { ok: false, detail: `npm self-update permissions are not safe: ${issues.join("; ")}.`, fix: npmOwnershipFix([...fixPaths]) };
}

export function validPid(value) {
  const pid = Number(value);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

export async function waitForManagedAppPidToExit(state, timeoutMs, deps) {
  const wrapperPid = validPid(state?.pid);
  const appPid = validPid(state?.appPid);
  if (!appPid || appPid === wrapperPid) return true;
  const remaining = await waitForProcessesExit([appPid], timeoutMs, deps.isProcessRunning, deps.sleep);
  if (remaining.length === 0) return true;
  deps.log?.(`Runtime app PID ${appPid} is still shutting down; sending SIGTERM.`);
  try {
    process.kill(appPid, "SIGTERM");
  } catch {
    return true;
  }
  const afterTerm = await waitForProcessesExit([appPid], 3000, deps.isProcessRunning, deps.sleep);
  if (afterTerm.length === 0) return true;
  deps.log?.(`Runtime app PID ${appPid} did not exit after SIGTERM.`);
  process.exitCode = 1;
  return false;
}

export async function waitForRestartSettle(options, settings, deps) {
  const state = await deps.readJson(options.stateFile, {});
  const pids = uniquePids([
    await deps.readPid(options.pidFile),
    Number(state?.pid),
    Number(state?.appPid),
  ]);
  const remaining = await waitForProcessesExit(pids, 2500, deps.isProcessRunning, deps.sleep);
  if (remaining.length > 0) {
    deps.log?.(`Waiting for previous runtime process(es) to exit: ${remaining.join(", ")}`);
    await waitForProcessesExit(remaining, 2500, deps.isProcessRunning, deps.sleep);
  }

  for (const endpoint of restartPortChecks(options, settings, deps)) {
    const released = await waitForTcpClosed(endpoint, deps.portReleaseTimeoutMs, deps.sleep);
    if (!released) {
      deps.log?.(`Waiting timed out for ${endpoint.label} port ${endpoint.host}:${endpoint.port} to close.`);
    }
  }
}

export async function waitForProcessesExit(pids, timeoutMs, isProcessRunning, sleep) {
  const watched = uniquePids(pids);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const running = watched.filter(isProcessRunning);
    if (running.length === 0) return [];
    await sleep(150);
  }
  return watched.filter(isProcessRunning);
}

export async function waitForTcpClosed(endpoint, timeoutMs, sleep) {
  const host = connectHostForBindHost(endpoint.host);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await tcpPortAcceptsConnection(host, endpoint.port, 300))) return true;
    await sleep(150);
  }
  return !(await tcpPortAcceptsConnection(host, endpoint.port, 300));
}

export async function waitForTcpListening(endpoint, timeoutMs, sleep) {
  const host = connectHostForBindHost(endpoint.host);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await tcpPortAcceptsConnection(host, endpoint.port, 300)) return true;
    await sleep(150);
  }
  return false;
}

export function waitForDetachedChildStartup(child, timeoutMs) {
  return new Promise((resolve) => {
    let timer = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const onError = (error) => {
      cleanup();
      resolve({ error });
    };
    const onExit = (code, signal) => {
      cleanup();
      resolve({ exited: true, code, signal });
    };
    timer = setTimeout(() => {
      cleanup();
      resolve({ exited: false });
    }, timeoutMs);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function resolveNpmConfigValue(npm, args, env = process.env) {
  const command = npm.shell ? formatShellCommand(npm.command, [...npm.argsPrefix, ...args]) : npm.command;
  const result = spawnSync(command, npm.shell ? [] : [...npm.argsPrefix, ...args], {
    cwd: os.homedir(),
    env,
    shell: npm.shell,
    encoding: "utf8",
    windowsHide: true,
    timeout: 5000,
  });
  if (result.status !== 0) return null;
  const value = String(result.stdout || "").trim().split(/\r?\n/).at(-1)?.trim();
  return value && value !== "undefined" && value !== "null" ? path.resolve(value) : null;
}

function checkNpmUpdatePath(targetPath, label, scanOwnership) {
  if (!targetPath) return { ok: true, detail: `${label}: unavailable` };
  const resolved = path.resolve(targetPath);
  const existing = nearestExistingPath(resolved);
  if (!existing) return { ok: true, detail: `${label}: ${resolved}` };
  const targetExists = fs.existsSync(resolved);
  try {
    fs.accessSync(existing, fs.constants.W_OK);
  } catch {
    return { ok: false, path: existing, detail: `${label} is not writable (${existing})` };
  }
  if (scanOwnership && targetExists) {
    const foreign = firstForeignOwnedPath(resolved);
    if (foreign) return { ok: false, path: foreign.path, detail: `${label} contains files owned by uid ${foreign.uid} (${foreign.path})` };
  }
  return { ok: true, detail: `${label}: ${resolved}` };
}

function nearestExistingPath(targetPath) {
  let current = path.resolve(targetPath);
  while (current && current !== path.dirname(current)) {
    if (fs.existsSync(current)) return current;
    current = path.dirname(current);
  }
  return fs.existsSync(current) ? current : null;
}

function firstForeignOwnedPath(root, maxEntries = 5000, maxDepth = 5) {
  if (typeof process.getuid !== "function") return null;
  const uid = process.getuid();
  const queue = [{ file: root, depth: 0 }];
  let scanned = 0;
  while (queue.length && scanned < maxEntries) {
    const item = queue.shift();
    scanned += 1;
    let stat;
    try { stat = fs.lstatSync(item.file); } catch { continue; }
    if (stat.uid !== uid) return { path: item.file, uid: stat.uid };
    if (!stat.isDirectory() || item.depth >= maxDepth) continue;
    let entries = [];
    try { entries = fs.readdirSync(item.file, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) queue.push({ file: path.join(item.file, entry.name), depth: item.depth + 1 });
  }
  return null;
}

function npmOwnershipFix(paths) {
  if (typeof process.getuid !== "function" || typeof process.getgid !== "function" || !paths.length) {
    return "Fix npm cache/global-prefix permissions, then retry the update.";
  }
  const unique = [...new Set(paths.map((item) => path.resolve(item)))];
  return `Run: sudo chown -R ${process.getuid()}:${process.getgid()} ${unique.map(quoteShellArg).join(" ")}`;
}

function isPathInsideHome(targetPath) {
  const home = normalizePathForCompare(os.homedir());
  const candidate = normalizePathForCompare(path.resolve(targetPath));
  return candidate === home || candidate.startsWith(`${home}${path.sep}`);
}

function normalizePathForCompare(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function formatShellCommand(command, args) {
  return [command, ...args].map(quoteShellArg).join(" ");
}

function quoteShellArg(value) {
  const text = String(value);
  if (process.platform === "win32") return `"${text.replace(/"/g, '\\"')}"`;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function uniquePids(values) {
  return [...new Set(values.map(validPid).filter(Boolean))];
}

function restartPortChecks(options, settings, deps) {
  const endpoints = [];
  if (settings.webWasRunning) {
    const dashboard = deps.resolveDashboardEndpoint(options);
    endpoints.push({ label: "WebUI", host: dashboard.host, port: dashboard.port });
  }
  if (process.env.NORDRELAY_PEER_ENABLED === "true") {
    endpoints.push({
      label: "peer",
      host: process.env.NORDRELAY_PEER_HOST || "127.0.0.1",
      port: Number.parseInt(process.env.NORDRELAY_PEER_PORT || "31979", 10),
    });
  }
  if (process.env.TELEGRAM_TRANSPORT === "webhook") {
    endpoints.push({
      label: "Telegram webhook",
      host: process.env.TELEGRAM_WEBHOOK_HOST || "127.0.0.1",
      port: Number.parseInt(process.env.TELEGRAM_WEBHOOK_PORT || "8080", 10),
    });
  }
  if (process.env.SLACK_ENABLED === "true" && process.env.SLACK_SOCKET_MODE === "false") {
    endpoints.push({
      label: "Slack HTTP",
      host: "127.0.0.1",
      port: Number.parseInt(process.env.SLACK_PORT || "3000", 10),
    });
  }
  return endpoints.filter((endpoint) => deps.isValidPort(endpoint.port));
}

function tcpPortAcceptsConnection(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function connectHostForBindHost(host) {
  if (!host || host === "0.0.0.0") return "127.0.0.1";
  if (host === "::") return "::1";
  return host;
}
