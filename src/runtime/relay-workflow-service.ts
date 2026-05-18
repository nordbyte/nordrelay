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
  type WorkflowStepAttempt,
  type WorkflowStepRun,
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
    workspaceMode?: "shared" | "worktree" | "attached";
    model?: string;
    reasoningEffort?: string;
    launchProfileId?: string;
  }, actor?: WebActivityActor): Promise<unknown>;
  setAgent(agentId: AgentId, actor?: WebActivityActor): Promise<unknown>;
  attachSession(threadId: string, actor?: WebActivityActor): Promise<unknown>;
  runPrompt(session: AgentSessionService, envelope: PromptEnvelope): Promise<void>;
  runPeerPromptStep?(peerId: string, step: WorkflowStep, prompt: string, correlationId: string, actor?: WebActivityActor): Promise<{ status: string; detail?: string }>;
  isSessionBusy(session: AgentSessionService): boolean;
  abort(actor?: WebActivityActor): Promise<void>;
  appendActivity(input: Omit<WebActivityEvent, "id" | "timestamp"> & { timestamp?: string }): WebActivityEvent;
  appendAudit(input: Omit<AuditEvent, "id" | "timestamp" | "channelId">): AuditEvent;
  upsertJob(job: UnifiedJobDto): void;
  broadcastStatus(message: string, level?: "info" | "warn" | "error"): void;
}

const WORKFLOW_WAIT_MS = 1_000;
const WORKFLOW_SCHEDULE_POLL_MS = 30_000;
const MAX_SUBFLOW_DEPTH = 5;

export class RelayWorkflowService {
  private readonly activeRuns = new Set<string>();
  private readonly scheduleTimer: NodeJS.Timeout;

  constructor(private readonly options: RelayWorkflowServiceOptions) {
    this.scheduleTimer = setInterval(() => this.runDueSchedules(), WORKFLOW_SCHEDULE_POLL_MS);
    this.scheduleTimer.unref?.();
  }

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
        target: "local",
        sessionMode: "current",
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
      steps: workflow.steps.map((step) => this.initialStepRun(step, variables)),
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
    const currentStep = run.steps[run.currentStepIndex];
    const resumed = this.options.store.patchRun(id, {
      status: "queued",
      error: undefined,
      finishedAt: undefined,
      steps: currentStep ? patchStep(run.steps, currentStep.stepId, { approvedAt: new Date().toISOString() }) : run.steps,
    }) ?? run;
    this.upsertRunJob(resumed, actor);
    this.record("workflow_run_resumed", "queued", resumed.name, actor);
    void this.executeWorkflowRun(id, actor).catch((error) => {
      const latest = this.options.store.getRun(id) ?? resumed;
      this.failRun(latest, error, actor);
    });
    return resumed;
  }

  private async executeWorkflowRun(id: string, actor?: WebActivityActor, depth = 0): Promise<void> {
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
        const stepRun = run.steps.find((candidate) => candidate.stepId === step.id);
        if (!conditionMatches(step, run.variables)) {
          const finishedAt = new Date().toISOString();
          run = this.options.store.patchRun(id, {
            currentStepIndex: index + 1,
            steps: patchStep(run.steps, step.id, { status: "skipped", skippedReason: conditionDetail(step), finishedAt }),
          }) ?? run;
          this.upsertRunJob(run, actor);
          continue;
        }
        if (step.requiresApproval && !stepRun?.approvedAt) {
          run = this.options.store.patchRun(id, { status: "paused", currentStepIndex: index }) ?? run;
          this.upsertRunJob(run, actor);
          this.options.broadcastStatus(`Workflow ${run.name} paused before ${step.name}.`, "info");
          return;
        }
        await this.runStepWithRetry(id, workflow, step, index, actor, depth);
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

  private async runStepWithRetry(id: string, workflow: Workflow, step: WorkflowStep, index: number, actor: WebActivityActor | undefined, depth: number): Promise<void> {
    const policy = step.retryPolicy ?? { maxAttempts: 1, delayMs: 0 };
    let lastError: unknown;
    for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
      try {
        await this.runStep(id, workflow, step, index, actor, attempt, depth);
        return;
      } catch (error) {
        lastError = error;
        if (attempt >= policy.maxAttempts || step.continueOnError) throw error;
        await new Promise((resolve) => setTimeout(resolve, policy.delayMs));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async runStep(id: string, workflow: Workflow, step: WorkflowStep, index: number, actor: WebActivityActor | undefined, attempt: number, depth: number): Promise<void> {
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
        attempts: attempt,
        ...stepRunMetadata(step),
        attemptHistory: appendAttemptHistory(run.steps.find((candidate) => candidate.stepId === step.id)?.attemptHistory, {
          attempt,
          status: "running",
          startedAt,
          correlationId,
        }),
      }),
    }) ?? run;
    this.upsertRunJob(run, actor);

    try {
      if (step.type === "workflow") {
        await this.runSubflow(id, step, run.variables, actor, depth);
      } else if (step.target !== "local") {
        await this.runPeerStep(step, prompt, correlationId, actor);
      } else {
        await this.prepareStepSession(step, actor);
        await this.waitForIdle(id);
        const session = await this.options.getSession(false);
        await this.options.runPrompt(session, { ...toPromptEnvelope(prompt), correlationId, activityActor: actor });
      }
      const latest = this.options.store.getRun(id) ?? run;
      const finishedAt = new Date().toISOString();
      const next = this.options.store.patchRun(id, {
        steps: patchStep(latest.steps, step.id, {
          status: "completed",
          finishedAt,
          attemptHistory: finishAttemptHistory(latest.steps.find((candidate) => candidate.stepId === step.id)?.attemptHistory, attempt, "completed", finishedAt),
        }),
      });
      if (next) this.upsertRunJob(next, actor);
    } catch (error) {
      const latest = this.options.store.getRun(id) ?? run;
      const errorText = error instanceof Error ? error.message : String(error);
      const finishedAt = new Date().toISOString();
      const next = this.options.store.patchRun(id, {
        status: step.continueOnError ? "running" : "failed",
        error: step.continueOnError ? undefined : errorText,
        finishedAt: step.continueOnError ? undefined : finishedAt,
        steps: patchStep(latest.steps, step.id, {
          status: "failed",
          finishedAt,
          error: errorText,
          attemptHistory: finishAttemptHistory(latest.steps.find((candidate) => candidate.stepId === step.id)?.attemptHistory, attempt, "failed", finishedAt, errorText),
        }),
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
        workspaceMode: step.workspaceMode,
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

  private async runPeerStep(step: WorkflowStep, prompt: string, correlationId: string, actor?: WebActivityActor): Promise<void> {
    const peerId = peerIdFromWorkflowTarget(step.target);
    if (!peerId) {
      throw new Error(`Unsupported workflow target: ${step.target}`);
    }
    if (!this.options.runPeerPromptStep) {
      throw new Error("Peer workflow execution is not available in this runtime.");
    }
    const result = await this.options.runPeerPromptStep(peerId, step, prompt, correlationId, actor);
    this.options.appendActivity({
      source: "web",
      status: result.status === "completed" ? "completed" : "info",
      type: "workflow_peer_step_completed",
      threadId: null,
      actor,
      correlationId,
      prompt,
      detail: result.detail ?? `Peer ${peerId} finished workflow step ${step.name}.`,
    });
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
    if (step.type === "workflow") {
      const workflow = step.workflowId ? this.requireWorkflow(step.workflowId) : null;
      if (!workflow) throw new Error(`Workflow step ${step.name} has no subflow.`);
      return `Run subflow: ${workflow.name}`;
    }
    if (step.templateId) {
      return renderPromptTemplate(this.requireTemplate(step.templateId), variables);
    }
    const prompt = renderTemplateText(step.prompt ?? "", variables).trim();
    if (!prompt) {
      throw new Error(`Workflow step ${step.name} has no prompt.`);
    }
    return prompt;
  }

  private async runSubflow(parentRunId: string, step: WorkflowStep, variables: Record<string, string>, actor: WebActivityActor | undefined, depth: number): Promise<void> {
    if (depth >= MAX_SUBFLOW_DEPTH) throw new Error("Workflow subflow depth limit reached.");
    if (!step.workflowId) throw new Error(`Workflow step ${step.name} has no subflow.`);
    const workflow = this.requireWorkflow(step.workflowId);
    const now = new Date().toISOString();
    const run = this.options.store.saveRun({
      id: createRunId(),
      workflowId: workflow.id,
      name: `${workflow.name} (subflow)`,
      status: "queued",
      ownerUserId: actor?.id,
      variables,
      steps: workflow.steps.map((subStep) => ({
        stepId: subStep.id,
        name: subStep.name,
        status: "pending",
        prompt: this.renderWorkflowStepPrompt(subStep, variables),
        ...stepRunMetadata(subStep),
      })),
      currentStepIndex: 0,
      createdAt: now,
      updatedAt: now,
    });
    this.record("workflow_subflow_queued", "queued", `${parentRunId}: ${workflow.name}`, actor);
    await this.executeWorkflowRun(run.id, actor, depth + 1);
    const finished = this.options.store.getRun(run.id);
    if (!finished || finished.status !== "completed") {
      throw new Error(`Subflow ${workflow.name} finished with status ${finished?.status ?? "unknown"}.`);
    }
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

  private initialStepRun(step: WorkflowStep, variables: Record<string, string>): WorkflowStepRun {
    return {
      stepId: step.id,
      name: step.name,
      status: "pending",
      prompt: this.renderWorkflowStepPrompt(step, variables),
      ...stepRunMetadata(step),
    };
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

  private runDueSchedules(): void {
    const now = Date.now();
    for (const workflow of this.options.store.listWorkflows()) {
      const schedule = workflow.schedule;
      if (!schedule?.enabled || !schedule.nextRunAt || Date.parse(schedule.nextRunAt) > now) continue;
      if (this.activeRuns.has(`scheduled:${workflow.id}`)) continue;
      const nextSchedule = nextWorkflowSchedule(schedule, now);
      this.options.store.saveWorkflow({ ...workflow, schedule: nextSchedule });
      const scheduledActor: WebActivityActor = { channel: "system", id: "workflow-scheduler", label: "Workflow scheduler" };
      this.runWorkflow(workflow.id, {}, scheduledActor);
    }
  }
}

export function renderPromptTemplate(template: PromptTemplate, variables: Record<string, string>): string {
  const merged = Object.fromEntries(template.variables.map((variable) => [variable.name, variable.defaultValue ?? ""]));
  return renderTemplateText(template.prompt, { ...merged, ...variables }).trim();
}

function patchStep<T extends { stepId: string }>(steps: T[], stepId: string, patch: Partial<T>): T[] {
  return steps.map((step) => step.stepId === stepId ? { ...step, ...patch } : step);
}

function stepRunMetadata(step: WorkflowStep): Partial<WorkflowStepRun> {
  return {
    target: step.target,
    sessionMode: step.sessionMode,
    agentId: step.agentId,
    workspace: step.workspace,
    workspaceMode: step.workspaceMode,
    model: step.model,
    reasoningEffort: step.reasoningEffort,
    launchProfileId: step.launchProfileId,
    requiresApproval: step.requiresApproval,
    continueOnError: step.continueOnError,
    retryPolicy: step.retryPolicy,
  };
}

function appendAttemptHistory(existing: WorkflowStepAttempt[] | undefined, attempt: WorkflowStepAttempt): WorkflowStepAttempt[] {
  return [...(existing ?? []).filter((item) => item.attempt !== attempt.attempt), attempt].slice(-20);
}

function finishAttemptHistory(
  existing: WorkflowStepAttempt[] | undefined,
  attempt: number,
  status: "completed" | "failed",
  finishedAt: string,
  error?: string,
): WorkflowStepAttempt[] {
  const history = existing?.length ? existing : [{ attempt, status: "running" as const, startedAt: finishedAt }];
  return history.map((item) => item.attempt === attempt ? { ...item, status, finishedAt, error } : item).slice(-20);
}

function conditionDetail(step: WorkflowStep): string {
  const condition = step.condition;
  if (!condition) return "Condition did not match.";
  return `Condition did not match: ${condition.variable} ${condition.operator}${condition.value ? ` ${condition.value}` : ""}.`;
}

function createRunId(): string {
  return `run_${createCorrelationId()}`;
}

function conditionMatches(step: WorkflowStep, variables: Record<string, string>): boolean {
  const condition = step.condition;
  if (!condition) return true;
  const value = variables[condition.variable] ?? "";
  const expected = condition.value ?? "";
  if (condition.operator === "exists") return value.trim().length > 0;
  if (condition.operator === "equals") return value === expected;
  if (condition.operator === "not_equals") return value !== expected;
  if (condition.operator === "contains") return value.includes(expected);
  if (condition.operator === "not_contains") return !value.includes(expected);
  return true;
}

function nextWorkflowSchedule(schedule: NonNullable<Workflow["schedule"]>, now: number): NonNullable<Workflow["schedule"]> {
  const lastRunAt = new Date(now).toISOString();
  const intervalMs = (schedule.intervalMinutes ?? 0) * 60 * 1000;
  return {
    ...schedule,
    lastRunAt,
    nextRunAt: intervalMs > 0 ? new Date(now + intervalMs).toISOString() : undefined,
    enabled: intervalMs > 0 ? schedule.enabled : false,
  };
}

function peerIdFromWorkflowTarget(target: WorkflowStep["target"]): string | null {
  return target.startsWith("peer:") ? target.slice("peer:".length).trim() || null : null;
}
