import net from "node:net";
import os from "node:os";
import path from "node:path";

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
