import type { AgentLaunchProfileRecord } from "../shared/agent.js";
import { createLaunchProfile, type CodexLaunchProfile } from "../codex/codex-launch.js";

export interface PiLaunchProfile extends AgentLaunchProfileRecord {
  cli: {
    tools?: string;
    noTools?: boolean;
    noBuiltinTools?: boolean;
    offline?: boolean;
    noExtensions?: boolean;
    noSkills?: boolean;
  };
}

export const PI_LAUNCH_PROFILES: PiLaunchProfile[] = [
  {
    id: "default",
    label: "Default",
    behavior: "all tools / online / extensions",
    unsafe: false,
    cli: {},
  },
  {
    id: "readonly",
    label: "Read-only",
    behavior: "read, grep, find, ls / online",
    unsafe: false,
    cli: { tools: "read,grep,find,ls" },
  },
  {
    id: "no-tools",
    label: "No tools",
    behavior: "no tools / online",
    unsafe: false,
    cli: { noTools: true },
  },
  {
    id: "offline",
    label: "Offline",
    behavior: "all tools / offline / extensions",
    unsafe: false,
    cli: { offline: true },
  },
  {
    id: "safe-offline",
    label: "Safe Offline",
    behavior: "read-only tools / offline / no extensions",
    unsafe: false,
    cli: { tools: "read,grep,find,ls", offline: true, noExtensions: true },
  },
];

export function listPiLaunchProfiles(): AgentLaunchProfileRecord[] {
  return PI_LAUNCH_PROFILES.map((profile) => ({
    id: profile.id,
    label: profile.label,
    behavior: profile.behavior,
    unsafe: profile.unsafe,
  }));
}

export function findPiLaunchProfile(profileId: string | undefined): PiLaunchProfile {
  const profile = PI_LAUNCH_PROFILES.find((candidate) => candidate.id === profileId);
  if (profile) {
    return profile;
  }
  return PI_LAUNCH_PROFILES[0]!;
}

export function piProfileAsLaunchProfile(profile: PiLaunchProfile): CodexLaunchProfile {
  return createLaunchProfile({
    id: profile.id,
    label: profile.label,
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
  });
}
