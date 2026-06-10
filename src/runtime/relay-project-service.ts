import type { AuditEvent } from "../access/audit-log.js";
import type { AgentId, AgentSessionInfo, AgentSessionService } from "../agents/shared/agent.js";
import { createCorrelationId, toPromptEnvelope, type PromptEnvelope } from "../state/prompt-store.js";
import {
  normalizeProjectPlanHorizon,
  normalizeProjectPlanMode,
  normalizeProjectPlanRiskLevel,
  type ProjectAnalysisJob,
  type ProjectJobKind,
  type ProjectJobStatus,
  type ProjectPlanExistenceCheck,
  type ProjectPlanHorizon,
  type ProjectPlanItem,
  type ProjectPlanMode,
  type ProjectPlanRiskLevel,
  type ProjectRecord,
  type ProjectSessionLink,
  type ProjectStore,
} from "../state/project-store.js";
import type { WebActivityActor, WebActivityEvent, WebChatMessage } from "../web/web-state.js";
import type { UnifiedJobDto } from "./relay-runtime-types.js";

export interface RelayProjectServiceOptions {
  store: ProjectStore;
  getSession(deferThreadStart: boolean): Promise<AgentSessionService>;
  newSession(options?: {
    agentId?: AgentId;
    workspace?: string;
    workspaceMode?: "shared" | "worktree" | "attached";
    model?: string;
    reasoningEffort?: string;
    launchProfileId?: string;
    fastMode?: boolean;
  }, actor?: WebActivityActor): Promise<AgentSessionInfo>;
  runPrompt(session: AgentSessionService, envelope: PromptEnvelope): Promise<void>;
  chatMessagesByCorrelation(correlationId: string, limit?: number): WebChatMessage[];
  appendActivity(input: Omit<WebActivityEvent, "id" | "timestamp"> & { timestamp?: string }): WebActivityEvent;
  appendAudit(input: Omit<AuditEvent, "id" | "timestamp" | "channelId">): AuditEvent;
  upsertJob(job: UnifiedJobDto): void;
  broadcastStatus(message: string, level?: "info" | "warn" | "error"): void;
  abort(actor?: WebActivityActor): Promise<void>;
}

export interface ProjectListDto {
  projects: ProjectRecord[];
  jobs: ProjectAnalysisJob[];
  updatedAt: string;
}

export interface ProjectRunOptions {
  agentId?: AgentId;
  instructions?: string;
  planMode?: ProjectPlanMode;
  planningHorizon?: ProjectPlanHorizon;
  riskLevel?: ProjectPlanRiskLevel;
}

const DEFAULT_PROJECT_AGENT: AgentId = "codex";

export class RelayProjectService {
  private readonly activeJobs = new Set<string>();

  constructor(private readonly options: RelayProjectServiceOptions) {}

  list(): ProjectListDto {
    return {
      projects: this.options.store.list(),
      jobs: this.options.store.listJobs(undefined, 100),
      updatedAt: new Date().toISOString(),
    };
  }

  get(id: string): ProjectRecord | null {
    return this.options.store.get(id);
  }

  saveProject(input: Partial<ProjectRecord> & Pick<ProjectRecord, "name" | "workspacePath">, actor?: WebActivityActor): ProjectRecord {
    const project = this.options.store.save({ ...input, ownerUserId: input.ownerUserId ?? actor?.id });
    this.recordProjectActivity("project_saved", "info", project, actor, project.name);
    return project;
  }

  patchProject(id: string, patch: Partial<ProjectRecord>, actor?: WebActivityActor): ProjectRecord {
    const project = this.options.store.patch(id, patch);
    if (!project) {
      throw new Error(`Project not found: ${id}`);
    }
    this.recordProjectActivity("project_updated", "info", project, actor, project.name);
    return project;
  }

  deleteProject(id: string, actor?: WebActivityActor): { removed: boolean } {
    const project = this.options.store.get(id);
    const removed = this.options.store.delete(id);
    this.options.appendActivity({
      source: "web",
      status: removed ? "info" : "failed",
      type: "project_deleted",
      threadId: null,
      workspace: project?.workspacePath,
      actor,
      detail: project?.name ?? id,
    });
    return { removed };
  }

  linkSession(id: string, link: Partial<ProjectSessionLink> & Pick<ProjectSessionLink, "threadId">, actor?: WebActivityActor): ProjectRecord {
    const project = this.options.store.linkSession(id, link);
    if (!project) {
      throw new Error(`Project not found: ${id}`);
    }
    this.recordProjectActivity("project_session_linked", "info", project, actor, link.threadId);
    return project;
  }

  unlinkSession(id: string, linkId: string, actor?: WebActivityActor): ProjectRecord {
    const project = this.options.store.unlinkSession(id, linkId);
    if (!project) {
      throw new Error(`Project not found: ${id}`);
    }
    this.recordProjectActivity("project_session_unlinked", "info", project, actor, linkId);
    return project;
  }

  updateSummary(id: string, markdown: string, actor?: WebActivityActor): ProjectRecord {
    const project = this.options.store.patch(id, {
      summaryMarkdown: markdown,
      summaryUpdatedAt: new Date().toISOString(),
    });
    if (!project) {
      throw new Error(`Project not found: ${id}`);
    }
    this.recordProjectActivity("project_summary_updated", "info", project, actor, project.name);
    return project;
  }

  updatePlan(id: string, markdown: string, actor?: WebActivityActor): ProjectRecord {
    const project = this.options.store.patch(id, {
      planMarkdown: markdown,
      planUpdatedAt: new Date().toISOString(),
      planItems: parsePlanItemsFromMarkdown(markdown),
    });
    if (!project) {
      throw new Error(`Project not found: ${id}`);
    }
    this.recordProjectActivity("project_plan_updated", "info", project, actor, project.name);
    return project;
  }

  runSummary(id: string, input: ProjectRunOptions = {}, actor?: WebActivityActor): ProjectAnalysisJob {
    return this.queueJob(id, "summary", input, actor);
  }

  runPlan(id: string, input: ProjectRunOptions = {}, actor?: WebActivityActor): ProjectAnalysisJob {
    return this.queueJob(id, "plan", input, actor);
  }

  listJobs(projectId?: string, limit = 100): ProjectAnalysisJob[] {
    return this.options.store.listJobs(projectId, limit);
  }

  async cancelJob(id: string, actor?: WebActivityActor): Promise<ProjectAnalysisJob> {
    const job = this.options.store.getJob(id);
    if (!job) {
      throw new Error(`Project job not found: ${id}`);
    }
    const active = this.activeJobs.has(id);
    const updated = this.options.store.patchJob(id, {
      status: "aborted",
      finishedAt: new Date().toISOString(),
      log: [...job.log, "Job marked as aborted by user."],
    }) ?? job;
    if (active) {
      await this.options.abort(actor).catch(() => {});
    }
    this.upsertUnifiedJob(updated, actor);
    return updated;
  }

  private queueJob(id: string, kind: ProjectJobKind, input: ProjectRunOptions, actor?: WebActivityActor): ProjectAnalysisJob {
    const project = this.requireProject(id);
    if (project.target !== "local") {
      throw new Error("Project analysis jobs currently run on the local node. Create or open the project on the peer to analyze remote-only workspaces.");
    }
    const job = this.options.store.saveJob({
      projectId: project.id,
      kind,
      status: "queued",
      agentId: input.agentId ?? project.defaultAgentId ?? DEFAULT_PROJECT_AGENT,
      planMode: kind === "plan" ? normalizeProjectPlanMode(input.planMode) : undefined,
      planningHorizon: kind === "plan" ? normalizeProjectPlanHorizon(input.planningHorizon) : undefined,
      riskLevel: kind === "plan" ? normalizeProjectPlanRiskLevel(input.riskLevel) : undefined,
      log: [kind === "plan"
        ? `Queued plan analysis for ${project.name} (${planModeLabel(normalizeProjectPlanMode(input.planMode))}, ${planHorizonLabel(normalizeProjectPlanHorizon(input.planningHorizon))}, ${planRiskLabel(normalizeProjectPlanRiskLevel(input.riskLevel))}).`
        : `Queued ${kind} analysis for ${project.name}.`],
    });
    this.upsertUnifiedJob(job, actor);
    this.recordProjectActivity(`project_${kind}_queued`, "queued", project, actor, project.name);
    void this.executeJob(job.id, input, actor).catch((error) => {
      const latest = this.options.store.getJob(job.id) ?? job;
      this.failJob(latest, error, actor);
    });
    return job;
  }

  private async executeJob(id: string, input: ProjectRunOptions, actor?: WebActivityActor): Promise<void> {
    const queued = this.options.store.getJob(id);
    if (!queued) return;
    const project = this.requireProject(queued.projectId);
    const startedAt = new Date().toISOString();
    const correlationId = createCorrelationId();
    this.activeJobs.add(id);
    let job = this.options.store.patchJob(id, {
      status: "running",
      startedAt,
      correlationId,
      log: [...queued.log, "Starting Codex-backed project analysis."],
    }) ?? queued;
    this.upsertUnifiedJob(job, actor);
    this.recordProjectActivity(`project_${job.kind}_started`, "running", project, actor, project.name, correlationId);
    try {
      await this.options.newSession({
        agentId: job.agentId ?? input.agentId ?? project.defaultAgentId ?? DEFAULT_PROJECT_AGENT,
        workspace: project.workspacePath,
        workspaceMode: "attached",
        reasoningEffort: "xhigh",
      }, actor);
      const session = await this.options.getSession(false);
      const info = session.getInfo();
      job = this.options.store.patchJob(id, {
        threadId: info.threadId ?? undefined,
        log: [...job.log, `Running in ${info.agentLabel} at ${info.workspace}.`],
      }) ?? job;
      this.upsertUnifiedJob(job, actor);
      const prompt = job.kind === "plan"
        ? buildPlanPrompt(project, {
          ...input,
          planMode: job.planMode ?? input.planMode,
          planningHorizon: job.planningHorizon ?? input.planningHorizon,
          riskLevel: job.riskLevel ?? input.riskLevel,
        })
        : buildSummaryPrompt(project, input.instructions);
      await this.options.runPrompt(session, { ...toPromptEnvelope(prompt), correlationId, activityActor: actor });
      const outputMarkdown = bestAssistantOutput(this.options.chatMessagesByCorrelation(correlationId, 200));
      const finishedAt = new Date().toISOString();
      const updatedProject = job.kind === "plan"
        ? this.options.store.patch(project.id, {
          planMarkdown: outputMarkdown,
          planUpdatedAt: finishedAt,
          planItems: parsePlanItemsFromMarkdown(outputMarkdown),
        })
        : this.options.store.patch(project.id, {
          summaryMarkdown: outputMarkdown,
          summaryUpdatedAt: finishedAt,
        });
      const completed = this.options.store.patchJob(id, {
        status: "completed",
        finishedAt,
        outputMarkdown,
        log: [...job.log, "Project analysis completed."],
      }) ?? job;
      this.upsertUnifiedJob(completed, actor);
      this.recordProjectActivity(`project_${job.kind}_completed`, "completed", updatedProject ?? project, actor, project.name, correlationId);
      this.options.broadcastStatus(`Project ${job.kind} completed: ${project.name}`, "info");
    } catch (error) {
      this.failJob(job, error, actor);
    } finally {
      this.activeJobs.delete(id);
    }
  }

  private failJob(job: ProjectAnalysisJob, error: unknown, actor?: WebActivityActor): ProjectAnalysisJob {
    const project = this.options.store.get(job.projectId);
    const errorText = error instanceof Error ? error.message : String(error);
    const failed = this.options.store.patchJob(job.id, {
      status: "failed",
      finishedAt: new Date().toISOString(),
      error: errorText,
      log: [...job.log, errorText],
    }) ?? job;
    this.upsertUnifiedJob(failed, actor);
    if (project) {
      this.recordProjectActivity(`project_${job.kind}_failed`, "failed", project, actor, errorText, job.correlationId);
    }
    this.options.broadcastStatus(`Project ${job.kind} failed: ${errorText}`, "error");
    return failed;
  }

  private requireProject(id: string): ProjectRecord {
    const project = this.options.store.get(id);
    if (!project) {
      throw new Error(`Project not found: ${id}`);
    }
    if (!project.workspacePath.trim()) {
      throw new Error(`Project ${project.name} has no workspace path.`);
    }
    return project;
  }

  private recordProjectActivity(
    type: string,
    status: WebActivityEvent["status"],
    project: ProjectRecord,
    actor: WebActivityActor | undefined,
    detail: string,
    correlationId?: string,
  ): void {
    this.options.appendActivity({
      source: "web",
      status,
      type,
      threadId: project.linkedSessions[0]?.threadId ?? null,
      workspace: project.workspacePath,
      agentId: project.defaultAgentId,
      actor,
      correlationId,
      detail,
    });
    this.options.appendAudit({
      action: "command",
      status: status === "failed" ? "failed" : "ok",
      contextKey: "web:projects",
      actor,
      agentId: project.defaultAgentId,
      threadId: project.linkedSessions[0]?.threadId ?? null,
      workspace: project.workspacePath,
      description: `${type}: ${detail}`,
    });
  }

  private upsertUnifiedJob(job: ProjectAnalysisJob, actor?: WebActivityActor): void {
    const project = this.options.store.get(job.projectId);
    this.options.upsertJob({
      id: `project:${job.id}`,
      kind: "project-analysis",
      title: `Project ${job.kind}: ${project?.name ?? job.projectId}`,
      status: unifiedStatus(job.status),
      source: "web",
      agentId: job.agentId,
      threadId: job.threadId ?? project?.linkedSessions[0]?.threadId ?? null,
      workspace: project?.workspacePath,
      owner: actor,
      startedAt: job.startedAt ?? job.createdAt,
      updatedAt: job.updatedAt,
      finishedAt: job.finishedAt,
      summary: job.error ?? job.outputMarkdown?.slice(0, 500),
      correlationId: job.correlationId,
      canCancel: job.status === "queued" || job.status === "running",
      canRetry: job.status === "failed",
      canReadLog: false,
    });
  }
}

function buildSummaryPrompt(project: ProjectRecord, instructions?: string): string {
  return [
    "Create an accurate project summary for NordRelay's Projects view.",
    "",
    `Project: ${project.name}`,
    `Workspace: ${project.workspacePath}`,
    project.description ? `Description: ${project.description}` : "",
    project.linkedSessions.length ? `Linked sessions: ${project.linkedSessions.map((link) => `${link.agentId ?? "agent"}:${link.threadId}`).join(", ")}` : "",
    instructions ? `Additional user instructions: ${instructions}` : "",
    "",
    "Analyze the current repository state before writing. Verify claims against files, docs, package metadata, and existing implementation.",
    "Return concise Markdown with these sections: Overview, Architecture, Key Entry Points, Runtime and Deployment, Current Capabilities, Risks, Open Questions.",
    "Do not recommend future work in this summary unless it is needed to explain an existing risk.",
  ].filter(Boolean).join("\n");
}

function buildPlanPrompt(project: ProjectRecord, input: ProjectRunOptions = {}): string {
  const planMode = normalizeProjectPlanMode(input.planMode);
  const planningHorizon = normalizeProjectPlanHorizon(input.planningHorizon);
  const riskLevel = normalizeProjectPlanRiskLevel(input.riskLevel);
  const existingItems = project.planItems
    .slice()
    .sort((left, right) => Number(right.priority ?? 0) - Number(left.priority ?? 0))
    .slice(0, 30)
    .map((item) => `- ${item.title} (${item.status}; ${item.alreadyExistsCheck}; priority ${item.priority})`)
    .join("\n");
  return [
    "Create a prioritized development plan for this project.",
    "",
    `Project: ${project.name}`,
    `Workspace: ${project.workspacePath}`,
    project.description ? `Description: ${project.description}` : "",
    project.summaryMarkdown ? `Current editable project summary:\n${project.summaryMarkdown}` : "",
    existingItems ? `Existing parsed plan items. Avoid duplicates unless current code evidence proves the old item is obsolete or materially incomplete:\n${existingItems}` : "",
    "",
    `Plan focus: ${planModeLabel(planMode)}.`,
    `Planning horizon: ${planHorizonLabel(planningHorizon)}.`,
    `Risk posture: ${planRiskLabel(riskLevel)}.`,
    planModeInstruction(planMode),
    planHorizonInstruction(planningHorizon),
    planRiskInstruction(riskLevel),
    input.instructions ? `Additional user instructions: ${input.instructions}` : "",
    "",
    "Before proposing work, inspect the current codebase and verify that each recommendation is not already fully implemented.",
    "Avoid duplicate suggestions. Prefer high-signal, concrete improvements with evidence from files, behavior, docs, tests, or runtime behavior.",
    "Return Markdown with a prioritized list. For each item include category, target area, user value, impact, effort, risk, blockers, confidence, and evidence.",
    "",
    "At the end include a fenced code block named nordrelay-project-plan containing a JSON array.",
    "Each JSON item must have: title, description, priority (0-100), category, mode, targetArea, impact, effort, risk, userValue, blockedBy (string array), confidence (0-100), alreadyExistsCheck (not_found, partial, existing, uncertain), evidence (string array).",
  ].filter(Boolean).join("\n");
}

function planModeLabel(mode: ProjectPlanMode): string {
  const labels: Record<ProjectPlanMode, string> = {
    balanced: "Balanced roadmap",
    features: "New features",
    bugfixes: "Bug fixes",
    refactor: "Code quality / refactoring",
    performance: "Performance / scalability",
    security: "Security / permissions",
    ux: "UX / WebUI",
    tests: "Tests / CI / docs",
    release: "Release readiness",
  };
  return labels[mode];
}

function planHorizonLabel(horizon: ProjectPlanHorizon): string {
  return horizon === "next-sprint" ? "Next sprint" : horizon === "long-term" ? "Long-term roadmap" : "Next release";
}

function planRiskLabel(risk: ProjectPlanRiskLevel): string {
  return risk === "conservative" ? "Conservative" : risk === "ambitious" ? "Ambitious" : "Balanced";
}

function planModeInstruction(mode: ProjectPlanMode): string {
  const instructions: Record<ProjectPlanMode, string> = {
    balanced: "Balance new product value, reliability, maintainability, and release risk. Do not over-index on refactoring unless it directly unlocks higher-value work.",
    features: "Prioritize concrete new user-facing or workflow features. At least most recommendations should be new capabilities, not generic cleanup, unless cleanup is a direct prerequisite.",
    bugfixes: "Prioritize likely bugs, regressions, edge cases, race conditions, confusing failure states, and missing defensive checks. Include how each bug can be reproduced or detected.",
    refactor: "Prioritize maintainability, module boundaries, coupling reduction, and simpler future changes. Avoid broad rewrites; propose scoped refactors with clear risk controls.",
    performance: "Prioritize CPU, polling, I/O, network, cache, startup, and large-data performance. Include measurable symptoms and a verification approach for each item.",
    security: "Prioritize access control, secrets handling, auditability, plugin and peer trust, auth/session hardening, and safe defaults. Include abuse cases and expected mitigations.",
    ux: "Prioritize WebUI, chat, workflow, onboarding, diagnostics, and error-state UX. Recommendations should describe the exact user workflow that improves.",
    tests: "Prioritize tests, CI, documentation drift checks, smoke coverage, and regression harnesses. Each item should name the missing confidence and the target test/doc surface.",
    release: "Prioritize release blockers, packaging, install/update reliability, docs completeness, migration risk, and operational verification needed before shipping.",
  };
  return instructions[mode];
}

function planHorizonInstruction(horizon: ProjectPlanHorizon): string {
  if (horizon === "next-sprint") return "Prefer items that can be completed in a short implementation pass and verified quickly.";
  if (horizon === "long-term") return "Include strategic multi-step investments when they are justified, but split them into independently useful milestones.";
  return "Prefer items that fit the next release and improve shipped value without requiring a broad product reset.";
}

function planRiskInstruction(risk: ProjectPlanRiskLevel): string {
  if (risk === "conservative") return "Prefer low-risk, incremental changes with narrow blast radius and clear rollback paths.";
  if (risk === "ambitious") return "Allow larger product bets or architecture changes when the evidence supports them, but call out migration and validation risks clearly.";
  return "Mix quick wins with medium-sized improvements. Avoid risky changes unless their expected value is clearly higher than safer alternatives.";
}

function bestAssistantOutput(messages: WebChatMessage[]): string {
  const agentMessages = messages
    .filter((message) => message.role === "agent" && message.text.trim())
    .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
  if (!agentMessages.length) {
    return "No assistant output was recorded for this analysis run.";
  }
  const last = agentMessages.at(-1)?.text.trim() ?? "";
  if (last.length >= 120 || agentMessages.length === 1) {
    return last;
  }
  return agentMessages.map((message) => message.text.trim()).filter(Boolean).join("\n\n");
}

function parsePlanItemsFromMarkdown(markdown: string): ProjectPlanItem[] {
  const json = extractPlanJson(markdown);
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item, index) => normalizeParsedPlanItem(item, index)).filter((item): item is ProjectPlanItem => Boolean(item));
  } catch {
    return [];
  }
}

function extractPlanJson(markdown: string): string | null {
  const named = markdown.match(/```(?:json\s+)?nordrelay-project-plan\s*\n([\s\S]*?)```/i)
    ?? markdown.match(/```nordrelay-project-plan\s*\n([\s\S]*?)```/i);
  if (named?.[1]) return named[1].trim();
  const blocks = [...markdown.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/gi)];
  for (const block of blocks) {
    const candidate = block[1]?.trim();
    if (candidate?.startsWith("[") && candidate.includes("alreadyExistsCheck")) return candidate;
  }
  return null;
}

function normalizeParsedPlanItem(value: unknown, index: number): ProjectPlanItem | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const title = String(record.title ?? "").trim();
  if (!title) return null;
  const now = new Date().toISOString();
  return {
    id: `project-plan-${index + 1}-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "item"}`,
    title: title.slice(0, 180),
    description: String(record.description ?? "").trim(),
    priority: normalizePriority(record.priority),
    category: cleanOptional(record.category),
    mode: normalizeProjectPlanMode(record.mode),
    targetArea: cleanOptional(record.targetArea),
    impact: cleanOptional(record.impact),
    effort: cleanOptional(record.effort),
    risk: cleanOptional(record.risk),
    userValue: cleanOptional(record.userValue),
    blockedBy: normalizeStringList(record.blockedBy),
    confidence: normalizeConfidence(record.confidence),
    status: "proposed",
    evidence: Array.isArray(record.evidence) ? record.evidence.map((entry) => String(entry ?? "").trim()).filter(Boolean).slice(0, 10) : [],
    alreadyExistsCheck: normalizeExistenceCheck(record.alreadyExistsCheck),
    createdAt: now,
    updatedAt: now,
  };
}

function normalizePriority(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, Math.round(number))) : 50;
}

function normalizeConfidence(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, Math.round(number))) : undefined;
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((entry) => String(entry ?? "").trim()).filter(Boolean))].slice(0, 20);
}

function normalizeExistenceCheck(value: unknown): ProjectPlanExistenceCheck {
  return value === "partial" || value === "existing" || value === "uncertain" ? value : "not_found";
}

function cleanOptional(value: unknown): string | undefined {
  const text = String(value ?? "").trim();
  return text || undefined;
}

function unifiedStatus(status: ProjectJobStatus): UnifiedJobDto["status"] {
  if (status === "completed" || status === "failed" || status === "aborted" || status === "running") return status;
  return "queued";
}
