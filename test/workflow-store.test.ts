import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  WorkflowStore,
  extractTemplateVariables,
  renderTemplateText,
} from "../src/state/workflow-store.js";
import {
  channelTemplatePrompt,
  channelWorkflowPrompts,
  parseChannelWorkflowArgument,
} from "../src/channels/shared/channel-workflow-commands.js";
import type { ConnectorConfig } from "../src/core/config.js";

describe("WorkflowStore", () => {
  it("persists prompt templates, workflows, and run state", () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "nordrelay-workflows-"));
    try {
      const store = new WorkflowStore(workspace, "json");
      const template = store.saveTemplate({
        name: "Review target",
        prompt: "Review {{target}} for {{focus}}.",
        scope: "shared",
      });
      const workflow = store.saveWorkflow({
        name: "Review workflow",
        steps: [{ name: "Review", templateId: template.id, sessionMode: "current", target: "local", type: "prompt", requiresApproval: false, continueOnError: false }],
      });
      const run = store.saveRun({
        id: "run-test",
        workflowId: workflow.id,
        name: workflow.name,
        status: "queued",
        variables: { target: "src", focus: "bugs" },
        steps: [{ stepId: workflow.steps[0]!.id, name: "Review", status: "pending" }],
        currentStepIndex: 0,
        createdAt: "2026-05-16T10:00:00.000Z",
        updatedAt: "2026-05-16T10:00:00.000Z",
      });

      store.patchRun(run.id, { status: "running" });

      const restored = new WorkflowStore(workspace, "json");
      expect(restored.getTemplate(template.id)?.variables.map((variable) => variable.name)).toEqual(["target", "focus"]);
      expect(restored.getWorkflow(workflow.id)?.steps[0]).toMatchObject({ templateId: template.id, target: "local" });
      expect(restored.getRun(run.id)?.status).toBe("running");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("renders template variables and channel workflow arguments", () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "nordrelay-workflows-"));
    try {
      const store = new WorkflowStore(workspace, "json");
      const template = store.saveTemplate({ name: "Fix", prompt: "Fix {{area}} in {{repo}}." });
      const workflow = store.saveWorkflow({
        name: "Fix flow",
        steps: [{ name: "Fix", templateId: template.id, sessionMode: "current", target: "local", type: "prompt", requiresApproval: false, continueOnError: false }],
      });
      const config = { workspace, stateBackend: "json" } as ConnectorConfig;

      expect(extractTemplateVariables("A {{one}} B {{two}} {{one}}").map((variable) => variable.name)).toEqual(["one", "two"]);
      expect(renderTemplateText("Hello {{name}}", { name: "NordRelay" })).toBe("Hello NordRelay");
      expect(parseChannelWorkflowArgument(`${template.id} {"area":"chat","repo":"nordrelay"}`)).toEqual({
        id: template.id,
        variables: { area: "chat", repo: "nordrelay" },
      });
      expect(channelTemplatePrompt(config, template.id, { area: "chat", repo: "nordrelay" }).prompt).toBe("Fix chat in nordrelay.");
      expect(channelWorkflowPrompts(config, workflow.id, { area: "runtime", repo: "nordrelay" })[0]?.prompt).toBe("Fix runtime in nordrelay.");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("stores workflow versions, diffs, rollback snapshots, and import/export bundles", () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "nordrelay-workflows-"));
    const importWorkspace = mkdtempSync(path.join(tmpdir(), "nordrelay-workflows-import-"));
    try {
      const store = new WorkflowStore(workspace, "json");
      const template = store.saveTemplate({ name: "Draft", prompt: "One {{target}}." });
      const updatedTemplate = store.saveTemplate({ ...template, prompt: "Two {{target}}." });
      const workflow = store.saveWorkflow({
        name: "Flow",
        steps: [{ name: "Step 1", prompt: "Do one", sessionMode: "current", target: "local", type: "prompt", requiresApproval: false, continueOnError: false }],
      });
      const updatedWorkflow = store.saveWorkflow({
        ...workflow,
        steps: workflow.steps.concat({ name: "Step 2", prompt: "Do two", sessionMode: "current", target: "local", type: "prompt", requiresApproval: false, continueOnError: false }),
      });

      expect(store.listVersions("template", template.id).map((version) => version.version)).toEqual([2, 1]);
      expect(store.diffVersions("template", template.id).changes.some((change) => change.path === "prompt")).toBe(true);
      expect(store.exportTemplate(template.id, 1)?.version?.version).toBe(1);

      const restored = store.restoreVersion("template", updatedTemplate.id, 1);
      expect(restored).toMatchObject({ prompt: "One {{target}}." });
      expect(store.getTemplate(template.id)?.prompt).toBe("One {{target}}.");
      expect(store.listVersions("workflow", workflow.id).map((version) => version.version)).toEqual([2, 1]);
      expect(store.exportWorkflow(updatedWorkflow.id)?.workflow?.steps).toHaveLength(2);

      const imported = new WorkflowStore(importWorkspace, "json");
      const importedTemplate = imported.importTemplate(store.exportTemplate(template.id, 1));
      const importedWorkflow = imported.importWorkflow(store.exportWorkflow(workflow.id, 2));
      expect(importedTemplate.id).not.toBe(template.id);
      expect(importedTemplate.prompt).toBe("One {{target}}.");
      expect(importedWorkflow.id).not.toBe(workflow.id);
      expect(importedWorkflow.steps).toHaveLength(2);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(importWorkspace, { recursive: true, force: true });
    }
  });
});
