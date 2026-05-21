import type { ConnectorConfig } from "../../core/config.js";
import {
  WorkflowStore,
  assertRequiredTemplateVariables,
  extractTemplateVariables,
  renderTemplateText,
  type PromptTemplate,
  type Workflow,
} from "../../state/workflow-store.js";

export interface ChannelWorkflowSelection {
  id: string;
  name: string;
  prompt: string;
}

export function renderChannelTemplateList(config: ConnectorConfig): string {
  const templates = new WorkflowStore(config.workspace, config.stateBackend).listTemplates();
  if (templates.length === 0) {
    return "No prompt templates saved yet.";
  }
  return ["Templates:", ...templates.slice(0, 20).map((template) => `${template.id} - ${template.name}`)].join("\n");
}

export function renderChannelWorkflowList(config: ConnectorConfig): string {
  const workflows = new WorkflowStore(config.workspace, config.stateBackend).listWorkflows();
  if (workflows.length === 0) {
    return "No workflows saved yet.";
  }
  return ["Workflows:", ...workflows.slice(0, 20).map((workflow) => `${workflow.id} - ${workflow.name} (${workflow.steps.length} steps)`)].join("\n");
}

export function channelTemplatePrompt(config: ConnectorConfig, id: string, variables: Record<string, string> = {}): ChannelWorkflowSelection {
  const store = new WorkflowStore(config.workspace, config.stateBackend);
  const template = requireTemplate(store, id);
  assertRequiredTemplateVariables(template.variables, variables, template.name);
  return {
    id: template.id,
    name: template.name,
    prompt: renderTemplate(template, variables),
  };
}

export function channelWorkflowPrompts(config: ConnectorConfig, id: string, variables: Record<string, string> = {}): ChannelWorkflowSelection[] {
  const store = new WorkflowStore(config.workspace, config.stateBackend);
  const workflow = requireWorkflow(store, id);
  assertWorkflowRequiredVariables(store, workflow, variables);
  return workflow.steps.map((step) => {
    const template = step.templateId ? requireTemplate(store, step.templateId) : null;
    const prompt = template ? renderTemplate(template, variables) : renderTemplateText(step.prompt ?? "", variables).trim();
    if (!prompt) {
      throw new Error(`Workflow step ${step.name} has no prompt.`);
    }
    return {
      id: step.id,
      name: step.name,
      prompt,
    };
  });
}

export function parseChannelWorkflowArgument(argument: string): { id: string; variables: Record<string, string> } {
  const trimmed = argument.trim();
  const match = trimmed.match(/^(\S+)(?:\s+([\s\S]+))?$/);
  const id = match?.[1] ?? "";
  const rawVariables = match?.[2]?.trim();
  if (!rawVariables) return { id, variables: {} };
  const parsed = JSON.parse(rawVariables);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Variables must be a JSON object.");
  }
  return {
    id,
    variables: Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, String(value ?? "")])),
  };
}

function requireTemplate(store: WorkflowStore, id: string): PromptTemplate {
  const template = store.getTemplate(id);
  if (!template) throw new Error(`Template not found: ${id}`);
  return template;
}

function requireWorkflow(store: WorkflowStore, id: string): Workflow {
  const workflow = store.getWorkflow(id);
  if (!workflow) throw new Error(`Workflow not found: ${id}`);
  return workflow;
}

function renderTemplate(template: PromptTemplate, variables: Record<string, string>): string {
  const defaults = Object.fromEntries(template.variables.map((variable) => [variable.name, variable.defaultValue ?? ""]));
  return renderTemplateText(template.prompt, { ...defaults, ...variables }).trim();
}

function assertWorkflowRequiredVariables(store: WorkflowStore, workflow: Workflow, variables: Record<string, string>, seen = new Set<string>()): void {
  if (seen.has(workflow.id)) return;
  seen.add(workflow.id);
  for (const step of workflow.steps) {
    if (step.type === "workflow" && step.workflowId) {
      assertWorkflowRequiredVariables(store, requireWorkflow(store, step.workflowId), variables, seen);
      continue;
    }
    if (step.templateId) {
      const template = requireTemplate(store, step.templateId);
      assertRequiredTemplateVariables(template.variables, variables, `${workflow.name} / ${step.name}`);
      continue;
    }
    assertRequiredTemplateVariables(extractTemplateVariables(step.prompt ?? ""), variables, `${workflow.name} / ${step.name}`);
  }
}
