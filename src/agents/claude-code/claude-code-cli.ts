import { findExecutableOnPath } from "../codex/codex-cli.js";

export interface ClaudeCodeCliResolution {
  path?: string;
  source: "env" | "path" | "bundled";
}

export function resolveClaudeCodeCli(
  env: NodeJS.ProcessEnv = process.env,
  explicitPath?: string,
): ClaudeCodeCliResolution {
  const configuredPath = optionalString(explicitPath) ?? optionalString(env.CLAUDE_CODE_CLI_PATH);
  if (configuredPath) {
    return { path: configuredPath, source: "env" };
  }

  const pathMatch = findExecutableOnPath("claude", env.PATH, { pathext: env.PATHEXT });
  return pathMatch ? { path: pathMatch, source: "path" } : { source: "bundled" };
}

export function describeClaudeCodeCli(resolution: ClaudeCodeCliResolution): string {
  if (resolution.path) {
    return `${resolution.source} (${resolution.path})`;
  }
  return "bundled @anthropic-ai/claude-agent-sdk";
}

function optionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
