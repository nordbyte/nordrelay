import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { SECRET_KEYS, SETTING_DEFINITIONS, type SettingDefinition } from "./config-metadata.js";

export { SETTING_DEFINITIONS } from "./config-metadata.js";
export type { SettingDefinition } from "./config-metadata.js";

export interface SettingRecord extends SettingDefinition {
  value: string;
  effectiveValue: string;
  configured: boolean;
  masked: boolean;
}

export interface SettingsSnapshot {
  envPath: string;
  settings: SettingRecord[];
}

export interface SettingsUpdateResult {
  envPath: string;
  changedKeys: string[];
  restartRequired: boolean;
  errors: Array<{ key: string; message: string }>;
}

export class SettingsService {
  constructor(private readonly envPath: string) {}

  async snapshot(
    env: NodeJS.ProcessEnv = process.env,
    activeValues: Record<string, string | undefined> = {},
  ): Promise<SettingsSnapshot> {
    const parsed = await readEnvFile(this.envPath);
    const settings = SETTING_DEFINITIONS.map((definition) => {
      const configuredValue = parsed[definition.key];
      const effectiveValue = configuredValue ?? activeValues[definition.key] ?? env[definition.key] ?? "";
      const masked = SECRET_KEYS.has(definition.key) && Boolean(effectiveValue);
      return {
        ...definition,
        value: configuredValue === undefined ? "" : SECRET_KEYS.has(definition.key) && configuredValue ? maskSecret(configuredValue) : configuredValue,
        effectiveValue: masked ? maskSecret(effectiveValue) : effectiveValue,
        configured: configuredValue !== undefined,
        masked,
      };
    });
    return { envPath: this.envPath, settings };
  }

  async update(patch: Record<string, string | null | undefined>): Promise<SettingsUpdateResult> {
    return withEnvFileLock(this.envPath, async () => {
      const current = await readEnvFile(this.envPath);
      const changedKeys: string[] = [];
      const errors: Array<{ key: string; message: string }> = [];
      const definitions = new Map(SETTING_DEFINITIONS.map((definition) => [definition.key, definition]));

      for (const [key, rawValue] of Object.entries(patch)) {
        const definition = definitions.get(key);
        if (!definition) {
          continue;
        }
        const value = normalizeSettingValue(rawValue);
        if (value === undefined || isMaskedSecret(value)) {
          continue;
        }
        if (value === "") {
          if (current[key] !== undefined) {
            delete current[key];
            changedKeys.push(key);
          }
          continue;
        }
        const validationError = validateSettingValue(definition, value);
        if (validationError) {
          errors.push({ key, message: validationError });
          continue;
        }
        if (current[key] !== value) {
          current[key] = value;
          changedKeys.push(key);
        }
      }

      if (changedKeys.length > 0 && errors.length === 0) {
        await writeEnvFile(this.envPath, current);
      }

      return {
        envPath: this.envPath,
        changedKeys: errors.length === 0 ? changedKeys : [],
        restartRequired: errors.length === 0 && changedKeys.some((key) => definitions.get(key)?.restartRequired),
        errors,
      };
    });
  }
}

const envFileLocks = new Map<string, Promise<void>>();

async function withEnvFileLock<T>(filePath: string, task: () => Promise<T>): Promise<T> {
  const lockKey = path.resolve(filePath);
  const previous = envFileLocks.get(lockKey) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const next = previous.then(() => current, () => current);
  envFileLocks.set(lockKey, next);
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (envFileLocks.get(lockKey) === next) {
      envFileLocks.delete(lockKey);
    }
  }
}

export function resolveDashboardEnvPath(home: string, cwd = process.cwd()): string {
  if (process.env.NORDRELAY_ENV_FILE) {
    return path.resolve(process.env.NORDRELAY_ENV_FILE);
  }
  void cwd;
  return path.join(home, "nordrelay.env");
}

export function maskSecret(value: string): string {
  if (!value) {
    return "";
  }
  if (value.length <= 8) {
    return "********";
  }
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function validateSettingValue(definition: SettingDefinition, value: string): string | null {
  if (definition.kind === "number" && !Number.isFinite(Number(value))) {
    return "Must be a number.";
  }
  if (definition.kind === "boolean" && !["true", "false", "1", "0", "yes", "no", "on", "off"].includes(value.toLowerCase())) {
    return "Must be true or false.";
  }
  if (definition.kind === "json") {
    try {
      JSON.parse(value);
    } catch (error) {
      return `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  if (definition.options && !definition.options.includes(value)) {
    return `Must be one of: ${definition.options.join(", ")}.`;
  }
  return null;
}

async function readEnvFile(filePath: string): Promise<Record<string, string>> {
  try {
    return parseEnvText(await readFile(filePath, "utf8"));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

function parseEnvText(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
    const equals = normalized.indexOf("=");
    if (equals < 1) {
      continue;
    }
    const key = normalized.slice(0, equals).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }
    result[key] = unquoteEnvValue(normalized.slice(equals + 1).trim());
  }
  return result;
}

async function writeEnvFile(filePath: string, values: Record<string, string>): Promise<void> {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmodPrivate(directory, 0o700);
  const orderedKeys = [
    ...SETTING_DEFINITIONS.map((definition) => definition.key).filter((key) => values[key] !== undefined),
    ...Object.keys(values).filter((key) => !SETTING_DEFINITIONS.some((definition) => definition.key === key)).sort(),
  ];
  const lines = [
    "# NordRelay runtime config managed by the dashboard.",
    ...orderedKeys.map((key) => `${key}=${quoteEnvValue(values[key] ?? "")}`),
    "",
  ];
  const tempPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(tempPath, "wx", 0o600);
    await handle.writeFile(lines.join("\n"), "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(tempPath, filePath);
    await chmodPrivate(filePath, 0o600);
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => {});
    }
    await unlink(tempPath).catch(() => {});
    throw error;
  }
}

async function chmodPrivate(filePath: string, mode: number): Promise<void> {
  if (process.platform === "win32") {
    return;
  }
  await chmod(filePath, mode).catch(() => {});
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function unquoteEnvValue(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1).replace(/\\n/g, "\n");
  }
  return value;
}

function quoteEnvValue(value: string): string {
  if (!value) {
    return "";
  }
  if (/^[A-Za-z0-9_./:@,+-]+$/.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}

function normalizeSettingValue(value: string | null | undefined): string | undefined {
  if (value === undefined || value === null) {
    return "";
  }
  return String(value).trim();
}

function isMaskedSecret(value: string): boolean {
  return value === "********" || /^\*+$/.test(value) || /^[^*]{1,4}\.\.\.[^*]{1,4}$/.test(value);
}
