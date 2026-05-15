import type { UnifiedJobDto } from "./relay-runtime-types.js";
import { createDocumentStore, type DocumentStore, type StateBackendKind } from "./state-backend.js";

interface PersistedUnifiedJobs {
  version: 1;
  jobs: UnifiedJobDto[];
}

const DEFAULT_MAX_JOBS = 1000;

export class UnifiedJobStore {
  private readonly store: DocumentStore<PersistedUnifiedJobs>;

  constructor(workspace: string, backend: StateBackendKind = "json", private readonly maxJobs = DEFAULT_MAX_JOBS) {
    this.store = createDocumentStore<PersistedUnifiedJobs>({
      workspace,
      backend,
      fileName: "unified-jobs.json",
      sqliteKey: "unified-jobs",
    });
  }

  list(limit = 200): UnifiedJobDto[] {
    return this.readPayload().jobs
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .slice(0, Math.max(1, Math.min(this.maxJobs, limit)));
  }

  get(id: string): UnifiedJobDto | null {
    return this.readPayload().jobs.find((job) => job.id === id) ?? null;
  }

  upsert(job: UnifiedJobDto): UnifiedJobDto {
    const payload = this.readPayload();
    const normalized = normalizeJob(job);
    const index = payload.jobs.findIndex((candidate) => candidate.id === normalized.id);
    if (index >= 0) {
      payload.jobs[index] = {
        ...payload.jobs[index],
        ...normalized,
      };
    } else {
      payload.jobs.push(normalized);
    }
    payload.jobs = trimJobs(payload.jobs, this.maxJobs);
    this.store.write(payload);
    return normalized;
  }

  upsertMany(jobs: UnifiedJobDto[]): UnifiedJobDto[] {
    if (jobs.length === 0) {
      return this.list();
    }
    const payload = this.readPayload();
    const byId = new Map(payload.jobs.map((job) => [job.id, job]));
    for (const job of jobs) {
      const normalized = normalizeJob(job);
      byId.set(normalized.id, {
        ...byId.get(normalized.id),
        ...normalized,
      });
    }
    payload.jobs = trimJobs([...byId.values()], this.maxJobs);
    this.store.write(payload);
    return payload.jobs;
  }

  patch(id: string, patch: Partial<UnifiedJobDto>): UnifiedJobDto | null {
    const payload = this.readPayload();
    const index = payload.jobs.findIndex((job) => job.id === id);
    if (index < 0) {
      return null;
    }
    payload.jobs[index] = normalizeJob({
      ...payload.jobs[index],
      ...patch,
      id,
      updatedAt: patch.updatedAt ?? new Date().toISOString(),
    });
    this.store.write(payload);
    return payload.jobs[index];
  }

  remove(id: string): boolean {
    const payload = this.readPayload();
    const next = payload.jobs.filter((job) => job.id !== id);
    if (next.length === payload.jobs.length) {
      return false;
    }
    payload.jobs = next;
    this.store.write(payload);
    return true;
  }

  private readPayload(): PersistedUnifiedJobs {
    const payload = this.store.read();
    if (!payload || payload.version !== 1 || !Array.isArray(payload.jobs)) {
      return { version: 1, jobs: [] };
    }
    return {
      version: 1,
      jobs: trimJobs(payload.jobs.filter(isUnifiedJobDto).map(normalizeJob), this.maxJobs),
    };
  }
}

function trimJobs(jobs: UnifiedJobDto[], maxJobs: number): UnifiedJobDto[] {
  return jobs
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .slice(0, maxJobs);
}

function normalizeJob(job: UnifiedJobDto): UnifiedJobDto {
  return {
    ...job,
    startedAt: validDateString(job.startedAt) ?? new Date().toISOString(),
    updatedAt: validDateString(job.updatedAt) ?? new Date().toISOString(),
    finishedAt: validDateString(job.finishedAt),
    canCancel: Boolean(job.canCancel),
    canRetry: Boolean(job.canRetry),
    canReadLog: Boolean(job.canReadLog),
  };
}

function validDateString(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return Number.isFinite(Date.parse(value)) ? value : undefined;
}

function isUnifiedJobDto(value: unknown): value is UnifiedJobDto {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as UnifiedJobDto;
  return typeof candidate.id === "string" &&
    typeof candidate.kind === "string" &&
    typeof candidate.title === "string" &&
    typeof candidate.status === "string" &&
    typeof candidate.source === "string" &&
    typeof candidate.startedAt === "string" &&
    typeof candidate.updatedAt === "string";
}
