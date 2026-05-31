#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const targets = [
  "dist",
  "coverage",
  "test-results",
  "playwright-report",
  "sbom.json",
  ".repovista",
  ".understand-anything",
  "docs/node_modules",
  "docs/.vitepress/cache",
  "docs/.vitepress/dist",
];

let removed = 0;

for (const target of targets) {
  const fullPath = path.join(rootDir, target);
  await fs.rm(fullPath, { recursive: true, force: true });
  removed += 1;
  console.log(`Removed ${target}`);
}

console.log(`Cleaned ${removed} local artifact path(s).`);
