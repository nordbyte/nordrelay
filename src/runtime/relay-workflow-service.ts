import type { AuditEvent } from "../access/audit-log.js";
import type { AgentId, AgentSessionService } from "../agents/shared/agent.js";
import type { PromptEnvelope } from "../state/prompt-store.js";
import { createCorrelationId, toPromptEnvelope } from "../state/prompt-store.js";
import {
  renderTemplateText,
  type PromptTemplate,
  type Workflow,
  type WorkflowRun,
  type WorkflowStep,
  type WorkflowStore,
} from "../state/workflow-store.js";
import type { WebActivityActor, WebActivityEvent } from "../web/web-state.js";
import type { UnifiedJobDto, WorkflowPreviewDto } from "./relay-runtime-types.js";

export interface RelayWorkflowServiceOptions {
  store: WorkflowStore;
  getSession(deferThreadStart: boolean): Promise<AgentSessionService>;
  newSession(options?: {
    agentId?: AgentId;
    workspace?: string;
    model?: string;
    reasoningEffort?: string;
    launchProfileId?: string;
  }, actor?: WebActivityActor): Promise<unknown>;
  setAgent(agentId: AgentId, actor?: WebActivityActor): Promise<unknown>;
  attachSession(threadId: string, actor?: WebActivityActor): Promise<unknown>;
  runPrompt(session: AgentSessionService, envelope: PromptEnvelope): Promise<void>;
  isSessionBusy(session: AgentSessionService): boolean;
  abort(actor?: WebActivityActor): Promise<void>;
  appendActivity(input: Omit<WebActivityEvent, "id" | "timestamp"> & { timestamp?: string }): WebActivityEvent;
  appendAudit(input: Omit<AuditEvent, "id" | "timestamp" | "channelId">): AuditEvent;
  upsertJob(job: UnifiedJobDto): void;
  broadcastStatus(message: string, level?: "info" | "warn" | "error"): void;
}

const WORKFLOW_WAIT_MS = 1_000;

export class RelayWorkflowService {
  private readonly activeRuns = new Set<string>();

  constructor(private readonly options: RelayWorkflowServiceOptions) {}

  list(): { templates: PromptTemplate[]; workflows: Workflow[]; runs: WorkflowRun[] } {
    return {
      templates: this.options.store.listTemplates(),
      workflows: this.options.store.listWorkflows(),
      runs: this.options.store.listRuns(100),
    };
  }

  saveTemplate(input: Partial<PromptTemplate> & Pick<PromptTemplate, "name" | "prompt">, actor?: WebActivityActor): PromptTemplate {
    const template = this.options.store.saveTemplate({ ...input, ownerUserId: input.ownerUserId ?? actor?.id });
    this.record("workflow_template_saved", "info", template.name, actor);
    return template;
  }

  deleteTemplate(id: string, actor?: WebActivityActor): { removed: boolean } {
    const removed = this.options.store.deleteTemplate(id);
    this.record("workflow_template_deleted", removed ? "info" : "failed", id, actor);
    return { removed };
  }

  saveWorkflow(input: Partial<Workflow> & Pick<Workflow, "name" | "steps">, actor?: WebActivityActor): Workflow {
    const workflow = this.options.store.saveWorkflow({ ...input, ownerUserId: input.ownerUserId ?? actor?.id });
    this.record("workflow_saved", "info", workflow.name, actor);
    return workflow;
  }

  deleteWorkflow(id: string, actor?: WebActivityActor): { removed: boolean } {
    const removed = this.options.store.deleteWorkflow(id);
    this.record("workflow_deleted", removed ? "info" : "failed", id, actor);
    return { removed };
  }

  previewTemplate(id: string, variables: Record<string, string> = {}): WorkflowPreviewDto {
    const template = this.requireTemplate(id);
    return {
      templateId: template.id,
      name: template.name,
      prompts: [{
        stepId: template.id,
        name: template.name,
        prompt: renderPromptTemplate(template, variables),
      }],
    };
  }

  previewWorkflow(id: string, variables: Record<string, string> = {}): WorkflowPreviewDto {
    const workflow = this.requireWorkflow(id);
    return {
      workflowId: workflow.id,
      name: workflow.name,
      prompts: workflow.steps.map((step) => ({
        stepId: step.id,
        name: step.name,
        prompt: this.renderWorkflowStepPrompt(step, variables),
      })),
    };
  }

  async runTemplate(id: string, variables: Record<string, string> = {}, actor?: WebActivityActor): Promise<WorkflowRun> {
    const template = this.requireTemplate(id);
    const prompt = renderPromptTemplate(template, variables);
    const now = new Date().toISOString();
    const run: WorkflowRun = this.options.store.saveRun({
      id: createRunId(),
      templateId: template.id,
      name: template.name,
      status: "queued",
      ownerUserId: actor?.id,
      variables,
      steps: [{
        stepId: template.id,
        name: template.name,
        status: "pending",
        prompt,
      }],
      currentStepIndex: 0,
      createdAt: now,
      updatedAt: now,
    });
    this.upsertRunJob(run, actor);
    this.options.appendActivity({
      source: "web",
      status: "queued",
      type: "workflow_template_run_queued",
      threadId: null,
      actor,
      prompt,
      detail: template.name,
    });
    void this.executeTemplateRun(run.id, actor).catch((error) => {
      const latest = this.options.store.getRun(run.id) ?? run;
      this.failRun(latest, error, actor);
    });
    return run;
  }

  private async executeTemplateRun(id: string, actor?: WebActivityActor): Promise<void> {
    const initial = this.options.store.getRun(id);
    if (!initial?.templateId) return;
    const template = this.requireTemplate(initial.templateId);
    const correlationId = createCorrelationId();
    const prompt = renderPromptTemplate(template, initial.variables);
    const startedAt = new Date().toISOString();
    this.activeRuns.add(id);
    let run = this.options.store.patchRun(id, {
      status: "running",
      startedAt,
      steps: patchStep(initial.steps, template.id, {
        status: "running",
        prompt,
        correlationId,
        startedAt,
      }),
    }) ?? initial;
    this.upsertRunJob(run, actor);
    this.options.appendActivity({
      source: "web",
      status: "running",
      type: "workflow_template_run_started",
      threadId: null,
      actor,
      correlationId,
      prompt,
      detail: template.name,
    });
    try {
      await this.waitForIdle(id);
      const session = await this.options.getSession(false);
      await this.options.runPrompt(session, { ...toPromptEnvelope(prompt), correlationId, activityActor: actor });
      const finishedAt = new Date().toISOString();
      const latest = this.options.store.getRun(id) ?? run;
      const completed = this.options.store.patchRun(id, {
        status: "completed",
        finishedAt,
        currentStepIndex: 1,
        steps: patchStep(latest.steps, template.id, { status: "completed", finishedAt }),
      }) ?? latest;
      this.upsertRunJob(completed, actor);
    } catch (error) {
      const latest = this.options.store.getRun(id) ?? run;
      const errorText = error instanceof Error ? error.message : String(error);
      const failedAt = new Date().toISOString();
      const withFailedStep = this.options.store.patchRun(id, {
        steps: patchStep(latest.steps, template.id, { status: "failed", finishedAt: failedAt, error: errorText }),
      }) ?? latest;
      this.failRun(withFailedStep, error, actor);
    } finally {
      this.activeRuns.delete(id);
    }
  }

  runWorkflow(id: string, variables: Record<string, string> = {}, actor?: WebActivityActor): WorkflowRun {
    const workflow = this.requireWorkflow(id);
    if (workflow.steps.length === 0) {
      throw new Error("Workflow has no steps.");
    }
    const now = new Date().toISOString();
    const run = this.options.store.saveRun({
      id: createRunId(),
      workflowId: workflow.id,
      name: workflow.name,
      status: "queued",
      ownerUserId: actor?.id,
      variables,
      steps: workflow.steps.map((step) => ({
        stepId: step.id,
        name: step.name,
        status: "pending",
        prompt: this.renderWorkflowStepPrompt(step, variables),
      })),
      currentStepIndex: 0,
      createdAt: now,
      updatedAt: now,
    });
    this.upsertRunJob(run, actor);
    this.record("workflow_run_queued", "queued", workflow.name, actor);
    void this.executeWorkflowRun(run.id, actor).catch((error) => {
      const latest = this.options.store.getRun(run.id) ?? run;
      this.failRun(latest, error, actor);
    });
    return run;
  }

  async cancelRun(id: string, actor?: WebActivityActor): Promise<WorkflowRun | null> {
    const run = this.options.store.patchRun(id, {
      status: "aborted",
      finishedAt: new Date().toISOString(),
      error: "Cancelled by user.",
    });
    if (!run) return null;
    if (this.activeRuns.has(id)) {
      await this.options.abort(actor).catch(() => {});
    }
    this.upsertRunJob(run, actor);
    this.record("workflow_run_aborted", "aborted", run.name, actor);
    return run;
  }

  resumeRun(id: string, actor?: WebActivityActor): WorkflowRun | null {
    const run = this.options.store.getRun(id);
    if (!run?.workflowId) return null;
    if (run.status !== "paused") return run;
    const resumed = this.options.store.patchRun(id, {
      status: "queued",
      error: undefined,
      finishedAt: undefined,
    }) ?? run;
    this.upsertRunJob(resumed, actor);
    this.record("workflow_run_resumed", "queued", resumed.name, actor);
    void this.executeWorkflowRun(id, actor).catch((error) => {
      const latest = this.options.store.getRun(id) ?? resumed;
      this.failRun(latest, error, actor);
    });
    return resumed;
  }

  private async executeWorkflowRun(id: string, actor?: WebActivityActor): Promise<void> {
    const initial = this.options.store.getRun(id);
    if (!initial?.workflowId) return;
    const workflow = this.requireWorkflow(initial.workflowId);
    this.activeRuns.add(id);
    let run = this.options.store.patchRun(id, {
      status: "running",
      startedAt: new Date().toISOString(),
    }) ?? initial;
    this.upsertRunJob(run, actor);
    this.record("workflow_run_started", "running", run.name, actor);

    try {
      for (let index = run.currentStepIndex; index < workflow.steps.length; index += 1) {
        run = this.options.store.getRun(id) ?? run;
        if (run.status === "aborted") return;
        const step = workflow.steps[index]!;
        if (step.requiresApproval) {
          run = this.options.store.patchRun(id, { status: "paused", currentStepIndex: index }) ?? run;
          this.upsertRunJob(run, actor);
          this.options.broadcastStatus(`Workflow ${run.name} paused before ${step.name}.`, "info");
          return;
        }
        await this.runStep(id, workflow, step, index, actor);
      }
      const completed = this.options.store.patchRun(id, {
        status: "completed",
        finishedAt: new Date().toISOString(),
        currentStepIndex: workflow.steps.length,
      });
      if (completed) {
        this.upsertRunJob(completed, actor);
        this.record("workflow_run_completed", "completed", completed.name, actor);
      }
    } finally {
      this.activeRuns.delete(id);
    }
  }

  private async runStep(id: string, workflow: Workflow, step: WorkflowStep, index: number, actor?: WebActivityActor): Promise<void> {
    let run = this.options.store.getRun(id);
    if (!run) return;
    const correlationId = createCorrelationId();
    const prompt = this.renderWorkflowStepPrompt(step, run.variables);
    const startedAt = new Date().toISOString();
    run = this.options.store.patchRun(id, {
      currentStepIndex: index,
      steps: patchStep(run.steps, step.id, {
        status: "running",
        prompt,
        correlationId,
        startedAt,
        error: undefined,
      }),
    }) ?? run;
    this.upsertRunJob(run, actor);

    try {
      await this.prepareStepSession(step, actor);
      await this.waitForIdle(id);
      const session = await this.options.getSession(false);
      await this.options.runPrompt(session, { ...toPromptEnvelope(prompt), correlationId, activityActor: actor });
      const latest = this.options.store.getRun(id) ?? run;
      const finishedAt = new Date().toISOString();
      const next = this.options.store.patchRun(id, {
        steps: patchStep(latest.steps, step.id, { status: "completed", finishedAt }),
      });
      if (next) this.upsertRunJob(next, actor);
    } catch (error) {
      const latest = this.options.store.getRun(id) ?? run;
      const errorText = error instanceof Error ? error.message : String(error);
      const next = this.options.store.patchRun(id, {
        status: step.continueOnError ? "running" : "failed",
        error: step.continueOnError ? undefined : errorText,
        finishedAt: step.continueOnError ? undefined : new Date().toISOString(),
        steps: patchStep(latest.steps, step.id, { status: "failed", finishedAt: new Date().toISOString(), error: errorText }),
      });
      if (next) this.upsertRunJob(next, actor);
      this.options.appendActivity({
        source: "web",
        status: "failed",
        type: "workflow_step_failed",
        threadId: null,
        actor,
        correlationId,
        prompt,
        detail: `${workflow.name} / ${step.name}: ${errorText}`,
      });
      if (!step.continueOnError) throw error;
    }
  }

  private async prepareStepSession(step: WorkflowStep, actor?: WebActivityActor): Promise<void> {
    if (step.target !== "local") {
      throw new Error("Per-step peer targets are stored but not executable from a local workflow run yet. Select the peer target in the WebUI and run the workflow there.");
    }
    if (step.sessionMode === "attach") {
      if (!step.threadId) throw new Error(`Workflow step ${step.name} needs a thread id.`);
      if (step.agentId) await this.options.setAgent(step.agentId, actor);
      await this.options.attachSession(step.threadId, actor);
      return;
    }
    if (step.sessionMode === "new") {
      await this.options.newSession({
        agentId: step.agentId,
        workspace: step.workspace,
        model: step.model,
        reasoningEffort: step.reasoningEffort,
        launchProfileId: step.launchProfileId,
      }, actor);
      return;
    }
    if (step.agentId) {
      await this.options.setAgent(step.agentId, actor);
    }
  }

  private async waitForIdle(runId: string): Promise<void> {
    for (;;) {
      const run = this.options.store.getRun(runId);
      if (run?.status === "aborted") {
        throw new Error("Workflow run was cancelled.");
      }
      const session = await this.options.getSession(false);
      if (!this.options.isSessionBusy(session)) return;
      await new Promise((resolve) => setTimeout(resolve, WORKFLOW_WAIT_MS));
    }
  }

  private renderWorkflowStepPrompt(step: WorkflowStep, variables: Record<string, string>): string {
    if (step.templateId) {
      return renderPromptTemplate(this.requireTemplate(step.templateId), variables);
    }
    const prompt = renderTemplateText(step.prompt ?? "", variables).trim();
    if (!prompt) {
      throw new Error(`Workflow step ${step.name} has no prompt.`);
    }
    return prompt;
  }

  private requireTemplate(id: string): PromptTemplate {
    const template = this.options.store.getTemplate(id);
    if (!template) throw new Error(`Template not found: ${id}`);
    return template;
  }

  private requireWorkflow(id: string): Workflow {
    const workflow = this.options.store.getWorkflow(id);
    if (!workflow) throw new Error(`Workflow not found: ${id}`);
    return workflow;
  }

  private failRun(run: WorkflowRun, error: unknown, actor?: WebActivityActor): WorkflowRun {
    const errorText = error instanceof Error ? error.message : String(error);
    const failed = this.options.store.patchRun(run.id, {
      status: "failed",
      error: errorText,
      finishedAt: new Date().toISOString(),
    }) ?? run;
    this.upsertRunJob(failed, actor);
    this.record("workflow_run_failed", "failed", `${run.name}: ${errorText}`, actor);
    return failed;
  }

  private upsertRunJob(run: WorkflowRun, actor?: WebActivityActor): void {
    this.options.upsertJob({
      id: `workflow-run:${run.id}`,
      kind: "workflow-run",
      title: run.name,
      status: run.status === "paused" ? "queued" : run.status,
      source: "web",
      threadId: null,
      owner: actor,
      startedAt: run.startedAt ?? run.createdAt,
      updatedAt: run.updatedAt,
      finishedAt: run.finishedAt,
      summary: run.error ?? `${run.steps.filter((step) => step.status === "completed").length}/${run.steps.length} steps completed`,
      correlationId: run.steps.find((step) => step.correlationId)?.correlationId,
      canCancel: run.status === "queued" || run.status === "running" || run.status === "paused",
      canRetry: run.status === "paused" || run.status === "failed" || run.status === "aborted",
      canReadLog: true,
    });
  }

  private record(type: string, status: WebActivityEvent["status"], detail: string, actor?: WebActivityActor): void {
    this.options.appendActivity({
      source: "web",
      status,
      type,
      threadId: null,
      actor,
      detail,
    });
    this.options.appendAudit({
      action: "command",
      status: status === "failed" ? "failed" : "ok",
      contextKey: "web:dashboard",
      actor,
      description: `${type}: ${detail}`,
    });
  }
}

export function renderPromptTemplate(template: PromptTemplate, variables: Record<string, string>): string {
  const merged = Object.fromEntries(template.variables.map((variable) => [variable.name, variable.defaultValue ?? ""]));
  return renderTemplateText(template.prompt, { ...merged, ...variables }).trim();
}

function patchStep<T extends { stepId: string }>(steps: T[], stepId: string, patch: Partial<T>): T[] {
  return steps.map((step) => step.stepId === stepId ? { ...step, ...patch } : step);
}

function createRunId(): string {
  return `run_${createCorrelationId()}`;
}
