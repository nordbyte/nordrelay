import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

export async function cliAutostartChecks(options) {
  const connectorEnabled = process.env.NORDRELAY_AUTOSTART_ENABLED === "true";
  const webuiEnabled = process.env.NORDRELAY_WEBUI_AUTOSTART_ENABLED === "true";
  if (!connectorEnabled && !webuiEnabled) {
    return [check("Autostart", true, "disabled by config")];
  }

  const checks = [];
  if (process.platform === "linux") {
    if (connectorEnabled) {
      checks.push(systemdUserServiceDoctorCheck("Connector autostart", "nordrelay.service", options));
    }
    if (webuiEnabled) {
      checks.push(systemdUserServiceDoctorCheck("WebUI autostart", "nordrelay-webui.service", options));
    }
    const linger = quietCommand("loginctl", ["show-user", process.env.USER || "", "-p", "Linger", "--value"], options.runtimeRoot);
    const lingerValue = linger.stdout.trim();
    checks.push(check(
      "Linux user lingering",
      linger.ok && lingerValue === "yes",
      linger.ok ? `Linger=${lingerValue || "unknown"}` : `loginctl unavailable: ${linger.detail}`,
      "warn",
      options.lingerFix,
    ));
  } else if (process.platform === "darwin") {
    if (connectorEnabled) {
      checks.push(await launchdServiceDoctorCheck("Connector autostart", "io.nordbyte.nordrelay", options));
    }
    if (webuiEnabled) {
      checks.push(await launchdServiceDoctorCheck("WebUI autostart", "io.nordbyte.nordrelay.webui", options));
    }
  } else if (process.platform === "win32") {
    if (connectorEnabled) {
      checks.push(windowsTaskDoctorCheck("Connector autostart", "NordRelay", options));
    }
    if (webuiEnabled) {
      checks.push(windowsTaskDoctorCheck("WebUI autostart", "NordRelay WebUI", options));
    }
  } else {
    checks.push(check("Autostart", false, `${process.platform} autostart is not supported by Doctor`, "warn"));
  }

  checks.push(await cliServiceWorkspaceCheck(options));
  if (webuiEnabled && options.webuiRuntimeEnabled) {
    checks.push(await cliPortListeningCheck("WebUI service port", options.dashboardEndpoint.host, options.dashboardEndpoint.port));
  }
  if (process.env.NORDRELAY_PEER_ENABLED === "true") {
    checks.push(await cliPortListeningCheck(
      "Peer service port",
      process.env.NORDRELAY_PEER_HOST || "127.0.0.1",
      Number.parseInt(process.env.NORDRELAY_PEER_PORT || "31979", 10) || 31979,
    ));
  }
  return checks;
}

function systemdUserServiceDoctorCheck(name, unit, options) {
  const enabled = quietCommand("systemctl", ["--user", "is-enabled", unit], options.runtimeRoot);
  const active = quietCommand("systemctl", ["--user", "is-active", unit], options.runtimeRoot);
  const show = quietCommand("systemctl", ["--user", "show", unit, "--property=LoadState,UnitFileState,ActiveState,SubState,MainPID,ExecMainStartTimestamp,FragmentPath,WorkingDirectory,Environment,ExecStart"], options.runtimeRoot);
  const props = parseKeyValueOutput(show.stdout, "=");
  const enabledValue = enabled.stdout.trim();
  const activeValue = active.stdout.trim();
  const unitFileState = props.UnitFileState || enabledValue;
  const activeState = props.ActiveState || activeValue;
  const mainPid = props.MainPID && props.MainPID !== "0" ? props.MainPID : "";
  const owner = mainPid ? processOwner(mainPid, options.runtimeRoot) : "";
  const expectedUser = currentUsername();
  const ownerOk = !owner || !expectedUser || owner === expectedUser;
  return check(
    name,
    (unitFileState === "enabled" || enabledValue === "enabled") && activeState === "active" && ownerOk,
    [
      `boot=${unitFileState || enabledValue || (enabled.ok ? "unknown" : "not enabled")}`,
      `active=${activeState || activeValue || (active.ok ? "unknown" : "inactive")}`,
      mainPid ? `pid=${mainPid}` : "",
      owner ? `user=${owner}` : expectedUser ? `user=${expectedUser}` : "",
      props.ExecMainStartTimestamp ? `started=${props.ExecMainStartTimestamp}` : "",
      props.WorkingDirectory ? `cwd=${props.WorkingDirectory}` : "cwd=systemd default",
      `workspace=${options.workspace}`,
      `home=${extractServiceHome(props.Environment, props.ExecStart) || options.home}`,
      props.FragmentPath ? `unit=${props.FragmentPath}` : "",
    ].filter(Boolean).join("; "),
    "warn",
    options.repairFix,
  );
}

async function launchdServiceDoctorCheck(name, label, options) {
  const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
  const content = await readTextFile(plistPath);
  const printed = quietCommand("launchctl", ["print", `${launchdDomain()}/${label}`], options.runtimeRoot);
  const disabled = launchdDisabled(label, options.runtimeRoot);
  const runAtLoad = plistBoolean(content, "RunAtLoad");
  const keepAlive = plistBoolean(content, "KeepAlive");
  const pid = /(?:^|\n)\s*pid\s*=\s*(\d+)/.exec(printed.stdout)?.[1] || "";
  return check(
    name,
    Boolean(content) && printed.ok && !disabled && runAtLoad && keepAlive,
    [
      `loaded=${printed.ok ? "yes" : "no"}`,
      `enabled=${disabled ? "no" : "yes"}`,
      `RunAtLoad=${runAtLoad ? "true" : "false"}`,
      `KeepAlive=${keepAlive ? "true" : "false"}`,
      pid ? `pid=${pid}` : "",
      `user=${currentUsername() || "unknown"}`,
      `workspace=${options.workspace}`,
      `home=${plistHome(content) || options.home}`,
      `plist=${plistPath}`,
    ].filter(Boolean).join("; "),
    "warn",
    options.repairFix,
  );
}

function windowsTaskDoctorCheck(name, taskName, options) {
  const result = quietCommand("schtasks", ["/Query", "/TN", taskName, "/FO", "LIST", "/V"], options.runtimeRoot);
  const props = parseKeyValueOutput(result.stdout, ":");
  const status = props.Status || "";
  const schedule = props["Schedule Type"] || props["Task To Run"] || "";
  return check(
    name,
    result.ok && !/^disabled$/i.test(status) && /logon/i.test(schedule),
    [
      `installed=${result.ok ? "yes" : "no"}`,
      status ? `status=${status}` : "",
      schedule ? `schedule=${schedule}` : "",
      props["Run As User"] ? `user=${props["Run As User"]}` : currentUsername() ? `user=${currentUsername()}` : "",
      `workspace=${options.workspace}`,
      `home=${extractWindowsTaskHome(props["Task To Run"] || "") || options.home}`,
    ].filter(Boolean).join("; ") || result.detail,
    "warn",
    options.repairFix,
  );
}

async function cliServiceWorkspaceCheck(options) {
  const state = await readJson(path.join(options.home, "state.json"), {});
  const reported = typeof state.workspace === "string" ? state.workspace : "";
  return check(
    "Service workspace",
    !reported || path.resolve(reported) === path.resolve(options.workspace),
    [`configured=${options.workspace}`, reported ? `reported=${reported}` : "reported=not running", `home=${options.home}`].join("; "),
    "warn",
  );
}

async function cliPortListeningCheck(name, host, port) {
  const connectHost = connectHostForBindHost(host);
  const listening = await checkLocalPort(connectHost, port);
  return check(name, listening, listening ? `listening on ${connectHost}:${port}` : `not listening on ${connectHost}:${port}`, "warn");
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

function parseKeyValueOutput(source, separator) {
  const props = {};
  for (const line of String(source || "").split(/\r?\n/)) {
    const index = line.indexOf(separator);
    if (index <= 0) continue;
    props[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return props;
}

function processOwner(pid, runtimeRoot) {
  const result = quietCommand("ps", ["-o", "user=", "-p", String(pid)], runtimeRoot);
  return result.ok ? result.stdout.trim() : "";
}

function currentUsername() {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USER || process.env.USERNAME || "";
  }
}

function extractServiceHome(environment, execStart) {
  const envHome = /(?:^|\s)NORDRELAY_HOME=(?:"([^"]+)"|'([^']+)'|([^\s;]+))/.exec(environment || "");
  if (envHome) return envHome[1] || envHome[2] || envHome[3] || "";
  const execHome = /--home(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s;]+))/.exec(execStart || "");
  return execHome ? execHome[1] || execHome[2] || execHome[3] || "" : "";
}

async function readTextFile(filePath) {
  try {
    return await fsp.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function launchdDomain() {
  return `gui/${process.getuid?.() ?? ""}`;
}

function launchdDisabled(label, runtimeRoot) {
  const result = quietCommand("launchctl", ["print-disabled", launchdDomain()], runtimeRoot);
  if (!result.ok) return false;
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`"${escaped}"\\s*=>\\s*true`).test(result.stdout);
}

function plistBoolean(source, key) {
  return new RegExp(`<key>${key}</key>\\s*<true\\s*/>`, "i").test(source);
}

function plistHome(source) {
  const match = /<key>NORDRELAY_HOME<\/key>\s*<string>([^<]+)<\/string>/i.exec(source);
  return match ? unescapeXml(match[1] || "") : "";
}

function unescapeXml(value) {
  return String(value)
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

function extractWindowsTaskHome(command) {
  const match = /--home(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s]+))/.exec(command || "");
  return match ? match[1] || match[2] || match[3] || "" : "";
}

function checkLocalPort(host, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const finish = (ok) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(700);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

function connectHostForBindHost(host) {
  if (!host || host === "0.0.0.0") return "127.0.0.1";
  if (host === "::") return "::1";
  return host;
}

function quietCommand(command, args, runtimeRoot) {
  const result = spawnSync(command, args, {
    cwd: runtimeRoot || process.cwd(),
    env: process.env,
    encoding: "utf8",
    stdio: "pipe",
    windowsHide: true,
  });
  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  const detail = [stdout.trim(), stderr.trim(), result.error?.message].filter(Boolean).join("; ");
  return {
    ok: !result.error && result.status === 0,
    stdout,
    detail: detail || `exit ${result.status ?? "unknown"}`,
  };
}
