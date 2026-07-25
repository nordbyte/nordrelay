#!/usr/bin/env node
import { readFileSync } from "node:fs";
import process from "node:process";

import { validateCodexPluginManifest } from "./check-codex-plugin.mjs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const packageVersion = String(pkg.version ?? "").trim();
const expectedTag = `v${packageVersion}`;
const eventName = process.env.GITHUB_EVENT_NAME ?? "";
const refName = process.env.GITHUB_REF_NAME ?? "";
const refType = process.env.GITHUB_REF_TYPE ?? "";
const releaseTag = firstNonEmpty(
  process.env.NORDRELAY_RELEASE_TAG,
  process.env.GITHUB_RELEASE_TAG,
  refType === "tag" ? refName : undefined,
);
const requestedVersion = firstNonEmpty(
  process.env.NORDRELAY_RELEASE_VERSION,
  process.env.INPUT_VERSION,
);

if (!packageVersion) {
  fail("package.json does not define a version.");
}

const pluginErrors = validateCodexPluginManifest();
if (pluginErrors.length > 0) {
  fail(`Codex plugin manifest is not release-ready:\n- ${pluginErrors.join("\n- ")}`);
}

if (eventName === "release" || releaseTag) {
  if (releaseTag !== expectedTag) {
    fail(`Release tag ${releaseTag || "(missing)"} does not match package.json version ${packageVersion}; expected ${expectedTag}.`);
  }
}

if (eventName === "workflow_dispatch") {
  if (refType && (refType !== "branch" || refName !== "main")) {
    fail("workflow_dispatch publishes are only allowed from the main branch.");
  }
  if (!requestedVersion) {
    fail("workflow_dispatch requires NORDRELAY_RELEASE_VERSION or INPUT_VERSION.");
  }
  if (requestedVersion !== packageVersion) {
    fail(`Requested version ${requestedVersion} does not match package.json version ${packageVersion}.`);
  }
}

console.log(`Release version verified: ${expectedTag}`);

function firstNonEmpty(...values) {
  return values.map((value) => String(value ?? "").trim()).find(Boolean);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
