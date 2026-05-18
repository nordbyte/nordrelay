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
  type WorkflowVersionDiff,
  type WorkflowVersionKind,
  type WorkflowVersionRecord,
  type WorkflowExportBundle,
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
    const recoveryTimer = setTimeout(() => this.recoverInterruptedRuns(), 250);
    recoveryTimer.unref?.();
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
    const workflow = this.options.store.saveWorkflow({ ...input, schedule: prepareWorkflowSchedule(input.schedule), ownerUserId: input.ownerUserId ?? actor?.id });
    this.record("workflow_saved", "info", workflow.name, actor);
    return workflow;
  }

  deleteWorkflow(id: string, actor?: WebActivityActor): { removed: boolean } {
    const removed = this.options.store.deleteWorkflow(id);
    this.record("workflow_deleted", removed ? "info" : "failed", id, actor);
    return { removed };
  }

  listTemplateVersions(id: string): WorkflowVersionRecord[] {
    return this.options.store.listVersions("template", id);
  }

  listWorkflowVersions(id: string): WorkflowVersionRecord[] {
    return this.options.store.listVersions("workflow", id);
  }

  diffTemplateVersions(id: string, fromVersion?: number, toVersion?: number): WorkflowVersionDiff {
    return this.options.store.diffVersions("template", id, fromVersion, toVersion);
  }

  diffWorkflowVersions(id: string, fromVersion?: number, toVersion?: number): WorkflowVersionDiff {
    return this.options.store.diffVersions("workflow", id, fromVersion, toVersion);
  }

  restoreTemplateVersion(id: string, version: number, actor?: WebActivityActor): PromptTemplate {
    const restored = this.options.store.restoreVersion("template", id, version, actor?.id);
    if (!restored) throw new Error(`Template version not found: ${id} v${version}`);
    this.record("workflow_template_version_restored", "info", `${restored.name} v${version}`, actor);
    return restored as PromptTemplate;
  }

  restoreWorkflowVersion(id: string, version: number, actor?: WebActivityActor): Workflow {
    const restored = this.options.store.restoreVersion("workflow", id, version, actor?.id);
    if (!restored) throw new Error(`Workflow version not found: ${id} v${version}`);
    this.record("workflow_version_restored", "info", `${restored.name} v${version}`, actor);
    return restored as Workflow;
  }

  exportTemplate(id: string, version?: number): WorkflowExportBundle {
    const bundle = this.options.store.exportTemplate(id, version);
    if (!bundle) throw new Error(`Template not found: ${id}`);
    return bundle;
  }

  exportWorkflow(id: string, version?: number): WorkflowExportBundle {
    const bundle = this.options.store.exportWorkflow(id, version);
    if (!bundle) throw new Error(`Workflow not found: ${id}`);
    return bundle;
  }

  importTemplate(input: unknown, actor?: WebActivityActor): PromptTemplate {
    const template = this.options.store.importTemplate(input, actor?.id);
    this.record("workflow_template_imported", "info", template.name, actor);
    return template;
  }

  importWorkflow(input: unknown, actor?: WebActivityActor): Workflow {
    const workflow = this.options.store.importWorkflow(input, actor?.id);
    this.record("workflow_imported", "info", workflow.name, actor);
    return workflow;
  }

  previewTemplateVersion(id: string, version: number, variables: Record<string, string> = {}): WorkflowPreviewDto {
    const record = this.requireVersion("template", id, version);
    const template = record.snapshot as PromptTemplate;
    return {
      templateId: template.id,
      name: `${template.name} v${record.version}`,
      prompts: [{
        stepId: template.id,
        name: template.name,
        prompt: renderPromptTemplate(template, variables),
      }],
    };
  }

  previewWorkflowVersion(id: string, version: number, variables: Record<string, string> = {}): WorkflowPreviewDto {
    const record = this.requireVersion("workflow", id, version);
    const workflow = record.snapshot as Workflow;
    return {
      workflowId: workflow.id,
      name: `${workflow.name} v${record.version}`,
      prompts: workflow.steps.map((step) => ({
        stepId: step.id,
        name: step.name,
        prompt: this.renderWorkflowStepPrompt(step, variables),
      })),
    };
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
    const version = this.options.store.latestVersion("template", id);
    return this.queueTemplateRun(template, variables, actor, version?.version, version?.snapshot as PromptTemplate | undefined);
  }

  async runTemplateVersion(id: string, versionNumber: number, variables: Record<string, string> = {}, actor?: WebActivityActor): Promise<WorkflowRun> {
    const version = this.requireVersion("template", id, versionNumber);
    return this.queueTemplateRun(version.snapshot as PromptTemplate, variables, actor, version.version, version.snapshot as PromptTemplate);
  }

  private async queueTemplateRun(
    template: PromptTemplate,
    variables: Record<string, string>,
    actor: WebActivityActor | undefined,
    templateVersion?: number,
    templateSnapshot?: PromptTemplate,
  ): Promise<WorkflowRun> {
    const prompt = renderPromptTemplate(template, variables);
    const now = new Date().toISOString();
    const run: WorkflowRun = this.options.store.saveRun({
      id: createRunId(),
      templateId: template.id,
      templateVersion,
      templateSnapshot,
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
    const template = initial.templateSnapshot ?? this.requireTemplate(initial.templateId);
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
    const version = this.options.store.latestVersion("workflow", id);
    return this.queueWorkflowRun(workflow, variables, actor, version?.version, version?.snapshot as Workflow | undefined);
  }

  runWorkflowVersion(id: string, versionNumber: number, variables: Record<string, string> = {}, actor?: WebActivityActor): WorkflowRun {
    const version = this.requireVersion("workflow", id, versionNumber);
    return this.queueWorkflowRun(version.snapshot as Workflow, variables, actor, version.version, version.snapshot as Workflow);
  }

  private queueWorkflowRun(
    workflow: Workflow,
    variables: Record<string, string>,
    actor: WebActivityActor | undefined,
    workflowVersion?: number,
    workflowSnapshot?: Workflow,
  ): WorkflowRun {
    if (workflow.steps.length === 0) {
      throw new Error("Workflow has no steps.");
    }
    const now = new Date().toISOString();
    const run = this.options.store.saveRun({
      id: createRunId(),
      workflowId: workflow.id,
      workflowVersion,
      workflowSnapshot,
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

  rerunFromFailedStep(id: string, actor?: WebActivityActor): WorkflowRun | null {
    const run = this.options.store.getRun(id);
    if (!run) return null;
    const failedIndex = run.steps.findIndex((step) => step.status === "failed");
    const startIndex = failedIndex >= 0 ? failedIndex : Math.min(run.currentStepIndex, Math.max(0, run.steps.length - 1));
    const resetSteps = run.steps.map((step, index) => index < startIndex ? step : {
      ...step,
      status: "pending" as const,
      startedAt: undefined,
      finishedAt: undefined,
      error: undefined,
      correlationId: undefined,
      approvedAt: step.requiresApproval ? step.approvedAt : undefined,
    });
    const patched = this.options.store.patchRun(id, {
      status: "queued",
      error: undefined,
      finishedAt: undefined,
      currentStepIndex: startIndex,
      steps: resetSteps,
    }) ?? run;
    this.upsertRunJob(patched, actor);
    this.record("workflow_run_rerun_from_failed_step", "queued", `${patched.name} from step ${startIndex + 1}`, actor);
    if (patched.workflowId) {
      void this.executeWorkflowRun(id, actor).catch((error) => {
        const latest = this.options.store.getRun(id) ?? patched;
        this.failRun(latest, error, actor);
      });
    } else if (patched.templateId) {
      void this.executeTemplateRun(id, actor).catch((error) => {
        const latest = this.options.store.getRun(id) ?? patched;
        this.failRun(latest, error, actor);
      });
    }
    return patched;
  }

  private async executeWorkflowRun(id: string, actor?: WebActivityActor, depth = 0): Promise<void> {
    const initial = this.options.store.getRun(id);
    if (!initial?.workflowId) return;
    const workflow = initial.workflowSnapshot ?? this.requireWorkflow(initial.workflowId);
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
          this.record("workflow_run_paused_for_approval", "queued", `${run.name} before ${step.name}`, actor);
          this.options.broadcastStatus(`Workflow ${run.name} paused before ${step.name}. Approval is required.`, "warn");
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
    const existingStep = run.steps.find((candidate) => candidate.stepId === step.id);
    const prompt = existingStep?.prompt || this.renderWorkflowStepPrompt(step, run.variables);
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
    const version = this.options.store.latestVersion("workflow", workflow.id);
    const now = new Date().toISOString();
    const run = this.options.store.saveRun({
      id: createRunId(),
      workflowId: workflow.id,
      workflowVersion: version?.version,
      workflowSnapshot: version?.snapshot as Workflow | undefined,
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

  private requireVersion(kind: WorkflowVersionKind, id: string, version: number): WorkflowVersionRecord {
    const record = this.options.store.getVersion(kind, id, version);
    if (!record) throw new Error(`${kind === "template" ? "Template" : "Workflow"} version not found: ${id} v${version}`);
    return record;
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
      if (schedule?.enabled && !schedule.nextRunAt && schedule.cron) {
        this.options.store.saveWorkflow({ ...workflow, schedule: prepareWorkflowSchedule(schedule) });
        continue;
      }
      if (!schedule?.enabled || !schedule.nextRunAt || Date.parse(schedule.nextRunAt) > now) continue;
      if (this.activeRuns.has(`scheduled:${workflow.id}`)) continue;
      const nextSchedule = nextWorkflowSchedule(schedule, now);
      this.options.store.saveWorkflow({ ...workflow, schedule: nextSchedule });
      const scheduledActor: WebActivityActor = { channel: "system", id: "workflow-scheduler", label: "Workflow scheduler" };
      this.runWorkflow(workflow.id, {}, scheduledActor);
    }
  }

  private recoverInterruptedRuns(): void {
    const actor: WebActivityActor = { channel: "system", id: "workflow-recovery", label: "Workflow recovery" };
    for (const run of this.options.store.listRuns(500)) {
      if (this.activeRuns.has(run.id)) continue;
      if (run.status !== "queued" && run.status !== "running") continue;
      const patched = this.options.store.patchRun(run.id, {
        status: "queued",
        error: undefined,
        finishedAt: undefined,
      }) ?? run;
      this.upsertRunJob(patched, actor);
      this.record("workflow_run_recovered", "queued", patched.name, actor);
      if (patched.workflowId) {
        void this.executeWorkflowRun(patched.id, actor).catch((error) => {
          const latest = this.options.store.getRun(patched.id) ?? patched;
          this.failRun(latest, error, actor);
        });
      } else if (patched.templateId) {
        void this.executeTemplateRun(patched.id, actor).catch((error) => {
          const latest = this.options.store.getRun(patched.id) ?? patched;
          this.failRun(latest, error, actor);
        });
      }
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
  if (schedule.cron) {
    const next = nextCronDate(schedule.cron, schedule.timezone, new Date(now + 60_000));
    return {
      ...schedule,
      lastRunAt,
      nextRunAt: next?.toISOString(),
      enabled: Boolean(next),
    };
  }
  const intervalMs = (schedule.intervalMinutes ?? 0) * 60 * 1000;
  return {
    ...schedule,
    lastRunAt,
    nextRunAt: intervalMs > 0 ? new Date(now + intervalMs).toISOString() : undefined,
    enabled: intervalMs > 0 ? schedule.enabled : false,
  };
}

function prepareWorkflowSchedule(schedule: Workflow["schedule"]): Workflow["schedule"] {
  if (!schedule?.enabled || schedule.nextRunAt || !schedule.cron) return schedule;
  const next = nextCronDate(schedule.cron, schedule.timezone, new Date(Date.now() + 60_000));
  return {
    ...schedule,
    nextRunAt: next?.toISOString(),
    enabled: Boolean(next),
  };
}

function nextCronDate(expression: string, timezone: string | undefined, from: Date): Date | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const fields = [
    parseCronField(parts[0]!, 0, 59),
    parseCronField(parts[1]!, 0, 23),
    parseCronField(parts[2]!, 1, 31),
    parseCronField(parts[3]!, 1, 12),
    parseCronField(parts[4]!, 0, 6),
  ];
  if (fields.some((field) => !field)) return null;
  const tz = timezone?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const cursor = new Date(from);
  cursor.setSeconds(0, 0);
  const deadline = cursor.getTime() + 366 * 24 * 60 * 60 * 1000;
  while (cursor.getTime() <= deadline) {
    const parts = datePartsInTimezone(cursor, tz);
    if (
      fields[0]!.has(parts.minute) &&
      fields[1]!.has(parts.hour) &&
      fields[2]!.has(parts.day) &&
      fields[3]!.has(parts.month) &&
      fields[4]!.has(parts.weekday)
    ) {
      return cursor;
    }
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return null;
}

function parseCronField(field: string, min: number, max: number): Set<number> | null {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const [rangePart = "", stepPart] = part.split("/");
    const step = stepPart ? Math.max(1, Number(stepPart)) : 1;
    if (!Number.isFinite(step)) return null;
    const range = rangePart === "*" ? [min, max] : rangePart.includes("-") ? rangePart.split("-").map(Number) : [Number(rangePart), Number(rangePart)];
    const [start, end] = range;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) return null;
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values;
}

function datePartsInTimezone(date: Date, timezone: string): { minute: number; hour: number; day: number; month: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    minute: "numeric",
    hour: "numeric",
    day: "numeric",
    month: "numeric",
    weekday: "short",
    hour12: false,
  }).formatToParts(date);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const weekdayText = parts.find((part) => part.type === "weekday")?.value ?? "Sun";
  return {
    minute: value("minute"),
    hour: value("hour") % 24,
    day: value("day"),
    month: value("month"),
    weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekdayText.slice(0, 3)),
  };
}

function peerIdFromWorkflowTarget(target: WorkflowStep["target"]): string | null {
  return target.startsWith("peer:") ? target.slice("peer:".length).trim() || null : null;
}
