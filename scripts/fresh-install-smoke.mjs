#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workDir = mkdtempSync(path.join(tmpdir(), "nordrelay-install-"));
const prefix = path.join(workDir, "global");
const options = parseArgs(process.argv.slice(2));

try {
  execFileSync("npm", ["pack", "--pack-destination", workDir], {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  const tgz = readdirSync(workDir).find((file) => /^nordbyte-nordrelay-.*\.tgz$/.test(file));
  if (!tgz) {
    throw new Error("Packed tarball was not created.");
  }
  const tgzPath = path.join(workDir, tgz);
  if (options.mode === "dlx") {
    runDlxSmoke(options.manager, tgzPath);
  } else {
    runGlobalSmoke(options.manager, tgzPath);
  }
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

function runGlobalSmoke(manager, tgzPath) {
  if (manager !== "npm") {
    throw new Error("Global package smoke is only supported for npm. Use --mode dlx for pnpm or yarn.");
  }
  execFileSync("npm", ["install", "-g", tgzPath, "--prefix", prefix], commandOptions());
  const bin = process.platform === "win32"
    ? path.join(prefix, "nordrelay.cmd")
    : path.join(prefix, "bin", "nordrelay");
  execFileSync(bin, ["--version"], commandOptions());
  execFileSync(bin, ["help"], commandOptions());
}

function runDlxSmoke(manager, tgzPath) {
  const fileSpec = `file:${tgzPath}`;
  const yarnSpec = `@nordbyte/nordrelay@${fileSpec}`;
  const commands = manager === "pnpm"
    ? [
        ["pnpm", ["dlx", "--package", fileSpec, "nordrelay", "--version"]],
        ["pnpm", ["dlx", "--package", fileSpec, "nordrelay", "help"]],
      ]
    : [
        ["yarn", ["dlx", "--package", yarnSpec, "nordrelay", "--version"]],
        ["yarn", ["dlx", "--package", yarnSpec, "nordrelay", "help"]],
      ];
  for (const [command, args] of commands) {
    execFileSync(command, args, commandOptions());
  }
}

function commandOptions() {
  return {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: {
      ...process.env,
      ADBLOCK: "1",
      NO_UPDATE_NOTIFIER: "1",
      npm_config_fund: "false",
      npm_config_audit: "false",
    },
  };
}

function parseArgs(args) {
  const parsed = { manager: "npm", mode: "global" };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--manager") parsed.manager = args[++index] ?? "";
    else if (arg.startsWith("--manager=")) parsed.manager = arg.slice("--manager=".length);
    else if (arg === "--mode") parsed.mode = args[++index] ?? "";
    else if (arg.startsWith("--mode=")) parsed.mode = arg.slice("--mode=".length);
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node scripts/fresh-install-smoke.mjs [--manager npm|pnpm|yarn] [--mode global|dlx]");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!["npm", "pnpm", "yarn"].includes(parsed.manager)) {
    throw new Error(`Unsupported package manager: ${parsed.manager}`);
  }
  if (!["global", "dlx"].includes(parsed.mode)) {
    throw new Error(`Unsupported smoke mode: ${parsed.mode}`);
  }
  if (parsed.manager !== "npm" && parsed.mode === "global") {
    parsed.mode = "dlx";
  }
  return parsed;
}
