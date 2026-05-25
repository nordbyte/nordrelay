#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";

import { transformSync } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checkOnly = process.argv.includes("--check");
const minifyAssets = process.env.NORDRELAY_WEBUI_MINIFY !== "false";
const uiRoot = path.join(root, "src", "web", "ui");
const manifest = JSON.parse(readFileSync(path.join(uiRoot, "asset-manifest.json"), "utf8"));

const assets = manifest.bundles || [];
const staticAssets = manifest.staticAssets || [];

for (const asset of assets) {
  const source = asset.sources
    .map((source) => readFileSync(path.join(uiRoot, source), "utf8").trimEnd())
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

for (const asset of staticAssets) {
  const assetName = typeof asset === "string" ? asset : asset.name;
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
  const outDir = path.join(root, "dist", "webui-assets");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, "asset-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`Built ${minifyAssets ? "minified " : ""}WebUI assets.`);
}
