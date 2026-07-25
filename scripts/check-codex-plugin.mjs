#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const REQUIRED_KEYWORDS = [
  "codex",
  "pi",
  "hermes",
  "openclaw",
  "claude-code",
  "telegram",
  "discord",
  "slack",
  "matrix",
  "webui",
  "peer-federation",
];
const ALLOWED_MANIFEST_KEYS = new Set([
  "id",
  "name",
  "version",
  "description",
  "skills",
  "apps",
  "mcpServers",
  "interface",
  "author",
  "homepage",
  "repository",
  "license",
  "keywords",
]);
const ALLOWED_INTERFACE_KEYS = new Set([
  "displayName",
  "shortDescription",
  "longDescription",
  "developerName",
  "category",
  "capabilities",
  "websiteURL",
  "privacyPolicyURL",
  "termsOfServiceURL",
  "brandColor",
  "composerIcon",
  "logo",
  "logoDark",
  "screenshots",
  "defaultPrompt",
  "default_prompt",
]);

export function validateCodexPluginManifest(root = DEFAULT_ROOT) {
  const errors = [];
  const packagePath = path.join(root, "package.json");
  const pluginRoot = path.join(root, "plugins", "nordrelay");
  const manifestPath = path.join(pluginRoot, ".codex-plugin", "plugin.json");
  const pkg = readJsonObject(packagePath, "package.json", errors);
  const manifest = readJsonObject(manifestPath, "Codex plugin manifest", errors);
  if (!pkg || !manifest) {
    return errors;
  }

  rejectUnknownKeys(manifest, ALLOWED_MANIFEST_KEYS, "plugin.json", errors);
  requireString(manifest, "name", "plugin.json", errors);
  requireString(manifest, "version", "plugin.json", errors);
  requireString(manifest, "description", "plugin.json", errors);
  if (manifest.name !== "nordrelay") {
    errors.push(`plugin.json name must be "nordrelay", received ${JSON.stringify(manifest.name)}.`);
  }
  if (!SEMVER.test(String(manifest.version ?? ""))) {
    errors.push(`plugin.json version must be strict semver, received ${JSON.stringify(manifest.version)}.`);
  }
  if (manifest.version !== pkg.version) {
    errors.push(`plugin.json version ${manifest.version ?? "(missing)"} does not match package.json version ${pkg.version ?? "(missing)"}.`);
  }
  if (manifest.homepage !== "https://nordrelay.io/") {
    errors.push('plugin.json homepage must be "https://nordrelay.io/".');
  }
  if (manifest.repository !== "https://github.com/nordbyte/nordrelay") {
    errors.push('plugin.json repository must be "https://github.com/nordbyte/nordrelay".');
  }

  const author = objectValue(manifest.author);
  if (!author) {
    errors.push("plugin.json author must be an object.");
  } else {
    requireString(author, "name", "plugin.json author", errors);
    validateOptionalHttpsUrl(author.url, "plugin.json author.url", errors);
  }

  if (manifest.skills !== "./skills/") {
    errors.push('plugin.json skills must be "./skills/".');
  } else if (!isDirectory(path.join(pluginRoot, "skills"))) {
    errors.push("plugin.json skills directory does not exist.");
  }

  const keywords = stringArray(manifest.keywords);
  if (!keywords) {
    errors.push("plugin.json keywords must be an array of non-empty strings.");
  } else {
    for (const keyword of REQUIRED_KEYWORDS) {
      if (!keywords.includes(keyword)) {
        errors.push(`plugin.json keywords must include "${keyword}".`);
      }
    }
  }

  const interfaceValue = objectValue(manifest.interface);
  if (!interfaceValue) {
    errors.push("plugin.json interface must be an object.");
    return errors;
  }
  rejectUnknownKeys(interfaceValue, ALLOWED_INTERFACE_KEYS, "plugin.json interface", errors);
  for (const field of ["displayName", "shortDescription", "longDescription", "developerName", "category"]) {
    requireString(interfaceValue, field, "plugin.json interface", errors);
  }
  const capabilities = stringArray(interfaceValue.capabilities);
  if (!capabilities || capabilities.length === 0) {
    errors.push("plugin.json interface.capabilities must be a non-empty array of strings.");
  }
  validateOptionalHttpsUrl(interfaceValue.websiteURL, "plugin.json interface.websiteURL", errors);
  validateOptionalHttpsUrl(interfaceValue.privacyPolicyURL, "plugin.json interface.privacyPolicyURL", errors);
  validateOptionalHttpsUrl(interfaceValue.termsOfServiceURL, "plugin.json interface.termsOfServiceURL", errors);
  if (interfaceValue.websiteURL !== "https://nordrelay.io/") {
    errors.push('plugin.json interface.websiteURL must be "https://nordrelay.io/".');
  }

  const defaultPrompt = interfaceValue.defaultPrompt ?? interfaceValue.default_prompt;
  const prompts = stringArray(defaultPrompt);
  if (!prompts || prompts.length === 0 || prompts.length > 3) {
    errors.push("plugin.json interface.defaultPrompt must contain between 1 and 3 non-empty prompts.");
  } else {
    prompts.forEach((prompt, index) => {
      if (prompt.length > 128) {
        errors.push(`plugin.json interface.defaultPrompt[${index}] exceeds 128 characters.`);
      }
    });
  }

  for (const field of ["composerIcon", "logo", "logoDark"]) {
    if (interfaceValue[field] !== undefined) {
      validateAssetPath(pluginRoot, interfaceValue[field], `plugin.json interface.${field}`, errors);
    }
  }
  if (interfaceValue.screenshots !== undefined) {
    const screenshots = stringArray(interfaceValue.screenshots);
    if (!screenshots || screenshots.length === 0) {
      errors.push("plugin.json interface.screenshots must be omitted or contain at least one PNG asset.");
    } else {
      screenshots.forEach((screenshot, index) => {
        const label = `plugin.json interface.screenshots[${index}]`;
        if (!String(screenshot).toLowerCase().endsWith(".png")) {
          errors.push(`${label} must reference a PNG asset.`);
        }
        validateAssetPath(pluginRoot, screenshot, label, errors, "assets");
      });
    }
  }

  return errors;
}

function readJsonObject(filePath, label, errors) {
  let value;
  try {
    value = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    errors.push(`${label} could not be read as JSON: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
  if (!objectValue(value)) {
    errors.push(`${label} must contain a JSON object.`);
    return null;
  }
  return value;
}

function objectValue(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function requireString(value, field, label, errors) {
  if (typeof value[field] !== "string" || !value[field].trim()) {
    errors.push(`${label}.${field} must be a non-empty string.`);
  }
}

function stringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim())
    ? value
    : null;
}

function validateOptionalHttpsUrl(value, label, errors) {
  if (value === undefined) {
    return;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !url.hostname) {
      throw new Error("invalid");
    }
  } catch {
    errors.push(`${label} must be an absolute https:// URL.`);
  }
}

function validateAssetPath(pluginRoot, value, label, errors, requiredDirectory) {
  if (typeof value !== "string" || !value.startsWith("./")) {
    errors.push(`${label} must be a relative path beginning with "./".`);
    return;
  }
  const resolved = path.resolve(pluginRoot, value);
  const relative = path.relative(pluginRoot, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    errors.push(`${label} must stay inside the plugin directory.`);
    return;
  }
  if (requiredDirectory && relative.split(path.sep)[0] !== requiredDirectory) {
    errors.push(`${label} must be stored under ./${requiredDirectory}/.`);
  }
  if (!existsSync(resolved) || !statSync(resolved).isFile()) {
    errors.push(`${label} does not exist: ${value}.`);
  }
}

function isDirectory(filePath) {
  return existsSync(filePath) && statSync(filePath).isDirectory();
}

function rejectUnknownKeys(value, allowed, label, errors) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      errors.push(`${label} contains unsupported field "${key}".`);
    }
  }
}

if (isMainScript()) {
  const errors = validateCodexPluginManifest();
  if (errors.length > 0) {
    console.error(`Codex plugin manifest check failed with ${errors.length} issue(s):`);
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exitCode = 1;
  } else {
    console.log("Codex plugin manifest check passed.");
  }
}

function isMainScript() {
  return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}
