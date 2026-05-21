#!/usr/bin/env node
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

function read(path) {
  return readFileSync(join(root, path), "utf8");
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const globals = read("src/web/ui/client/webui-globals.d.ts");
const coreTypes = read("src/web/ui/client/core/webui-types.d.ts");
assert(!globals.includes("declare const state: any"), "WebUI state must use DashboardState, not any.");
assert(!/declare const \w+Pager: any/.test(globals), "WebUI pagers must use WebuiPager, not any.");
assert(!/declare var \w+: \(\.\.\.args: any\[\]\)/.test(globals), "WebUI globals should not expose broad (...args: any[]) declarations.");
assert(!/\bany\b/.test(globals), "WebUI global declarations should avoid any.");
assert(coreTypes.includes("interface DashboardState"), "WebUI core types must declare DashboardState.");

const buildScript = read("scripts/build-web-assets.mjs");
const runtimeAssets = read("src/web/web-dashboard-assets.ts");
const expectedSources = [
  "admin-core.ts",
  "admin-monitor.ts",
  "admin-access.ts",
  "admin-logs.ts",
  "admin-adapters.ts",
  "admin-version.ts",
  "admin-peers.ts",
];

for (const source of expectedSources) {
  assert(buildScript.includes(source), `WebUI build is missing ${source}.`);
  assert(runtimeAssets.includes(source), `WebUI runtime asset list is missing ${source}.`);
}

const adminMarker = read("src/web/ui/client/admin.ts").trim();
assert(adminMarker.length < 120, "src/web/ui/client/admin.ts should remain a split-module marker only.");

for (const file of clientSourceFiles("src/web/ui/client")) {
  const source = read(file);
  assert(!source.includes("@ts-nocheck"), `${file} must not disable TypeScript checking.`);
  assert(!/\bany\b/.test(source), `${file} must not use explicit any. Add a WebUI DTO or use unknown.`);
}

function clientSourceFiles(dir) {
  const files = [];
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const relative = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...clientSourceFiles(relative));
      continue;
    }
    if (!/\.(?:ts|js|d\.ts)$/.test(entry.name)) {
      continue;
    }
    if (relative.endsWith("/api-routes.generated.js")) {
      continue;
    }
    files.push(relative);
  }
  return files.sort();
}
