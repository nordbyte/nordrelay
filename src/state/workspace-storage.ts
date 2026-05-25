import { createHash } from "node:crypto";
import path from "node:path";

import { ensurePrivateDir, readJsonFileWithBackup, writeJsonFileAtomic } from "./persistence.js";
import { resolveNordRelayHome } from "./nordrelay-home.js";

export interface WorkspaceStorageIndexEntry {
  id: string;
  path: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceStorageIndex {
  version: 1;
  workspaces: WorkspaceStorageIndexEntry[];
}

const INDEX_FILE = "index.json";
const rememberedWorkspaces = new Set<string>();

export function workspaceStorageId(workspace: string): string {
  return createHash("sha256").update(normalizeWorkspaceForId(workspace)).digest("hex").slice(0, 24);
}

export function workspaceStorageRoot(workspace: string): string {
  const home = resolveNordRelayHome();
  const id = workspaceStorageId(workspace);
  const root = path.join(home, "workspaces", id);
  rememberWorkspaceStorage(home, id, workspace);
  return root;
}

export function workspaceInboxRoot(workspace: string): string {
  return path.join(workspaceStorageRoot(workspace), "inbox");
}

export function workspaceTurnsRoot(workspace: string): string {
  return path.join(workspaceStorageRoot(workspace), "turns");
}

export function workspaceStorageIndexPath(home = resolveNordRelayHome()): string {
  return path.join(home, "workspaces", INDEX_FILE);
}

function rememberWorkspaceStorage(home: string, id: string, workspace: string): void {
  const resolvedWorkspace = resolveWorkspacePath(workspace);
  const key = `${home}\0${id}\0${resolvedWorkspace}`;
  if (rememberedWorkspaces.has(key)) {
    return;
  }

  const workspacesDir = path.join(home, "workspaces");
  ensurePrivateDir(workspacesDir);
  const indexPath = workspaceStorageIndexPath(home);
  const read = readJsonFileWithBackup<WorkspaceStorageIndex>(indexPath);
  const now = new Date().toISOString();
  const index = normalizeWorkspaceIndex(read.value);
  const existing = index.workspaces.find((entry) => entry.id === id);
  if (existing) {
    if (existing.path !== resolvedWorkspace) {
      existing.path = resolvedWorkspace;
    }
    existing.updatedAt = now;
  } else {
    index.workspaces.push({
      id,
      path: resolvedWorkspace,
      createdAt: now,
      updatedAt: now,
    });
  }

  index.workspaces.sort((left, right) => left.path.localeCompare(right.path));
  writeJsonFileAtomic(indexPath, index, { preserveExistingBackup: read.recoveredFromBackup });
  rememberedWorkspaces.add(key);
}

function normalizeWorkspaceIndex(value: WorkspaceStorageIndex | undefined): WorkspaceStorageIndex {
  if (!value || value.version !== 1 || !Array.isArray(value.workspaces)) {
    return { version: 1, workspaces: [] };
  }
  return {
    version: 1,
    workspaces: value.workspaces
      .filter((entry) => typeof entry.id === "string" && typeof entry.path === "string")
      .map((entry) => ({
        id: entry.id,
        path: entry.path,
        createdAt: typeof entry.createdAt === "string" ? entry.createdAt : new Date(0).toISOString(),
        updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : new Date(0).toISOString(),
      })),
  };
}

function normalizeWorkspaceForId(workspace: string): string {
  const resolved = resolveWorkspacePath(workspace);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function resolveWorkspacePath(workspace: string): string {
  const candidate = typeof workspace === "string" && workspace.trim() ? workspace.trim() : process.cwd();
  return path.resolve(candidate);
}
