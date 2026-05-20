import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";

import type { CodexLaunchProfile } from "../codex/codex-launch.js";
import type { AgentLaunchProfileRecord } from "../shared/agent.js";

export interface ClaudeCodeLaunchProfile extends AgentLaunchProfileRecord {
  permissionMode: PermissionMode;
  tools?: string[];
  allowedTools?: string[];
  disallowedTools?: string[];
  instructions?: string;
  allowDangerouslySkipPermissions?: boolean;
}

const CLAUDE_CODE_LAUNCH_PROFILES: ClaudeCodeLaunchProfile[] = [
  {
    id: "default",
    label: "Default",
    behavior: "Claude Code default permissions; ask before risky operations.",
    unsafe: false,
    permissionMode: "default",
  },
  {
    id: "accept-edits",
    label: "Accept Edits",
    behavior: "Auto-accept file edits; keep approval checks for other risky tools.",
    unsafe: false,
    permissionMode: "acceptEdits",
  },
  {
    id: "plan",
    label: "Plan",
    behavior: "Plan mode; no direct implementation tools.",
    unsafe: false,
    permissionMode: "plan",
  },
  {
    id: "readonly",
    label: "Read Only",
    behavior: "Read-only inspection tools only; no file writes or shell execution.",
    unsafe: false,
    permissionMode: "dontAsk",
    tools: ["Read", "Grep", "Glob", "LS"],
  },
  {
    id: "no-tools",
    label: "No Tools",
    behavior: "Conversation only; all built-in tools disabled.",
    unsafe: false,
    permissionMode: "dontAsk",
    tools: [],
  },
  {
    id: "bypass-permissions",
    label: "Bypass Permissions",
    behavior: "Bypass Claude Code permission prompts. Use only in trusted workspaces.",
    unsafe: true,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
  },
];

export function listClaudeCodeLaunchProfiles(includeUnsafe = false): AgentLaunchProfileRecord[] {
  return CLAUDE_CODE_LAUNCH_PROFILES
    .filter((profile) => includeUnsafe || !profile.unsafe)
    .map(({ id, label, behavior, unsafe }) => ({ id, label, behavior, unsafe }));
}

export function findClaudeCodeLaunchProfile(profileId: string | undefined, includeUnsafe = false): ClaudeCodeLaunchProfile {
  const fallback = CLAUDE_CODE_LAUNCH_PROFILES[0]!;
  const normalized = profileId?.trim() || fallback.id;
  const profile = CLAUDE_CODE_LAUNCH_PROFILES.find((candidate) => candidate.id === normalized);
  if (!profile || (profile.unsafe && !includeUnsafe)) {
    if (normalized === fallback.id) {
      return fallback;
    }
    throw new Error(`Unknown Claude Code launch profile: ${normalized}`);
  }
  return profile;
}

export function claudeCodeProfileAsLaunchProfile(profile: ClaudeCodeLaunchProfile): CodexLaunchProfile {
  return {
    id: profile.id,
    label: profile.label,
    sandboxMode: "workspace-write",
    approvalPolicy: profile.permissionMode === "bypassPermissions" ? "never" : "on-request",
    unsafe: profile.unsafe,
  };
}
