#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checkOnly = process.argv.includes("--check");

const assets = [
  {
    name: "dashboard.js",
    sources: [
      "src/webui/client/foundation.js",
      "src/webui/client/events.js",
      "src/webui/client/workflows.js",
      "src/webui/client/admin.js",
    ],
  },
  {
    name: "dashboard.css",
    sources: [
      "src/webui/styles/theme.css",
      "src/webui/styles/components.css",
      "src/webui/styles/layout.css",
      "src/webui/styles/responsive.css",
    ],
  },
];

for (const asset of assets) {
  const body = asset.sources
    .map((source) => readFileSync(path.join(root, source), "utf8").trimEnd())
    .join("\n\n") + "\n";

  if (!body.trim()) {
    throw new Error(`WebUI asset ${asset.name} is empty`);
  }

  if (!checkOnly) {
    const outDir = path.join(root, "dist", "webui-assets");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(path.join(outDir, asset.name), body, "utf8");
  }
}

if (!checkOnly) {
  console.log("Built WebUI assets.");
}
