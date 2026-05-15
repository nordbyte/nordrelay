import { findExecutableOnPath } from "./codex-cli.js";

export interface OpenClawCliResolution {
  path?: string;
  source: "env" | "path" | "missing";
}

export function resolveOpenClawCli(
  env: NodeJS.ProcessEnv = process.env,
  explicitPath?: string,
): OpenClawCliResolution {
  const configuredPath = optionalString(explicitPath) ?? optionalString(env.OPENCLAW_CLI_PATH);
  if (configuredPath) {
    return { path: configuredPath, source: "env" };
  }

  const pathMatch = findExecutableOnPath("openclaw", env.PATH, { pathext: env.PATHEXT });
  return pathMatch ? { path: pathMatch, source: "path" } : { source: "missing" };
}

export function describeOpenClawCli(resolution: OpenClawCliResolution): string {
  if (resolution.path) {
    return `${resolution.source} (${resolution.path})`;
  }
  return "missing";
}

function optionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
