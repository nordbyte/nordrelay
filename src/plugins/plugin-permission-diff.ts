import type {
  InstalledPluginRecord,
  PluginCapabilitiesManifest,
  PluginManifest,
  PluginPermissionDiff,
} from "./plugin-types.js";

export function diffPluginManifestPermissions(
  previous: InstalledPluginRecord | undefined,
  next: PluginManifest,
): PluginPermissionDiff {
  const previousPermissions = new Set(previous?.permissions ?? []);
  const nextPermissions = new Set(next.permissions ?? []);
  const addedPermissions = sorted([...nextPermissions].filter((permission) => !previousPermissions.has(permission)));
  const removedPermissions = sorted([...previousPermissions].filter((permission) => !nextPermissions.has(permission)));
  const unchangedPermissions = sorted([...nextPermissions].filter((permission) => previousPermissions.has(permission)));
  const previousCapabilities = capabilitySignatures(previous?.capabilities ?? {});
  const nextCapabilities = capabilitySignatures(next.capabilities ?? {});
  const previousCapabilitySet = new Set(previousCapabilities);
  const nextCapabilitySet = new Set(nextCapabilities);
  const addedCapabilities = sorted(nextCapabilities.filter((capability) => !previousCapabilitySet.has(capability)));
  const removedCapabilities = sorted(previousCapabilities.filter((capability) => !nextCapabilitySet.has(capability)));
  const changedCapabilities = changedCapabilityLabels(previous?.capabilities ?? {}, next.capabilities ?? {});
  const riskyChanges = [
    ...addedPermissions.filter(isWriteOrNetworkPermission).map((permission) => `Added sensitive permission ${permission}`),
    ...addedCapabilities.filter((capability) => /web-panel:.*:client-script$/.test(capability)).map((capability) => `Added trusted client script ${capability}`),
    ...changedCapabilities.filter((capability) => /client-script/.test(capability)).map((capability) => `Changed trusted client script ${capability}`),
  ];
  return {
    addedPermissions,
    removedPermissions,
    unchangedPermissions,
    addedCapabilities,
    removedCapabilities,
    changedCapabilities,
    riskyChanges,
    hasEscalation: addedPermissions.length > 0 || riskyChanges.length > 0,
  };
}

export function formatPermissionDiff(diff: PluginPermissionDiff): string {
  const parts = [
    diff.addedPermissions.length ? `added permissions: ${diff.addedPermissions.join(", ")}` : "",
    diff.removedPermissions.length ? `removed permissions: ${diff.removedPermissions.join(", ")}` : "",
    diff.addedCapabilities.length ? `added capabilities: ${diff.addedCapabilities.join(", ")}` : "",
    diff.changedCapabilities.length ? `changed capabilities: ${diff.changedCapabilities.join(", ")}` : "",
    diff.riskyChanges.length ? `risk: ${diff.riskyChanges.join("; ")}` : "",
  ].filter(Boolean);
  return parts.join(" | ") || "no permission or capability changes";
}

function capabilitySignatures(capabilities: PluginCapabilitiesManifest): string[] {
  const values: string[] = [];
  for (const item of capabilities.commands ?? []) values.push(`command:${item.name}`);
  for (const item of capabilities.workflowActions ?? []) values.push(`workflow-action:${item.id}`);
  for (const item of capabilities.webPanels ?? []) {
    values.push(`web-panel:${item.id}`);
    if (item.allowClientScript) values.push(`web-panel:${item.id}:client-script`);
  }
  for (const item of capabilities.agentAdapters ?? []) values.push(`agent-adapter:${item.id}`);
  for (const item of capabilities.chatAdapters ?? []) values.push(`chat-adapter:${item.id}`);
  for (const item of capabilities.artifactHandlers ?? []) values.push(`artifact-handler:${item.id}`);
  for (const item of capabilities.collectors ?? []) values.push(`collector:${item.id}`);
  if (capabilities.diagnostics) values.push("diagnostics");
  return sorted(values);
}

function changedCapabilityLabels(previous: PluginCapabilitiesManifest, next: PluginCapabilitiesManifest): string[] {
  const changes: string[] = [];
  const previousPanels = new Map((previous.webPanels ?? []).map((panel) => [panel.id, panel]));
  for (const panel of next.webPanels ?? []) {
    const old = previousPanels.get(panel.id);
    if (!old) continue;
    if (Boolean(old.allowClientScript) !== Boolean(panel.allowClientScript)) {
      changes.push(`web-panel:${panel.id}:client-script`);
    }
    if ((old.permission ?? "") !== (panel.permission ?? "")) {
      changes.push(`web-panel:${panel.id}:permission`);
    }
  }
  return sorted(changes);
}

function isWriteOrNetworkPermission(permission: string): boolean {
  return permission.endsWith(".write") || permission === "network";
}

function sorted(values: string[]): string[] {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
}
