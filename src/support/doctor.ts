import { spawnSync } from "node:child_process";
import net from "node:net";
import os from "node:os";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describeClaudeCodeCli, resolveClaudeCodeCli } from "../agents/claude-code/claude-code-cli.js";
import { describeCodexCli, findExecutableOnPath, resolveCodexCli } from "../agents/codex/codex-cli.js";
import { describeHermesCli, resolveHermesCli } from "../agents/hermes/hermes-cli.js";
import { describeOpenClawCli, resolveOpenClawCli } from "../agents/openclaw/openclaw-cli.js";
import { describePiCli, resolvePiCli } from "../agents/pi/pi-cli.js";
import type { ConnectorConfig } from "../core/config.js";
import { resolveDashboardEnvPath, SettingsService } from "../core/settings-service.js";
import { stateBackendPath, checkStateBackendAvailability } from "../state/state-backend.js";
import { UserStore } from "../access/user-management.js";
import { applyAutostartSettings } from "./autostart.js";
import { getConnectorHome, resolveNpmSpawnCommand } from "./operations.js";

export type DoctorStatus = "pass" | "warn" | "fail";

export interface DoctorFix {
  id: string;
  label: string;
  summary: string;
  safe: boolean;
  restartRequired?: boolean;
}

export interface DoctorCheck {
  id: string;
  name: string;
  ok: boolean;
  status: DoctorStatus;
  detail: string;
  fix?: DoctorFix;
}

export interface DoctorReport {
  generatedAt: string;
  home: string;
  envPath: string;
  summary: {
    failed: number;
    warnings: number;
    fixable: number;
  };
  checks: DoctorCheck[];
}

export interface DoctorFixResult {
  fixId: string;
  ok: boolean;
  message: string;
}

export interface DoctorFixResponse {
  results: DoctorFixResult[];
  report: DoctorReport;
}

export async function collectDoctorReport(config: ConnectorConfig, home = getConnectorHome()): Promise<DoctorReport> {
  const envPath = resolveDashboardEnvPath(home);
  const checks: DoctorCheck[] = [];
  const userStore = new UserStore(home);
  const statePath = stateBackendPath(config.workspace, config.stateBackend);
  const stateBackend = checkStateBackendAvailability(config.workspace, config.stateBackend);
  const npmCommand = resolveNpmSpawnCommand();

  checks.push(check("node", "Node.js >= 22", majorVersion(process.versions.node) >= 22, process.version));
  checks.push(await dirCheck("home", "Runtime home", home, "fail", fix("ensure-home", "Create runtime home", `Create ${home}.`)));
  checks.push(await envFileCheck(envPath));
  checks.push(check("webui", "WebUI enabled", config.webuiEnabled, config.webuiEnabled ? "enabled" : "disabled by NORDRELAY_WEBUI_ENABLED=false", "warn", fix("enable-webui", "Enable WebUI", "Set NORDRELAY_WEBUI_ENABLED=true.", true)));
  checks.push(check("access-surface", "Usable access surface", accessSurfaceEnabled(config), accessSurfaceDetail(config), "fail", fix("enable-webui", "Enable WebUI", "Enable WebUI so at least one access surface is reachable.", true)));
  checks.push(...await collectAutostartChecks(config, home));
  checks.push(check("admin-user", "Admin user", userStore.hasAdminUser(), userStore.hasAdminUser() ? "configured" : "missing; run nordrelay user create-admin", "fail"));
  checks.push(await dirCheck("state-dir", "Workspace state directory", path.dirname(statePath), "fail", fix("ensure-state-dir", "Create state directory", `Create ${path.dirname(statePath)}.`)));
  checks.push(check("state-backend", "State backend", stateBackend.ok, stateBackend.detail, "fail"));
  checks.push(check("npm", "npm command", Boolean(npmCommand), npmCommand?.display ?? "not found on PATH", "warn"));
  checks.push(agentCliCheck("codex-cli", "Codex CLI", config.codexEnabled, describeCodexCli(resolveCodexCli()), Boolean(resolveCodexCli().path) || resolveCodexCli().source === "bundled"));
  checks.push(agentCliCheck("pi-cli", "Pi CLI", config.piEnabled, describePiCli(resolvePiCli(process.env, config.piCliPath)), Boolean(resolvePiCli(process.env, config.piCliPath).path)));
  checks.push(agentCliCheck("hermes-cli", "Hermes CLI", config.hermesEnabled, describeHermesCli(resolveHermesCli(process.env, config.hermesCliPath)), Boolean(resolveHermesCli(process.env, config.hermesCliPath).path)));
  checks.push(agentCliCheck("openclaw-cli", "OpenClaw CLI", config.openClawEnabled, describeOpenClawCli(resolveOpenClawCli(process.env, config.openClawCliPath)), Boolean(resolveOpenClawCli(process.env, config.openClawCliPath).path)));
  checks.push(agentCliCheck("claude-code-cli", "Claude Code CLI", config.claudeCodeEnabled, describeClaudeCodeCli(resolveClaudeCodeCli(process.env, config.claudeCodeCliPath)), Boolean(resolveClaudeCodeCli(process.env, config.claudeCodeCliPath).path) || resolveClaudeCodeCli(process.env, config.claudeCodeCliPath).source === "bundled"));
  checks.push(check("ffmpeg", "ffmpeg", Boolean(findExecutableOnPath("ffmpeg", process.env.PATH, { pathext: process.env.PATHEXT })), findExecutableOnPath("ffmpeg", process.env.PATH, { pathext: process.env.PATHEXT }) ?? "not found; voice conversion may be unavailable", "warn"));

  for (const warning of config.adapterWarnings ?? []) {
    checks.push(check(`runtime-warning-${checks.length}`, "Runtime warning", false, warning, "warn"));
  }

  return {
    generatedAt: new Date().toISOString(),
    home,
    envPath,
    summary: {
      failed: checks.filter((item) => item.status === "fail" && !item.ok).length,
      warnings: checks.filter((item) => item.status === "warn" && !item.ok).length,
      fixable: checks.filter((item) => !item.ok && item.fix?.safe).length,
    },
    checks,
  };
}

export async function applyDoctorFixes(
  config: ConnectorConfig,
  home = getConnectorHome(),
  fixIds: string[] = [],
): Promise<DoctorFixResponse> {
  const report = await collectDoctorReport(config, home);
  const selected = new Set(fixIds.length ? fixIds : report.checks.map((item) => item.fix?.id).filter(Boolean));
  const seen = new Set<string>();
  const results: DoctorFixResult[] = [];

  for (const item of report.checks) {
    const fixId = item.fix?.id;
    if (item.ok || !fixId || !item.fix?.safe || seen.has(fixId) || !selected.has(fixId)) {
      continue;
    }
    seen.add(fixId);
    try {
      results.push({ fixId, ok: true, message: await applyDoctorFix(fixId, config, home) });
    } catch (error) {
      results.push({ fixId, ok: false, message: error instanceof Error ? error.message : String(error) });
    }
  }

  return {
    results,
    report: await collectDoctorReport(config, home),
  };
}

function check(id: string, name: string, ok: boolean, detail: string, status: DoctorStatus = "fail", itemFix?: DoctorFix): DoctorCheck {
  return { id, name, ok, detail, status, fix: itemFix };
}

function fix(id: string, label: string, summary: string, restartRequired = false): DoctorFix {
  return { id, label, summary, safe: true, restartRequired };
}

async function dirCheck(id: string, name: string, dir: string, status: DoctorStatus, itemFix?: DoctorFix): Promise<DoctorCheck> {
  try {
    await access(dir);
    return check(id, name, true, dir, status);
  } catch {
    return check(id, name, false, `${dir} does not exist or is not accessible`, status, itemFix);
  }
}

async function envFileCheck(envPath: string): Promise<DoctorCheck> {
  try {
    await access(envPath);
    return check("env-file", "Env file", true, envPath);
  } catch {
    return check("env-file", "Env file", false, `${envPath} is missing`, "warn", fix("create-env", "Create env file", `Create ${envPath} with WebUI enabled.`, true));
  }
}

function agentCliCheck(id: string, name: string, enabled: boolean, detail: string, available: boolean): DoctorCheck {
  if (!enabled) {
    return check(id, name, true, "disabled");
  }
  return check(id, name, available, detail, "fail");
}

function accessSurfaceEnabled(config: ConnectorConfig): boolean {
  return config.webuiEnabled || config.telegramEnabled || config.discordEnabled || config.slackEnabled || config.matrixEnabled;
}

function accessSurfaceDetail(config: ConnectorConfig): string {
  return [
    config.webuiEnabled ? "WebUI" : "",
    config.telegramEnabled ? "Telegram" : "",
    config.discordEnabled ? "Discord" : "",
    config.slackEnabled ? "Slack" : "",
    config.matrixEnabled ? "Matrix" : "",
  ].filter(Boolean).join(" and ") || "none";
}

async function applyDoctorFix(fixId: string, config: ConnectorConfig, home: string): Promise<string> {
  const envPath = resolveDashboardEnvPath(home);
  if (fixId === "ensure-home") {
    await mkdir(home, { recursive: true });
    return `Created ${home}.`;
  }
  if (fixId === "ensure-state-dir") {
    const dir = path.dirname(stateBackendPath(config.workspace, config.stateBackend));
    await mkdir(dir, { recursive: true });
    return `Created ${dir}.`;
  }
  if (fixId === "create-env") {
    await mkdir(path.dirname(envPath), { recursive: true });
    await writeFile(envPath, "# NordRelay runtime config managed by the dashboard.\nNORDRELAY_WEBUI_ENABLED=true\n", { mode: 0o600, flag: "wx" }).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
      await new SettingsService(envPath).update({ NORDRELAY_WEBUI_ENABLED: "true" });
    });
    return `Created ${envPath}.`;
  }
  if (fixId === "enable-webui") {
    await new SettingsService(envPath).update({ NORDRELAY_WEBUI_ENABLED: "true" });
    return `Set NORDRELAY_WEBUI_ENABLED=true in ${envPath}.`;
  }
  if (fixId === "repair-autostart") {
    const patch: Record<string, string> = {};
    if (config.autostartEnabled) patch.NORDRELAY_AUTOSTART_ENABLED = "true";
    if (config.webuiAutostartEnabled) patch.NORDRELAY_WEBUI_AUTOSTART_ENABLED = "true";
    const changedKeys = Object.keys(patch);
    if (changedKeys.length === 0) {
      return "Autostart is disabled in the current config.";
    }
    const errors = await applyAutostartSettings(patch, changedKeys, { home, runtimeRoot: runtimeRoot() });
    if (errors.length > 0) {
      throw new Error(errors.map((error) => `${error.key}: ${error.message}`).join("; "));
    }
    return `Reinstalled autostart entries for ${changedKeys.join(", ")}.`;
  }
  throw new Error(`Unsupported doctor fix: ${fixId}`);
}

function majorVersion(value: string): number {
  return Number.parseInt(value.split(".")[0] ?? "0", 10);
}

async function collectAutostartChecks(config: ConnectorConfig, home: string): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const autostartEnabled = config.autostartEnabled || config.webuiAutostartEnabled;
  if (!autostartEnabled) {
    checks.push(check("autostart", "Autostart", true, "disabled by config"));
    return checks;
  }

  if (process.platform === "linux") {
    if (config.autostartEnabled) {
      checks.push(systemdUserServiceCheck("connector-autostart", "Connector autostart", "nordrelay.service", home, config));
    }
    if (config.webuiAutostartEnabled) {
      checks.push(systemdUserServiceCheck("webui-autostart", "WebUI autostart", "nordrelay-webui.service", home, config));
    }

    const linger = commandOutput("loginctl", ["show-user", process.env.USER || "", "-p", "Linger", "--value"]);
    const lingerValue = linger.ok ? linger.stdout.trim() : "";
    checks.push(check(
      "linux-user-linger",
      "Linux user lingering",
      lingerValue === "yes",
      linger.ok ? `Linger=${lingerValue || "unknown"}` : `loginctl unavailable: ${linger.detail}`,
      "warn",
    ));
  } else if (process.platform === "darwin") {
    if (config.autostartEnabled) {
      checks.push(await launchdServiceCheck("connector-autostart", "Connector autostart", "io.nordbyte.nordrelay", home, config));
    }
    if (config.webuiAutostartEnabled) {
      checks.push(await launchdServiceCheck("webui-autostart", "WebUI autostart", "io.nordbyte.nordrelay.webui", home, config));
    }
  } else if (process.platform === "win32") {
    if (config.autostartEnabled) {
      checks.push(windowsTaskCheck("connector-autostart", "Connector autostart", "NordRelay", home, config));
    }
    if (config.webuiAutostartEnabled) {
      checks.push(windowsTaskCheck("webui-autostart", "WebUI autostart", "NordRelay WebUI", home, config));
    }
  } else {
    checks.push(check("autostart", "Autostart", false, `${process.platform} autostart is not supported by Doctor`, "warn"));
  }

  checks.push(await serviceWorkspaceCheck(home, config));
  if (config.webuiAutostartEnabled && config.webuiEnabled) {
    const endpoint = dashboardEndpointFromEnv();
    checks.push(await portListeningCheck("webui-service-port", "WebUI service port", endpoint.host, endpoint.port));
  }
  if (config.peerEnabled && autostartEnabled) {
    checks.push(await portListeningCheck("peer-service-port", "Peer service port", config.peerHost, config.peerPort));
  }

  return checks;
}

function systemdUserServiceCheck(id: string, name: string, unit: string, home: string, config: ConnectorConfig): DoctorCheck {
  const enabled = commandOutput("systemctl", ["--user", "is-enabled", unit]);
  const active = commandOutput("systemctl", ["--user", "is-active", unit]);
  const show = commandOutput("systemctl", ["--user", "show", unit, "--property=LoadState,UnitFileState,ActiveState,SubState,MainPID,ExecMainStartTimestamp,FragmentPath,WorkingDirectory,Environment,ExecStart"]);
  const props = parseProperties(show.stdout);
  const enabledValue = enabled.stdout.trim();
  const activeValue = active.stdout.trim();
  const unitFileState = props.UnitFileState || enabledValue;
  const activeState = props.ActiveState || activeValue;
  const mainPid = props.MainPID && props.MainPID !== "0" ? props.MainPID : "";
  const owner = mainPid ? processOwner(mainPid) : "";
  const expectedUser = currentUsername();
  const ownerOk = !owner || !expectedUser || owner === expectedUser;
  const bootEnabled = unitFileState === "enabled" || enabledValue === "enabled";
  const ok = bootEnabled && activeState === "active" && ownerOk;
  const detail = [
    `boot=${unitFileState || enabledValue || (enabled.ok ? "unknown" : "not enabled")}`,
    `active=${activeState || activeValue || (active.ok ? "unknown" : "inactive")}`,
    mainPid ? `pid=${mainPid}` : "",
    owner ? `user=${owner}` : expectedUser ? `user=${expectedUser}` : "",
    props.ExecMainStartTimestamp ? `started=${props.ExecMainStartTimestamp}` : "",
    props.WorkingDirectory ? `cwd=${props.WorkingDirectory}` : "cwd=systemd default",
    `workspace=${config.workspace}`,
    `home=${extractServiceHome(props.Environment, props.ExecStart) || home}`,
    props.FragmentPath ? `unit=${props.FragmentPath}` : "",
  ].join("; ");
  return check(id, name, ok, detail, "warn", fix("repair-autostart", "Repair autostart", "Reinstall enabled autostart entries and start them now."));
}

async function launchdServiceCheck(id: string, name: string, label: string, home: string, config: ConnectorConfig): Promise<DoctorCheck> {
  const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
  const content = await readTextFile(plistPath);
  const print = commandOutput("launchctl", ["print", `${launchdDomain()}/${label}`]);
  const disabled = launchdDisabled(label);
  const runAtLoad = plistBoolean(content, "RunAtLoad");
  const keepAlive = plistBoolean(content, "KeepAlive");
  const pid = /(?:^|\n)\s*pid\s*=\s*(\d+)/.exec(print.stdout)?.[1] ?? "";
  const ok = Boolean(content) && print.ok && !disabled && runAtLoad && keepAlive;
  const detail = [
    `loaded=${print.ok ? "yes" : "no"}`,
    `enabled=${disabled ? "no" : "yes"}`,
    `RunAtLoad=${runAtLoad ? "true" : "false"}`,
    `KeepAlive=${keepAlive ? "true" : "false"}`,
    pid ? `pid=${pid}` : "",
    `user=${currentUsername() || "unknown"}`,
    `workspace=${config.workspace}`,
    `home=${plistHome(content) || home}`,
    `plist=${plistPath}`,
  ].filter(Boolean).join("; ");
  return check(id, name, ok, detail, "warn", fix("repair-autostart", "Repair autostart", "Reinstall enabled autostart entries and start them now."));
}

function windowsTaskCheck(id: string, name: string, taskName: string, home: string, config: ConnectorConfig): DoctorCheck {
  const result = commandOutput("schtasks", ["/Query", "/TN", taskName, "/FO", "LIST", "/V"]);
  const props = parseWindowsListOutput(result.stdout);
  const status = props.Status || "";
  const schedule = props["Schedule Type"] || props["Task To Run"] || "";
  const runAs = props["Run As User"] || currentUsername() || "";
  const command = props["Task To Run"] || "";
  const ok = result.ok && !/^disabled$/i.test(status) && /logon/i.test(schedule);
  const detail = [
    `installed=${result.ok ? "yes" : "no"}`,
    status ? `status=${status}` : "",
    schedule ? `schedule=${schedule}` : "",
    runAs ? `user=${runAs}` : "",
    `workspace=${config.workspace}`,
    `home=${extractWindowsTaskHome(command) || home}`,
  ].filter(Boolean).join("; ");
  return check(id, name, ok, detail || result.detail, "warn", fix("repair-autostart", "Repair autostart", "Reinstall enabled autostart entries and start them now."));
}

async function serviceWorkspaceCheck(home: string, config: ConnectorConfig): Promise<DoctorCheck> {
  const state = await readJsonObject(path.join(home, "state.json"));
  const runningWorkspace = typeof state.workspace === "string" ? state.workspace : "";
  const ok = !runningWorkspace || samePath(runningWorkspace, config.workspace);
  const detail = [
    `configured=${config.workspace}`,
    runningWorkspace ? `reported=${runningWorkspace}` : "reported=not running",
    `home=${home}`,
  ].join("; ");
  return check("service-workspace", "Service workspace", ok, detail, "warn");
}

async function portListeningCheck(id: string, name: string, host: string, port: number): Promise<DoctorCheck> {
  const connectHost = connectHostForBindHost(host);
  const listening = await checkLocalPort(connectHost, port);
  return check(
    id,
    name,
    listening,
    listening ? `listening on ${connectHost}:${port}` : `not listening on ${connectHost}:${port}`,
    "warn",
  );
}

function commandOutput(command: string, args: string[]): { ok: boolean; stdout: string; detail: string } {
  const result = spawnSync(command, args, {
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

function parseProperties(source: string): Record<string, string> {
  const props: Record<string, string> = {};
  for (const line of source.split(/\r?\n/)) {
    const index = line.indexOf("=");
    if (index <= 0) continue;
    props[line.slice(0, index)] = line.slice(index + 1);
  }
  return props;
}

function parseWindowsListOutput(source: string): Record<string, string> {
  const props: Record<string, string> = {};
  for (const line of source.split(/\r?\n/)) {
    const index = line.indexOf(":");
    if (index <= 0) continue;
    props[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return props;
}

function processOwner(pid: string): string {
  const result = commandOutput("ps", ["-o", "user=", "-p", pid]);
  return result.ok ? result.stdout.trim() : "";
}

function currentUsername(): string {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USER || process.env.USERNAME || "";
  }
}

function extractServiceHome(environment: string | undefined, execStart: string | undefined): string {
  const envHome = /(?:^|\s)NORDRELAY_HOME=(?:"([^"]+)"|'([^']+)'|([^\s;]+))/.exec(environment ?? "");
  if (envHome) return envHome[1] || envHome[2] || envHome[3] || "";
  const execHome = /--home(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s;]+))/.exec(execStart ?? "");
  return execHome ? execHome[1] || execHome[2] || execHome[3] || "" : "";
}

async function readTextFile(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

async function readJsonObject(filePath: string): Promise<Record<string, unknown>> {
  try {
    const value = JSON.parse(await readFile(filePath, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function launchdDomain(): string {
  return `gui/${process.getuid?.() ?? ""}`;
}

function launchdDisabled(label: string): boolean {
  const result = commandOutput("launchctl", ["print-disabled", launchdDomain()]);
  if (!result.ok) return false;
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`"${escaped}"\\s*=>\\s*true`).test(result.stdout);
}

function plistBoolean(source: string, key: string): boolean {
  return new RegExp(`<key>${key}</key>\\s*<true\\s*/>`, "i").test(source);
}

function plistHome(source: string): string {
  const match = /<key>NORDRELAY_HOME<\/key>\s*<string>([^<]+)<\/string>/i.exec(source);
  return match ? unescapeXml(match[1] ?? "") : "";
}

function unescapeXml(value: string): string {
  return value
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

function extractWindowsTaskHome(command: string): string {
  const match = /--home(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s]+))/.exec(command);
  return match ? match[1] || match[2] || match[3] || "" : "";
}

function dashboardEndpointFromEnv(): { host: string; port: number } {
  const host = process.env.NORDRELAY_DASHBOARD_HOST?.trim() || "127.0.0.1";
  const parsedPort = Number.parseInt(process.env.NORDRELAY_DASHBOARD_PORT || "", 10);
  return { host, port: Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : 31878 };
}

function checkLocalPort(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const finish = (ok: boolean) => {
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

function connectHostForBindHost(host: string): string {
  if (!host || host === "0.0.0.0") return "127.0.0.1";
  if (host === "::") return "::1";
  return host;
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}

function runtimeRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}
