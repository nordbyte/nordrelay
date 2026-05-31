import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import type { PluginIntegrity, PluginManifest } from "./plugin-types.js";

export async function hashFile(filePath: string, algorithm: PluginIntegrity["algorithm"] = "sha256"): Promise<PluginIntegrity> {
  const hash = createHash(algorithm);
  hash.update(await readFile(filePath));
  return { algorithm, value: hash.digest("hex") };
}

export async function hashDirectory(root: string, algorithm: PluginIntegrity["algorithm"] = "sha256"): Promise<PluginIntegrity> {
  const hash = createHash(algorithm);
  for (const file of await listHashableFiles(root)) {
    const relativePath = path.relative(root, file).replaceAll(path.sep, "/");
    hash.update(relativePath);
    hash.update("\0");
    hash.update(await readFile(file));
    hash.update("\0");
  }
  return { algorithm, value: hash.digest("hex") };
}

export function hashManifest(manifest: PluginManifest, algorithm: PluginIntegrity["algorithm"] = "sha256"): PluginIntegrity {
  const hash = createHash(algorithm);
  hash.update(canonicalJson(stripManifestSignature(manifest)));
  return { algorithm, value: hash.digest("hex") };
}

export function assertExpectedHash(actual: PluginIntegrity, expected: string | undefined, label: string): void {
  if (!expected) return;
  const normalized = expected.includes(":") ? expected.split(":").at(-1) ?? expected : expected;
  if (actual.value.toLowerCase() !== normalized.toLowerCase()) {
    throw new Error(`${label} checksum mismatch: expected ${expected}, got ${actual.algorithm}:${actual.value}`);
  }
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function stripManifestSignature(manifest: PluginManifest): PluginManifest {
  const { signature, ...rest } = manifest;
  return rest;
}

async function listHashableFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (shouldSkipDir(entry.name)) continue;
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (shouldSkipFile(entry.name)) continue;
      const info = await stat(full);
      if (!info.isFile()) continue;
      files.push(full);
    }
  }
  await walk(root);
  return files.sort((a, b) => a.localeCompare(b));
}

function shouldSkipDir(name: string): boolean {
  return name === ".git" || name === "node_modules" || name === ".DS_Store";
}

function shouldSkipFile(name: string): boolean {
  return name === ".DS_Store";
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortJson(item)]),
  );
}
