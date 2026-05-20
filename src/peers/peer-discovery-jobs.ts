import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

import type { ConnectorConfig } from "../core/config.js";
import { readJsonFileWithBackup, writeJsonFileAtomic } from "../state/persistence.js";
import { countDiscoveryTargets, discoverLanPeers } from "./peer-discovery.js";
import type { PeerDiscoveryJobSnapshot } from "./peer-types.js";

export interface PeerDiscoveryJobInput {
  targets?: string[];
  timeoutMs?: number;
  concurrency?: number;
  maxHosts?: number;
}

interface PeerDiscoveryJobEntry {
  snapshot: PeerDiscoveryJobSnapshot;
  controller: AbortController;
}

const MAX_JOBS = 25;
const MAX_LOG_LINES = 300;
const DEFAULT_HOME = path.join(os.homedir(), ".nordrelay");

interface PersistedPeerDiscoveryJobs {
  version: 1;
  jobs: PeerDiscoveryJobSnapshot[];
}

export class PeerDiscoveryJobManager {
  private readonly jobs = new Map<string, PeerDiscoveryJobEntry>();
  private readonly filePath: string;

  constructor(private readonly config: ConnectorConfig, home = process.env.NORDRELAY_HOME || DEFAULT_HOME) {
    this.filePath = path.join(home, "peer-discovery-jobs.json");
    this.load();
  }

  list(): PeerDiscoveryJobSnapshot[] {
    return [...this.jobs.values()].map((entry) => cloneJob(entry.snapshot))
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  }

  get(id: string): PeerDiscoveryJobSnapshot | null {
    const entry = this.jobs.get(id);
    return entry ? cloneJob(entry.snapshot) : null;
  }

  log(id: string): string {
    return this.jobs.get(id)?.snapshot.log.join("\n") ?? "";
  }

  async start(input: PeerDiscoveryJobInput = {}): Promise<PeerDiscoveryJobSnapshot> {
    this.prune();
    const controller = new AbortController();
    const options = normalizeInput(this.config, input);
    const id = randomUUID().replace(/-/g, "").slice(0, 12);
    const snapshot: PeerDiscoveryJobSnapshot = {
      id,
      status: "queued",
      createdAt: new Date().toISOString(),
      scanned: 0,
      total: await countDiscoveryTargets(this.config, options).catch(() => 0),
      candidates: [],
      warnings: [],
      log: [],
      options,
    };
    const entry: PeerDiscoveryJobEntry = { snapshot, controller };
    this.jobs.set(id, entry);
    this.append(entry, `Queued peer discovery job ${id}.`);
    void this.run(entry).catch((error) => {
      entry.snapshot.status = controller.signal.aborted ? "cancelled" : "failed";
      entry.snapshot.error = error instanceof Error ? error.message : String(error);
      entry.snapshot.completedAt = new Date().toISOString();
      this.append(entry, entry.snapshot.error);
    });
    return cloneJob(snapshot);
  }

  cancel(id: string): PeerDiscoveryJobSnapshot | null {
    const entry = this.jobs.get(id);
    if (!entry) return null;
    if (entry.snapshot.status === "queued" || entry.snapshot.status === "running") {
      entry.controller.abort();
      entry.snapshot.status = "cancelled";
      entry.snapshot.completedAt = new Date().toISOString();
      this.append(entry, "Cancellation requested.");
    }
    return cloneJob(entry.snapshot);
  }

  private async run(entry: PeerDiscoveryJobEntry): Promise<void> {
    entry.snapshot.status = "running";
    entry.snapshot.startedAt = new Date().toISOString();
    this.append(entry, `Scanning ${entry.snapshot.total} peer endpoint candidate(s).`);
    const result = await discoverLanPeers(this.config, {
      ...entry.snapshot.options,
      signal: entry.controller.signal,
      onProgress: (progress) => {
        entry.snapshot.scanned = progress.scanned;
        if (progress.candidate) {
          entry.snapshot.candidates = mergeCandidates(entry.snapshot.candidates, progress.candidate);
          this.append(entry, `Found ${progress.candidate.name || progress.candidate.host} at ${progress.candidate.url}.`);
        } else if (progress.scanned % 25 === 0 || progress.scanned === entry.snapshot.total) {
          this.append(entry, `Scanned ${progress.scanned}/${progress.total}.`);
        }
      },
    });
    entry.snapshot.scanned = result.scanned;
    entry.snapshot.candidates = result.candidates;
    entry.snapshot.warnings = result.warnings;
    entry.snapshot.status = entry.controller.signal.aborted ? "cancelled" : "completed";
    entry.snapshot.completedAt = new Date().toISOString();
    this.append(entry, `${entry.snapshot.status === "completed" ? "Completed" : "Cancelled"} with ${result.candidates.length} candidate(s).`);
    for (const warning of result.warnings) {
      this.append(entry, `Warning: ${warning}`);
    }
  }

  private append(entry: PeerDiscoveryJobEntry, line: string): void {
    entry.snapshot.log.push(`[${new Date().toLocaleString()}] ${line}`);
    if (entry.snapshot.log.length > MAX_LOG_LINES) {
      entry.snapshot.log.splice(0, entry.snapshot.log.length - MAX_LOG_LINES);
    }
    this.save();
  }

  private prune(): void {
    const completed = this.list()
      .filter((job) => job.status !== "running" && job.status !== "queued")
      .slice(MAX_JOBS);
    for (const job of completed) {
      this.jobs.delete(job.id);
    }
    this.save();
  }

  private load(): void {
    const result = readJsonFileWithBackup<PersistedPeerDiscoveryJobs>(this.filePath);
    const jobs = Array.isArray(result.value?.jobs) ? result.value.jobs : [];
    let changed = false;
    for (const job of jobs) {
      const snapshot = normalizePersistedJob(job);
      if (!snapshot) continue;
      if (snapshot.status === "queued" || snapshot.status === "running") {
        snapshot.status = "failed";
        snapshot.completedAt = new Date().toISOString();
        snapshot.error = "Discovery job was interrupted by a NordRelay restart.";
        snapshot.log = [
          ...snapshot.log,
          `[${new Date().toLocaleString()}] Discovery job was interrupted by a NordRelay restart.`,
        ].slice(-MAX_LOG_LINES);
        changed = true;
      }
      this.jobs.set(snapshot.id, { snapshot, controller: new AbortController() });
    }
    this.prune();
    if (changed) {
      this.save();
    }
  }

  private save(): void {
    const jobs = this.list().slice(0, MAX_JOBS);
    writeJsonFileAtomic(this.filePath, { version: 1, jobs } satisfies PersistedPeerDiscoveryJobs);
  }
}

function normalizePersistedJob(value: unknown): PeerDiscoveryJobSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.createdAt !== "string") return null;
  const status = typeof record.status === "string" && ["queued", "running", "completed", "failed", "cancelled"].includes(record.status)
    ? record.status as PeerDiscoveryJobSnapshot["status"]
    : "failed";
  const optionsRecord = record.options && typeof record.options === "object" && !Array.isArray(record.options)
    ? record.options as Record<string, unknown>
    : {};
  return {
    id: record.id,
    status,
    createdAt: record.createdAt,
    startedAt: typeof record.startedAt === "string" ? record.startedAt : undefined,
    completedAt: typeof record.completedAt === "string" ? record.completedAt : undefined,
    scanned: integerField(record.scanned),
    total: integerField(record.total),
    candidates: Array.isArray(record.candidates) ? record.candidates as PeerDiscoveryJobSnapshot["candidates"] : [],
    warnings: Array.isArray(record.warnings) ? record.warnings.filter((item): item is string => typeof item === "string") : [],
    log: Array.isArray(record.log) ? record.log.filter((item): item is string => typeof item === "string").slice(-MAX_LOG_LINES) : [],
    error: typeof record.error === "string" ? record.error : undefined,
    options: {
      targets: Array.isArray(optionsRecord.targets) ? optionsRecord.targets.filter((item): item is string => typeof item === "string") : [],
      timeoutMs: integerField(optionsRecord.timeoutMs),
      concurrency: integerField(optionsRecord.concurrency),
      maxHosts: integerField(optionsRecord.maxHosts),
    },
  };
}

function integerField(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function normalizeInput(config: ConnectorConfig, input: PeerDiscoveryJobInput): PeerDiscoveryJobSnapshot["options"] {
  return {
    targets: (input.targets ?? []).map((target) => target.trim()).filter(Boolean),
    timeoutMs: clampInteger(input.timeoutMs, config.peerDiscoveryTimeoutMs, 100, 30_000),
    concurrency: clampInteger(input.concurrency, 32, 1, 128),
    maxHosts: clampInteger(input.maxHosts, 512, 1, 65_536),
  };
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function mergeCandidates(existing: PeerDiscoveryJobSnapshot["candidates"], candidate: PeerDiscoveryJobSnapshot["candidates"][number]): PeerDiscoveryJobSnapshot["candidates"] {
  const byNode = new Map(existing.map((item) => [item.nodeId, item]));
  byNode.set(candidate.nodeId, candidate);
  return [...byNode.values()].sort((left, right) => (left.name || left.host).localeCompare(right.name || right.host));
}

function cloneJob(job: PeerDiscoveryJobSnapshot): PeerDiscoveryJobSnapshot {
  return {
    ...job,
    candidates: job.candidates.map((candidate) => ({ ...candidate })),
    warnings: [...job.warnings],
    log: [...job.log],
    options: {
      ...job.options,
      targets: [...job.options.targets],
    },
  };
}
