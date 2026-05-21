#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(rootDir, "docs", ".vitepress", "dist");

const requiredFiles = [
  "index.html",
  "CNAME",
  "nordrelay-logo.png",
  "nordrelay-hero.png",
  "commands/index.html",
  "commands/init.html",
  "commands/user.html",
  "commands/peer.html",
  "commands/web.html",
];

const errors = [];

for (const file of requiredFiles) {
  const fullPath = path.join(distDir, file);
  try {
    const stat = await fs.stat(fullPath);
    if (!stat.isFile()) {
      errors.push(`${file} is not a file`);
    }
  } catch {
    errors.push(`${file} is missing`);
  }
}

try {
  const cname = (await fs.readFile(path.join(distDir, "CNAME"), "utf8")).trim();
  if (cname !== "nordrelay.io") {
    errors.push(`CNAME must be nordrelay.io, found ${JSON.stringify(cname)}`);
  }
} catch {
  // The missing CNAME is already reported above.
}

try {
  const index = await fs.readFile(path.join(distDir, "index.html"), "utf8");
  if (!index.includes("NordRelay")) {
    errors.push("index.html does not contain NordRelay");
  }
  if (!index.includes("nordrelay-hero.png")) {
    errors.push("index.html does not reference nordrelay-hero.png");
  }
} catch {
  // The missing index is already reported above.
}

try {
  const commandPage = await fs.readFile(path.join(distDir, "commands", "init.html"), "utf8");
  if (!commandPage.includes("nordrelay init")) {
    errors.push("commands/init.html does not contain nordrelay init");
  }
} catch {
  // The missing command page is already reported above.
}

if (errors.length > 0) {
  console.error(`Docs build smoke failed with ${errors.length} issue(s):`);
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log(`Docs build smoke passed (${requiredFiles.length} required files).`);
