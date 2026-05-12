import { findExecutableOnPath } from "./codex-cli.js";

export interface HermesCliResolution {
  path?: string;
  source: "env" | "path" | "missing";
}

export function resolveHermesCli(
  env: NodeJS.ProcessEnv = process.env,
  explicitPath?: string,
): HermesCliResolution {
  const configuredPath = optionalString(explicitPath) ?? optionalString(env.HERMES_CLI_PATH);
  if (configuredPath) {
    return { path: configuredPath, source: "env" };
  }

  const pathMatch = findExecutableOnPath("hermes", env.PATH);
  return pathMatch ? { path: pathMatch, source: "path" } : { source: "missing" };
}

export function describeHermesCli(resolution: HermesCliResolution): string {
  if (resolution.path) {
    return `${resolution.source} (${resolution.path})`;
  }
  return "missing";
}

function optionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
