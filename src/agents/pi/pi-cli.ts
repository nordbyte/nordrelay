import { findExecutableOnPath } from "../codex/codex-cli.js";

export interface PiCliResolution {
  path?: string;
  source: "env" | "path" | "missing";
}

export function resolvePiCli(
  env: NodeJS.ProcessEnv = process.env,
  explicitPath?: string,
): PiCliResolution {
  const configuredPath = optionalString(explicitPath) ?? optionalString(env.PI_CLI_PATH);
  if (configuredPath) {
    return { path: configuredPath, source: "env" };
  }

  const pathMatch = findExecutableOnPath("pi", env.PATH, { pathext: env.PATHEXT });
  return pathMatch ? { path: pathMatch, source: "path" } : { source: "missing" };
}

export function describePiCli(resolution: PiCliResolution): string {
  if (resolution.path) {
    return `${resolution.source} (${resolution.path})`;
  }
  return "missing";
}

function optionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
