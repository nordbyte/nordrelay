#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workDir = mkdtempSync(path.join(tmpdir(), "nordrelay-install-"));
const prefix = path.join(workDir, "global");

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
  execFileSync("npm", ["install", "-g", path.join(workDir, tgz), "--prefix", prefix], {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  const bin = process.platform === "win32"
    ? path.join(prefix, "nordrelay.cmd")
    : path.join(prefix, "bin", "nordrelay");
  execFileSync(bin, ["--version"], { stdio: "inherit", shell: process.platform === "win32" });
  execFileSync(bin, ["help"], { stdio: "inherit", shell: process.platform === "win32" });
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
