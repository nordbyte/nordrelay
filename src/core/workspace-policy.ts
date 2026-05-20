import path from "node:path";

export interface WorkspacePolicyConfig {
  workspaceAllowedRoots: string[];
  workspaceWarnRoots: string[];
}

export interface WorkspacePolicyResult {
  allowed: boolean;
  warning?: string;
}

const BROAD_WORKSPACE_NAMES = new Set(["/", "home", "Users", "projects", "src", "code", "workspace"]);

export function evaluateWorkspacePolicy(workspace: string, config: WorkspacePolicyConfig): WorkspacePolicyResult {
  const resolved = path.resolve(workspace);
  const allowedRoots = config.workspaceAllowedRoots.map((root) => path.resolve(root));
  if (allowedRoots.length > 0 && !allowedRoots.some((root) => isPathInside(resolved, root))) {
    return {
      allowed: false,
      warning: `Workspace is outside allowed roots: ${resolved}`,
    };
  }

  const warnRoots = config.workspaceWarnRoots.map((root) => path.resolve(root));
  const explicitWarningRoot = warnRoots.find((root) => resolved === root);
  if (explicitWarningRoot) {
    return {
      allowed: true,
      warning: `Workspace is a broad configured root: ${explicitWarningRoot}`,
    };
  }

  const basename = path.basename(resolved) || resolved;
  if (BROAD_WORKSPACE_NAMES.has(basename) && resolved.split(path.sep).filter(Boolean).length <= 3) {
    return {
      allowed: true,
      warning: `Workspace looks broad; prefer a project-specific directory: ${resolved}`,
    };
  }

  return { allowed: true };
}

export function filterAllowedWorkspaces(workspaces: string[], config: WorkspacePolicyConfig): string[] {
  return workspaces.filter((workspace) => evaluateWorkspacePolicy(workspace, config).allowed);
}

export function renderWorkspacePolicyLine(workspace: string, config: WorkspacePolicyConfig): string | undefined {
  const result = evaluateWorkspacePolicy(workspace, config);
  if (!result.allowed) {
    return `Blocked: ${result.warning}`;
  }
  return result.warning ? `Warning: ${result.warning}` : undefined;
}

function isPathInside(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}
