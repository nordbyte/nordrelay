import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { describeClaudeCodeCli, resolveClaudeCodeCli } from "../agents/claude-code/claude-code-cli.js";
import { describeCodexCli, findExecutableOnPath, resolveCodexCli } from "../agents/codex/codex-cli.js";
import { describeHermesCli, resolveHermesCli } from "../agents/hermes/hermes-cli.js";
import { describeOpenClawCli, resolveOpenClawCli } from "../agents/openclaw/openclaw-cli.js";
import { describePiCli, resolvePiCli } from "../agents/pi/pi-cli.js";
import type { ConnectorConfig } from "../core/config.js";
import { resolveDashboardEnvPath, SettingsService } from "../core/settings-service.js";
import { stateBackendPath, checkStateBackendAvailability } from "../state/state-backend.js";
import { UserStore } from "../access/user-management.js";
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
  return config.webuiEnabled || config.telegramEnabled || config.discordEnabled || config.slackEnabled;
}

function accessSurfaceDetail(config: ConnectorConfig): string {
  return [
    config.webuiEnabled ? "WebUI" : "",
    config.telegramEnabled ? "Telegram" : "",
    config.discordEnabled ? "Discord" : "",
    config.slackEnabled ? "Slack" : "",
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
  throw new Error(`Unsupported doctor fix: ${fixId}`);
}

function majorVersion(value: string): number {
  return Number.parseInt(value.split(".")[0] ?? "0", 10);
}
