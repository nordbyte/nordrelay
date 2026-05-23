import type { AgentId, AgentLaunchProfileRecord } from "./agent.js";

const CODEX_FULL_ACCESS_PROFILE: AgentLaunchProfileRecord = {
  id: "full-access",
  label: "Full Access",
  behavior: "danger-full-access / never",
  unsafe: true,
};

const CLAUDE_CODE_BYPASS_PROFILE: AgentLaunchProfileRecord = {
  id: "bypass-permissions",
  label: "Bypass Permissions",
  behavior: "Bypass Claude Code permission prompts. Use only in trusted workspaces.",
  unsafe: true,
};

export function knownUnsafeLaunchProfile(agentId: AgentId | undefined, profileId: string | undefined): AgentLaunchProfileRecord | null {
  const normalized = profileId?.trim();
  if (!normalized) {
    return null;
  }
  return knownUnsafeLaunchProfiles(agentId).find((profile) => profile.id === normalized) ?? null;
}

export function knownUnsafeLaunchProfiles(agentId: AgentId | undefined): AgentLaunchProfileRecord[] {
  if (agentId === "codex") {
    return [CODEX_FULL_ACCESS_PROFILE];
  }
  if (agentId === "claude-code") {
    return [CLAUDE_CODE_BYPASS_PROFILE];
  }
  return [];
}

export function findLaunchProfileRecord(
  agentId: AgentId | undefined,
  profileId: string | undefined,
  profiles: AgentLaunchProfileRecord[],
): AgentLaunchProfileRecord | null {
  const normalized = profileId?.trim();
  if (!normalized) {
    return null;
  }
  return profiles.find((profile) => profile.id === normalized) ?? knownUnsafeLaunchProfile(agentId, normalized);
}
