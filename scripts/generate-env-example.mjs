#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { renderEnvExample } from "../src/config-metadata.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const next = renderEnvExample();
const target = path.join(root, ".env.example");

if (process.argv.includes("--check")) {
  const current = await import("node:fs").then((fs) => fs.readFileSync(target, "utf8"));
  if (current !== next) {
    console.error(".env.example is out of sync with src/config-metadata.ts");
    process.exit(1);
  }
} else {
  writeFileSync(target, next, "utf8");
}
