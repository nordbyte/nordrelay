import { accessSync, constants, realpathSync } from "node:fs";
import path from "node:path";

export interface CodexCliResolution {
  path?: string;
  source: "env" | "path" | "bundled";
}

/**
 * Prefer the host Codex CLI so normal `codex` updates are picked up by the
 * connector. Falls back to the SDK-bundled CLI when no external binary exists.
 */
export function resolveCodexCli(env: NodeJS.ProcessEnv = process.env): CodexCliResolution {
  const explicitPath = optionalString(env.CODEX_CLI_PATH);
  if (explicitPath) {
    return { path: explicitPath, source: "env" };
  }

  if (isEnabled(env.CODEX_USE_BUNDLED_CLI)) {
    return { source: "bundled" };
  }

  const pathMatch = findExecutableOnPath("codex", env.PATH, { pathext: env.PATHEXT });
  return pathMatch ? { path: pathMatch, source: "path" } : { source: "bundled" };
}

export function describeCodexCli(resolution: CodexCliResolution): string {
  if (resolution.path) {
    return `${resolution.source} (${resolution.path})`;
  }
  return "bundled @openai/codex";
}

export function findExecutableOnPath(
  command: string,
  pathValue: string | undefined,
  options: { platform?: NodeJS.Platform; pathext?: string } = {},
): string | undefined {
  if (!pathValue) {
    return undefined;
  }

  const extensions = executableExtensions(options.platform ?? process.platform, options.pathext ?? process.env.PATHEXT);

  for (const rawDirectory of pathValue.split(path.delimiter)) {
    const directory = rawDirectory.trim();
    if (!directory) {
      continue;
    }

    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension}`);
      if (!isExecutable(candidate) || isProjectLocalBin(candidate)) {
        continue;
      }
      return candidate;
    }
  }

  return undefined;
}

function executableExtensions(platform: NodeJS.Platform, pathextValue: string | undefined): string[] {
  if (platform !== "win32") {
    return [""];
  }

  const pathext = (pathextValue || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((extension) => extension.trim())
    .filter(Boolean)
    .map((extension) => extension.startsWith(".") ? extension : `.${extension}`);
  return [...new Set([...pathext, ""])];
}

function isExecutable(filePath: string): boolean {
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isProjectLocalBin(filePath: string): boolean {
  const absolute = path.resolve(filePath);
  const resolved = resolveRealPath(filePath);
  const localBin = path.resolve(process.cwd(), "node_modules", ".bin");
  return (
    absolute === localBin ||
    absolute.startsWith(`${localBin}${path.sep}`) ||
    resolved === localBin ||
    resolved.startsWith(`${localBin}${path.sep}`)
  );
}

function resolveRealPath(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function optionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isEnabled(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}
