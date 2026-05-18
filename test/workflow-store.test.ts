import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  WorkflowStore,
  extractTemplateVariables,
  renderTemplateText,
} from "../src/state/workflow-store.js";
import { RelayWorkflowService, type RelayWorkflowServiceOptions } from "../src/runtime/relay-workflow-service.js";
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

  it("stores workflow debug logs and builds run reports", () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "nordrelay-workflows-"));
    try {
      const store = new WorkflowStore(workspace, "json");
      const run = store.saveRun({
        id: "run-debug",
        workflowId: "workflow-debug",
        name: "Debug workflow",
        status: "completed",
        variables: { target: "src" },
        steps: [
          {
            stepId: "step-1",
            name: "Review",
            status: "completed",
            inputPreview: "Review src",
            outputSummary: "No critical issues.",
            startedAt: "2026-05-16T10:00:00.000Z",
            finishedAt: "2026-05-16T10:00:02.000Z",
          },
          {
            stepId: "step-2",
            name: "Skip optional",
            status: "skipped",
            skippedReason: "Condition did not match.",
            pauseReason: "Manual approval required.",
          },
        ],
        currentStepIndex: 2,
        createdAt: "2026-05-16T10:00:00.000Z",
        updatedAt: "2026-05-16T10:00:02.000Z",
        startedAt: "2026-05-16T10:00:00.000Z",
        finishedAt: "2026-05-16T10:00:02.000Z",
      });

      store.appendRunLog(run.id, {
        at: "2026-05-16T10:00:01.000Z",
        level: "info",
        scope: "step",
        stepId: "step-1",
        message: "Step completed.",
        detail: "Review",
      });

      const restored = new WorkflowStore(workspace, "json");
      expect(restored.getRun(run.id)?.logs?.[0]).toMatchObject({
        level: "info",
        scope: "step",
        stepId: "step-1",
        message: "Step completed.",
      });
      expect(restored.getRun(run.id)?.steps[0]).toMatchObject({
        inputPreview: "Review src",
        outputSummary: "No critical issues.",
      });

      const service = new RelayWorkflowService(workflowServiceOptions(restored));
      try {
        const report = service.runReport(run.id);
        expect(report.summary).toEqual({
          status: "completed",
          totalSteps: 2,
          completedSteps: 1,
          failedSteps: 0,
          skippedSteps: 1,
          durationMs: 2000,
        });
        expect(report.logs).toHaveLength(1);
        expect(report.steps[1]).toMatchObject({ pauseReason: "Manual approval required." });
      } finally {
        service.dispose();
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

function workflowServiceOptions(store: WorkflowStore): RelayWorkflowServiceOptions {
  return {
    store,
    getSession: async () => { throw new Error("not needed"); },
    newSession: async () => undefined,
    setAgent: async () => undefined,
    attachSession: async () => undefined,
    runPrompt: async () => {},
    isSessionBusy: () => false,
    abort: async () => {},
    appendActivity: (input) => ({
      id: "activity",
      timestamp: input.timestamp ?? new Date().toISOString(),
      ...input,
    }),
    appendAudit: (input) => ({
      id: "audit",
      timestamp: new Date().toISOString(),
      channelId: "web",
      contextKey: "web:dashboard",
      ...input,
    }),
    upsertJob: () => {},
    broadcastStatus: () => {},
  };
}
