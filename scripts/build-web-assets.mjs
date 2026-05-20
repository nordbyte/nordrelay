#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";

import { transformSync } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checkOnly = process.argv.includes("--check");
const minifyAssets = process.env.NORDRELAY_WEBUI_MINIFY !== "false";

const assets = [
  {
    name: "dashboard.js",
    loader: "ts",
    sources: [
      "src/web/ui/client/core/api-routes.generated.js",
      "src/web/ui/client/core/api-client.ts",
      "src/web/ui/client/core/runtime.ts",
      "src/web/ui/client/core/components.ts",
      "src/web/ui/client/core/pagers.ts",
      "src/web/ui/client/profile.ts",
      "src/web/ui/client/header-target.ts",
      "src/web/ui/client/overview.ts",
      "src/web/ui/client/events.ts",
      "src/web/ui/client/workflows.ts",
      "src/web/ui/client/jobs.ts",
      "src/web/ui/client/metrics.ts",
      "src/web/ui/client/settings-panel.ts",
      "src/web/ui/client/admin-core.ts",
      "src/web/ui/client/admin-monitor.ts",
      "src/web/ui/client/admin-access.ts",
      "src/web/ui/client/admin-logs.ts",
      "src/web/ui/client/admin-adapters.ts",
      "src/web/ui/client/admin-version.ts",
      "src/web/ui/client/admin-peers.ts",
      "src/web/ui/client/diagnostics.ts",
      "src/web/ui/client/queue-planner.ts",
      "src/web/ui/client/workflow-builder.ts",
      "src/web/ui/client/workflows-page.ts",
      "src/web/ui/client/users.ts",
      "src/web/ui/client/settings-wizard.ts",
    ],
  },
  {
    name: "dashboard.css",
    loader: "css",
    sources: [
      "src/web/ui/styles/theme.css",
      "src/web/ui/styles/components.css",
      "src/web/ui/styles/layout.css",
      "src/web/ui/styles/responsive.css",
    ],
  },
];

const staticAssets = [
  "favicon.ico",
  "favicon.png",
  "logo.png",
  "manifest.webmanifest",
  "service-worker.js",
];

for (const asset of assets) {
  const source = asset.sources
    .map((source) => readFileSync(path.join(root, source), "utf8").trimEnd())
    .join("\n\n") + "\n";
  const body = transformSync(source, {
    loader: asset.loader,
    format: asset.name.endsWith(".js") ? "iife" : undefined,
    legalComments: "none",
    minify: minifyAssets,
    sourcefile: asset.name,
    target: asset.name.endsWith(".js") ? "es2022" : "chrome100",
  }).code;

  if (!body.trim()) {
    throw new Error(`WebUI asset ${asset.name} is empty`);
  }

  if (!checkOnly) {
    const outDir = path.join(root, "dist", "webui-assets");
    const outPath = path.join(outDir, asset.name);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(outPath, body, "utf8");
    writeFileSync(`${outPath}.gz`, gzipSync(body, { level: 9 }));
    writeFileSync(`${outPath}.br`, brotliCompressSync(body, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 } }));
  }
}

for (const assetName of staticAssets) {
  const sourcePath = path.join(root, "src", "web", "ui", "assets", assetName);
  if (!existsSync(sourcePath)) {
    throw new Error(`WebUI static asset is missing: ${sourcePath}`);
  }
  if (!checkOnly) {
    const outDir = path.join(root, "dist", "webui-assets");
    mkdirSync(outDir, { recursive: true });
    copyFileSync(sourcePath, path.join(outDir, assetName));
  }
}

if (!checkOnly) {
  console.log(`Built ${minifyAssets ? "minified " : ""}WebUI assets.`);
}
