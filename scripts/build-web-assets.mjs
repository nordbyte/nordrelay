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
    loader: "js",
    sources: [
      "src/web/ui/client/core/api-routes.generated.js",
      "src/web/ui/client/core/api-client.js",
      "src/web/ui/client/core/runtime.js",
      "src/web/ui/client/core/components.js",
      "src/web/ui/client/profile.js",
      "src/web/ui/client/overview.js",
      "src/web/ui/client/events.js",
      "src/web/ui/client/workflows.js",
      "src/web/ui/client/jobs.js",
      "src/web/ui/client/metrics.js",
      "src/web/ui/client/admin.js",
      "src/web/ui/client/queue-planner.js",
      "src/web/ui/client/workflows-page.js",
      "src/web/ui/client/users.js",
      "src/web/ui/client/settings-wizard.js",
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
];

for (const asset of assets) {
  const source = asset.sources
    .map((source) => readFileSync(path.join(root, source), "utf8").trimEnd())
    .join("\n\n") + "\n";
  const body = transformSync(source, {
    loader: asset.loader,
    format: asset.loader === "js" ? "iife" : undefined,
    legalComments: "none",
    minify: minifyAssets,
    sourcefile: asset.name,
    target: asset.loader === "js" ? "es2022" : "chrome100",
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
