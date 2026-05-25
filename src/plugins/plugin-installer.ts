import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { loadPluginManifest, validatePluginManifest } from "./plugin-manifest.js";
import { PluginStore } from "./plugin-store.js";
import {
  type InstalledPluginRecord,
  type PluginInstallRequest,
  type PluginScaffoldRequest,
  PLUGIN_MANIFEST_FILE,
} from "./plugin-types.js";

interface ResolvedPluginSource {
  type: "local" | "github";
  value: string;
  ref?: string;
  revision?: string;
  pluginDir: string;
  cleanup?: () => Promise<void>;
}

export class PluginInstaller {
  constructor(private readonly store: PluginStore) {}

  async install(request: PluginInstallRequest): Promise<InstalledPluginRecord> {
    const resolved = await this.resolveSource(request);
    try {
      const validation = await loadPluginManifest(resolved.pluginDir);
      if (!validation.ok || !validation.manifest) {
        throw new Error(validation.issues.map((issue) => issue.message).join("; ") || "Invalid plugin manifest.");
      }
      const manifest = validation.manifest;
      const destination = this.store.installVersionPath(manifest.id, manifest.version);
      const existing = await this.store.get(manifest.id);
      if (existing && !request.force && existing.version === manifest.version) {
        throw new Error(`Plugin ${manifest.id}@${manifest.version} is already installed. Use --force to reinstall.`);
      }
      await rm(destination, { recursive: true, force: true });
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(resolved.pluginDir, destination, {
        recursive: true,
        filter: (source) => !shouldSkipPath(source),
      });

      const now = new Date().toISOString();
      const settings = buildDefaultSettings(manifest.settings ?? [], existing?.settings ?? {});
      const record: InstalledPluginRecord = {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        author: manifest.author,
        homepage: manifest.homepage,
        repository: manifest.repository,
        license: manifest.license,
        nordrelay: manifest.nordrelay,
        entry: manifest.entry,
        installPath: destination,
        manifestPath: path.join(destination, PLUGIN_MANIFEST_FILE),
        source: {
          type: resolved.type,
          value: resolved.value,
          ref: resolved.ref,
          revision: resolved.revision,
        },
        enabled: Boolean(request.enable),
        status: request.enable ? "enabled" : "installed",
        permissions: manifest.permissions ?? [],
        approvedPermissions: request.approvePermissions ? manifest.permissions ?? [] : existing?.approvedPermissions ?? [],
        capabilities: manifest.capabilities ?? {},
        settingsSchema: manifest.settings ?? [],
        settings,
        installedAt: existing?.installedAt ?? now,
        updatedAt: now,
      };
      await this.store.save(record);
      return record;
    } finally {
      await resolved.cleanup?.();
    }
  }

  async validatePath(pluginDir: string) {
    const validation = await loadPluginManifest(path.resolve(pluginDir));
    if (validation.manifest) {
      const normalized = validatePluginManifest(validation.manifest);
      return normalized;
    }
    return validation;
  }

  async scaffold(request: PluginScaffoldRequest): Promise<string> {
    const targetDir = path.resolve(request.targetDir);
    const id = request.id.trim();
    const name = request.name?.trim() || id;
    const description = request.description?.trim() || "NordRelay plugin";
    const validation = validatePluginManifest({
      id,
      name,
      version: "0.1.0",
      description,
      entry: "index.js",
    });
    if (!validation.ok) {
      throw new Error(validation.issues.map((issue) => issue.message).join("; "));
    }
    await mkdir(targetDir, { recursive: true });
    await writeFile(
      path.join(targetDir, PLUGIN_MANIFEST_FILE),
      `${JSON.stringify(
        {
          id,
          name,
          version: "0.1.0",
          description,
          author: "",
          nordrelay: ">=0.9.8",
          entry: "index.js",
          permissions: [],
          capabilities: {
            workflowActions: [
              {
                id: `${id}.example`,
                title: "Example action",
                description: "Returns a small example payload.",
              },
            ],
          },
          settings: [],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeFile(
      path.join(targetDir, "index.js"),
      [
        "#!/usr/bin/env node",
        "",
        "process.stdin.setEncoding('utf8');",
        "let input = '';",
        "process.stdin.on('data', (chunk) => { input += chunk; });",
        "process.stdin.on('end', () => {",
        "  const request = input ? JSON.parse(input) : {};",
        "  process.stdout.write(JSON.stringify({ ok: true, request }) + '\\n');",
        "});",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(targetDir, "README.md"),
      `# ${name}\n\n${description}\n\nInstall locally with:\n\n\`\`\`sh\nnordrelay plugin install ${targetDir}\n\`\`\`\n`,
      "utf8",
    );
    return targetDir;
  }

  private async resolveSource(request: PluginInstallRequest): Promise<ResolvedPluginSource> {
    const source = request.source.trim();
    if (!source) {
      throw new Error("Plugin source is required.");
    }
    if (isGitHubSource(source)) {
      return this.cloneGitHubSource(source, request.ref);
    }
    const pluginDir = path.resolve(source);
    return {
      type: "local",
      value: pluginDir,
      pluginDir,
    };
  }

  private async cloneGitHubSource(source: string, ref?: string): Promise<ResolvedPluginSource> {
    const parsed = parseGitHubSource(source, ref);
    const tmp = await mkdtemp(path.join(os.tmpdir(), "nordrelay-plugin-"));
    const clone = spawnSync("git", ["clone", "--depth", "1", parsed.repoUrl, tmp], {
      encoding: "utf8",
      stdio: "pipe",
    });
    if (clone.status !== 0) {
      await rm(tmp, { recursive: true, force: true });
      throw new Error(`git clone failed: ${clone.stderr || clone.stdout || clone.error?.message || "unknown error"}`);
    }
    if (parsed.ref) {
      const checkout = spawnSync("git", ["checkout", parsed.ref], { cwd: tmp, encoding: "utf8", stdio: "pipe" });
      if (checkout.status !== 0) {
        await rm(tmp, { recursive: true, force: true });
        throw new Error(`git checkout failed: ${checkout.stderr || checkout.stdout || "unknown error"}`);
      }
    }
    const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: tmp, encoding: "utf8", stdio: "pipe" });
    return {
      type: "github",
      value: parsed.repoUrl,
      ref: parsed.ref,
      revision: revision.status === 0 ? revision.stdout.trim() : undefined,
      pluginDir: tmp,
      cleanup: () => rm(tmp, { recursive: true, force: true }),
    };
  }
}

function isGitHubSource(source: string): boolean {
  return source.startsWith("github:") || /^https:\/\/github\.com\/[^/]+\/[^/#]+/i.test(source);
}

function parseGitHubSource(source: string, ref?: string): { repoUrl: string; ref?: string } {
  if (source.startsWith("github:")) {
    const value = source.slice("github:".length);
    const [repo, inlineRef] = value.split("#", 2);
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
      throw new Error("GitHub plugin source must look like github:owner/repo or github:owner/repo#ref.");
    }
    return { repoUrl: `https://github.com/${repo}.git`, ref: ref ?? inlineRef };
  }
  const [url, inlineRef] = source.split("#", 2);
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/#]+?)(?:\.git)?$/i.exec(url);
  if (!match) {
    throw new Error("GitHub plugin source must be a github.com repository URL.");
  }
  return { repoUrl: `https://github.com/${match[1]}/${match[2]}.git`, ref: ref ?? inlineRef };
}

function shouldSkipPath(source: string): boolean {
  const parts = source.split(path.sep);
  return parts.includes(".git") || parts.includes("node_modules") || parts.includes(".DS_Store");
}

function buildDefaultSettings(
  schema: Array<{ key: string; default?: unknown; type: string }>,
  previous: Record<string, unknown>,
): Record<string, unknown> {
  const settings: Record<string, unknown> = {};
  for (const item of schema) {
    if (previous[item.key] !== undefined) {
      settings[item.key] = previous[item.key];
    } else if (item.default !== undefined) {
      settings[item.key] = item.default;
    } else {
      settings[item.key] = item.type === "boolean" ? false : "";
    }
  }
  return settings;
}
