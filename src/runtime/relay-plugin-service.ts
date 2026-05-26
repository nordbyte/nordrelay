import { PluginService } from "../plugins/plugin-service.js";
import { getPackageVersion } from "../support/operations.js";
import type { RelayRuntime } from "./relay-runtime.js";

export function createRuntimePluginService(runtime: RelayRuntime, home: string): PluginService {
  const config = runtime.config;
  return new PluginService(home, {
    enabled: config.pluginsEnabled,
    nodeName: config.peerName,
    platform: process.platform,
    workspace: config.workspace,
    hostContext: async () => ({
      runtime: {
        version: await getPackageVersion(),
        nodeName: config.peerName,
        platform: process.platform,
        workspace: config.workspace,
      },
      session: await runtime.getSession(true).then((session) => runtime.publicInfo(session)).catch(() => undefined),
      activity: runtime.activity({ limit: 50 }),
      artifacts: await runtime.artifacts(20).catch(() => []),
      workflows: {
        templates: runtime.workflowStore.listTemplates().map((template) => ({ id: template.id, name: template.name, updatedAt: template.updatedAt })),
        workflows: runtime.workflowStore.listWorkflows().map((workflow) => ({ id: workflow.id, name: workflow.name, updatedAt: workflow.updatedAt })),
      },
      settings: {
        workspace: config.workspace,
        stateBackend: config.stateBackend,
        agents: {
          codex: config.codexEnabled,
          pi: config.piEnabled,
          hermes: config.hermesEnabled,
          openclaw: config.openClawEnabled,
          claudeCode: config.claudeCodeEnabled,
        },
      },
    }),
  });
}
