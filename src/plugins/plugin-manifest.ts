import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  type PluginManifest,
  type PluginValidationIssue,
  type PluginValidationResult,
  PLUGIN_MANIFEST_FILE,
} from "./plugin-types.js";

const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const SEMVERISH_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const KNOWN_CAPABILITY_KEYS = new Set([
  "commands",
  "workflowActions",
  "webPanels",
  "agentAdapters",
  "chatAdapters",
  "artifactHandlers",
  "diagnostics",
]);
const KNOWN_SETTING_TYPES = new Set(["string", "number", "boolean", "secret", "select"]);

export async function loadPluginManifest(pluginDir: string): Promise<PluginValidationResult> {
  const manifestPath = path.join(pluginDir, PLUGIN_MANIFEST_FILE);
  try {
    const raw = await readFile(manifestPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return validatePluginManifest(parsed);
  } catch (error) {
    return {
      ok: false,
      issues: [
        {
          level: "error",
          message: `Cannot read ${PLUGIN_MANIFEST_FILE}: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }
}

export function validatePluginManifest(input: unknown): PluginValidationResult {
  const issues: PluginValidationIssue[] = [];
  if (!isRecord(input)) {
    return {
      ok: false,
      issues: [{ level: "error", message: "Manifest must be a JSON object." }],
    };
  }

  const manifest = input as unknown as PluginManifest;
  if (!isNonEmptyString(manifest.id) || !PLUGIN_ID_RE.test(manifest.id)) {
    issues.push({
      level: "error",
      message: "Manifest id must match /^[a-z0-9][a-z0-9._-]{1,63}$/.",
    });
  }
  if (!isNonEmptyString(manifest.name)) {
    issues.push({ level: "error", message: "Manifest name is required." });
  }
  if (!isNonEmptyString(manifest.version) || !SEMVERISH_RE.test(manifest.version)) {
    issues.push({ level: "error", message: "Manifest version must be semver-like, for example 1.0.0." });
  }
  for (const key of ["description", "author", "homepage", "repository", "license", "nordrelay", "entry"] as const) {
    if (manifest[key] !== undefined && typeof manifest[key] !== "string") {
      issues.push({ level: "error", message: `Manifest ${key} must be a string when set.` });
    }
  }
  if (manifest.entry && (manifest.entry.includes("..") || path.isAbsolute(manifest.entry))) {
    issues.push({ level: "error", message: "Manifest entry must be a relative path inside the plugin directory." });
  }
  if (manifest.permissions !== undefined) {
    if (!Array.isArray(manifest.permissions) || manifest.permissions.some((value) => typeof value !== "string")) {
      issues.push({ level: "error", message: "Manifest permissions must be an array of strings." });
    }
  }
  validateCapabilities(manifest, issues);
  validateSettings(manifest, issues);

  return {
    ok: issues.every((issue) => issue.level !== "error"),
    manifest: issues.some((issue) => issue.level === "error") ? undefined : normalizePluginManifest(manifest),
    issues,
  };
}

export function normalizePluginManifest(manifest: PluginManifest): PluginManifest {
  return {
    ...manifest,
    permissions: uniqueStrings(manifest.permissions ?? []),
    capabilities: {
      commands: manifest.capabilities?.commands ?? [],
      workflowActions: manifest.capabilities?.workflowActions ?? [],
      webPanels: manifest.capabilities?.webPanels ?? [],
      agentAdapters: manifest.capabilities?.agentAdapters ?? [],
      chatAdapters: manifest.capabilities?.chatAdapters ?? [],
      artifactHandlers: manifest.capabilities?.artifactHandlers ?? [],
      diagnostics: Boolean(manifest.capabilities?.diagnostics),
    },
    settings: manifest.settings ?? [],
  };
}

function validateCapabilities(manifest: PluginManifest, issues: PluginValidationIssue[]): void {
  if (manifest.capabilities === undefined) {
    return;
  }
  if (!isRecord(manifest.capabilities)) {
    issues.push({ level: "error", message: "Manifest capabilities must be an object." });
    return;
  }
  for (const key of Object.keys(manifest.capabilities)) {
    if (!KNOWN_CAPABILITY_KEYS.has(key)) {
      issues.push({ level: "warning", message: `Unknown capability key ignored: ${key}.` });
    }
  }
  validateCapabilityArray(manifest.capabilities.commands, "commands", ["name"], issues);
  validateCapabilityArray(manifest.capabilities.workflowActions, "workflowActions", ["id", "title"], issues);
  validateCapabilityArray(manifest.capabilities.webPanels, "webPanels", ["id", "title"], issues);
  validateCapabilityArray(manifest.capabilities.agentAdapters, "agentAdapters", ["id", "title"], issues);
  validateCapabilityArray(manifest.capabilities.chatAdapters, "chatAdapters", ["id", "title"], issues);
  validateCapabilityArray(manifest.capabilities.artifactHandlers, "artifactHandlers", ["id", "title"], issues);
  if (manifest.capabilities.diagnostics !== undefined && typeof manifest.capabilities.diagnostics !== "boolean") {
    issues.push({ level: "error", message: "capabilities.diagnostics must be a boolean." });
  }
}

function validateCapabilityArray(
  value: unknown,
  key: string,
  required: string[],
  issues: PluginValidationIssue[],
): void {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    issues.push({ level: "error", message: `capabilities.${key} must be an array.` });
    return;
  }
  value.forEach((item, index) => {
    if (!isRecord(item)) {
      issues.push({ level: "error", message: `capabilities.${key}[${index}] must be an object.` });
      return;
    }
    for (const field of required) {
      if (!isNonEmptyString(item[field])) {
        issues.push({ level: "error", message: `capabilities.${key}[${index}].${field} is required.` });
      }
    }
  });
}

function validateSettings(manifest: PluginManifest, issues: PluginValidationIssue[]): void {
  if (manifest.settings === undefined) {
    return;
  }
  if (!Array.isArray(manifest.settings)) {
    issues.push({ level: "error", message: "Manifest settings must be an array." });
    return;
  }
  const seen = new Set<string>();
  manifest.settings.forEach((setting, index) => {
    if (!isRecord(setting)) {
      issues.push({ level: "error", message: `settings[${index}] must be an object.` });
      return;
    }
    if (!isNonEmptyString(setting.key)) {
      issues.push({ level: "error", message: `settings[${index}].key is required.` });
    } else if (seen.has(setting.key)) {
      issues.push({ level: "error", message: `Duplicate setting key: ${setting.key}.` });
    } else {
      seen.add(setting.key);
    }
    if (!isNonEmptyString(setting.label)) {
      issues.push({ level: "error", message: `settings[${index}].label is required.` });
    }
    if (!KNOWN_SETTING_TYPES.has(String(setting.type))) {
      issues.push({ level: "error", message: `settings[${index}].type is invalid.` });
    }
    if (setting.type === "select" && !Array.isArray(setting.options)) {
      issues.push({ level: "error", message: `settings[${index}].options is required for select settings.` });
    }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort();
}
