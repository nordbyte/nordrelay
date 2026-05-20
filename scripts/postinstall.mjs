#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import path from "node:path";

const commandName = process.platform === "win32" ? "nordrelay.cmd" : "nordrelay";

function isGlobalInstall() {
  return process.env.NORDRELAY_POSTINSTALL_CHECK === "1"
    || process.env.npm_config_global === "true"
    || process.env.npm_config_location === "global";
}

function npmPrefix() {
  const configured = process.env.npm_config_prefix;
  if (configured) {
    return configured;
  }
  const npmExec = process.env.npm_execpath || "npm";
  try {
    return execFileSync(npmExec, ["prefix", "-g"], {
      encoding: "utf8",
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function globalBinDir(prefix, platform = process.platform) {
  if (!prefix) {
    return "";
  }
  return platform === "win32" ? prefix : path.join(prefix, "bin");
}

function normalizePathEntry(entry, platform = process.platform) {
  const resolved = path.resolve(entry);
  return platform === "win32" || platform === "darwin" ? resolved.toLowerCase() : resolved;
}

function pathContains(dir, envPath = process.env.PATH || "", platform = process.platform) {
  if (!dir) {
    return false;
  }
  const wanted = normalizePathEntry(dir, platform);
  return envPath
    .split(path.delimiter)
    .filter(Boolean)
    .map((entry) => normalizePathEntry(entry, platform))
    .includes(wanted);
}

function shellProfile(platform = process.platform, shell = process.env.SHELL || "") {
  if (platform === "win32") {
    return "";
  }
  if (platform === "darwin") {
    return shell.endsWith("/bash") ? "~/.bash_profile" : "~/.zshrc";
  }
  return shell.endsWith("/zsh") ? "~/.zshrc" : "~/.bashrc";
}

function quote(value) {
  return `"${String(value).replaceAll('"', '\\"')}"`;
}

function warning(prefix, binDir, platform = process.env.NORDRELAY_POSTINSTALL_PLATFORM || process.platform) {
  const commandPath = path.join(binDir, commandName);
  if (platform === "win32") {
    return [
      "",
      "NordRelay installed, but the npm global bin directory is not in your PATH.",
      'The `nordrelay` command may fail with "command not found".',
      "",
      `npm global bin: ${binDir}`,
      "",
      "Add it to your user PATH, then open a new terminal:",
      `  [Environment]::SetEnvironmentVariable("Path", $env:Path + ";${binDir}", "User")`,
      "",
      "Or run NordRelay directly:",
      `  & ${quote(commandPath)} init`,
      "",
    ].join("\n");
  }

  const profile = shellProfile(platform);
  return [
    "",
    "NordRelay installed, but the npm global bin directory is not in your PATH.",
    'The `nordrelay` command may fail with "command not found".',
    "",
    `npm global bin: ${binDir}`,
    "",
    `Add this to ${profile}:`,
    `  export PATH=${quote(binDir + ":$PATH")}`,
    "",
    "Then reload your shell and initialize NordRelay:",
    `  source ${profile}`,
    "  nordrelay init",
    "",
    "Or run NordRelay directly:",
    `  ${quote(commandPath)} init`,
    "",
    prefix ? "" : "If the npm prefix could not be detected, run `npm prefix -g` and add its bin directory to PATH.",
  ].filter(Boolean).join("\n");
}

function main() {
  if (!isGlobalInstall()) {
    return;
  }
  const prefix = npmPrefix();
  const platform = process.env.NORDRELAY_POSTINSTALL_PLATFORM || process.platform;
  const binDir = globalBinDir(prefix, platform);
  if (!binDir || pathContains(binDir, process.env.PATH || "", platform)) {
    return;
  }
  console.warn(warning(prefix, binDir, platform));
}

main();
