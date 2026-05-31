import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const PRIVATE_FILE_MODE = 0o600;

export async function pidFileDoctorCheck(name, pidFile, deps) {
  let text = "";
  try {
    text = await fsp.readFile(pidFile, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return check(name, true, "not present");
    return check(name, false, `cannot read ${pidFile}: ${error instanceof Error ? error.message : String(error)}`, "warn", stalePidFileFix(pidFile));
  }
  const pid = Number.parseInt(text.trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    return check(name, false, `invalid PID file ${pidFile}`, "warn", stalePidFileFix(pidFile));
  }
  const running = deps.isProcessRunning(pid);
  const managed = running && await deps.isManaged(pid);
  return check(
    name,
    managed,
    managed ? `${pidFile} -> ${pid} running` : `${pidFile} -> ${pid} ${running ? "running but not managed by NordRelay" : "not running"}`,
    "warn",
    stalePidFileFix(pidFile),
  );
}

export function codexConfigDoctorCheck() {
  const configPath = resolveCodexConfigPath();
  if (!configPath || !fs.existsSync(configPath)) {
    return check("Codex config", true, configPath ? `${configPath} not present` : "Codex home unavailable", "warn");
  }
  let contents = "";
  try {
    contents = fs.readFileSync(configPath, "utf8");
  } catch (error) {
    return check("Codex config", false, `cannot read ${configPath}: ${error instanceof Error ? error.message : String(error)}`, "warn");
  }
  const serviceTier = readTopLevelTomlServiceTier(contents);
  if (!serviceTier) return check("Codex config", true, `${configPath}; service_tier not set`);
  if (serviceTier === "fast" || serviceTier === "flex") return check("Codex config", true, `${configPath}; service_tier=${serviceTier}`);
  if (serviceTier === "default") {
    return check(
      "Codex config",
      false,
      `${configPath}; service_tier=default is incompatible with current Codex config parsing`,
      "warn",
      rewriteCodexDefaultServiceTierFix(configPath),
    );
  }
  return check(
    "Codex config",
    false,
    `${configPath}; unsupported service_tier=${serviceTier}`,
    "warn",
    hintFix("Set Codex service_tier to fast or flex, or remove the key and reselect Fast mode from NordRelay."),
  );
}

function stalePidFileFix(pidFile) {
  return {
    id: `stale-pid:${pidFile}`,
    summary: `Remove stale PID file ${pidFile}.`,
    apply: async () => {
      await fsp.rm(pidFile, { force: true });
      return `Removed ${pidFile}`;
    },
  };
}

function rewriteCodexDefaultServiceTierFix(configPath) {
  return {
    id: `codex-service-tier:${configPath}`,
    summary: `Rewrite Codex service_tier=default to service_tier=flex in ${configPath}.`,
    apply: async () => {
      const contents = await fsp.readFile(configPath, "utf8");
      const next = rewriteTopLevelTomlServiceTierDefault(contents);
      if (next === contents) return "No service_tier=default entry found.";
      await fsp.writeFile(configPath, next, { mode: PRIVATE_FILE_MODE });
      await fsp.chmod(configPath, PRIVATE_FILE_MODE).catch(() => {});
      return `Updated ${configPath}`;
    },
  };
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

function hintFix(summary) {
  return summary ? { summary } : null;
}

function resolveCodexConfigPath() {
  const codexHome = cleanEnvPath(process.env.CODEX_HOME);
  const userHome = cleanEnvPath(process.env.HOME) || cleanEnvPath(process.env.USERPROFILE) || cleanEnvPath(os.homedir());
  const codexDir = codexHome || (userHome ? path.join(userHome, ".codex") : "");
  return codexDir ? path.join(codexDir, "config.toml") : null;
}

function cleanEnvPath(value) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function readTopLevelTomlServiceTier(contents) {
  const [topLevel] = splitTomlTopLevel(contents);
  const match = /^(\s*service_tier\s*=\s*)("[^"\n]*"|'[^'\n]*'|[A-Za-z0-9_-]+)(\s*(?:#.*)?)$/m.exec(topLevel);
  return match ? unquoteTomlScalar(match[2]).toLowerCase() : null;
}

function rewriteTopLevelTomlServiceTierDefault(contents) {
  const [topLevel, rest] = splitTomlTopLevel(contents);
  const serviceTierRe = /^(\s*service_tier\s*=\s*)("[^"\n]*"|'[^'\n]*'|[A-Za-z0-9_-]+)(\s*(?:#.*)?)$/m;
  const match = serviceTierRe.exec(topLevel);
  return !match || unquoteTomlScalar(match[2]).toLowerCase() !== "default"
    ? contents
    : `${topLevel.replace(serviceTierRe, '$1"flex"$3')}${rest}`;
}

function splitTomlTopLevel(contents) {
  const match = contents.match(/^\s*\[/m);
  return !match || match.index === undefined ? [contents, ""] : [contents.slice(0, match.index), contents.slice(match.index)];
}

function unquoteTomlScalar(value) {
  const trimmed = String(value || "").trim();
  return (trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))
    ? trimmed.slice(1, -1)
    : trimmed;
}
