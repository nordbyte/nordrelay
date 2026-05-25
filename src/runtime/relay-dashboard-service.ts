import type { AgentId, AgentSessionService } from "../agents/shared/agent.js";
import { enabledAgents } from "../agents/shared/agent-factory.js";
import { listAgentAdapterDescriptors } from "../agents/shared/agent-adapter.js";
import type { ConnectorConfig } from "../core/config.js";
import { friendlyErrorText } from "../core/error-messages.js";
import { getVoiceDiagnostics, type VoiceDiagnostics } from "../artifacts/voice.js";
import { getAgentDiagnostics } from "../agents/shared/agent-activity.js";
import { getConnectorHealth, getVersionChecks, readConnectorState } from "../support/operations.js";
import type { RuntimeSnapshotCache } from "./runtime-cache.js";
import { getObservabilityRegistry, type ObservedPollerHandle } from "../observability/observability-registry.js";
import { collectSlackDiagnostics } from "../channels/slack/slack-diagnostics.js";
import { getSlackRateLimitMetrics } from "../channels/slack/slack-rate-limit.js";
import { collectMatrixDiagnostics } from "../channels/matrix/matrix-diagnostics.js";
import { getMatrixRateLimitMetrics } from "../channels/matrix/matrix-rate-limit.js";
import { cliHealthForAgent, versionCheckForAgent } from "./relay-runtime-helpers.js";
import type {
  RelaySnapshot,
  WebAdapterHealthDto,
  WebAuthDto,
  WebDiagnosticsDto,
} from "./relay-runtime-types.js";

export type RelayDashboardCacheKey = "version" | "diagnostics" | "adapterHealth";

export interface RelayDashboardServiceOptions {
  config: ConnectorConfig;
  cache: RuntimeSnapshotCache;
  snapshot: () => Promise<RelaySnapshot>;
  getSession: () => Promise<AgentSessionService>;
  queuePaused: () => boolean;
  externalMirror: () => WebDiagnosticsDto["runtime"]["externalMirror"];
  authStatus: (agentId?: AgentId) => Promise<WebAuthDto>;
  backgroundRefreshEnabled?: boolean;
  isActive?: () => boolean;
  cliPathOptions: () => {
    piCliPath?: string;
    hermesCliPath?: string;
    openClawCliPath?: string;
    claudeCodeCliPath?: string;
  };
}

export class RelayDashboardService {
  private readonly keys: RelayDashboardCacheKey[] = ["version", "adapterHealth", "diagnostics"];
  private warmTimers: NodeJS.Timeout[] = [];
  private warmPollers: ObservedPollerHandle[] = [];

  constructor(private readonly options: RelayDashboardServiceOptions) {
    options.cache.register("version", () => this.produceVersion());
    options.cache.register("adapterHealth", () => this.produceAdapterHealth());
    options.cache.register("diagnostics", () => this.produceDiagnostics());
  }

  startBackgroundRefresh(): void {
    if (this.options.backgroundRefreshEnabled === false) {
      return;
    }
    if (this.isActive()) {
      this.options.cache.warm(this.keys);
    }
    const ttlMs = this.options.config.dashboardCacheTtlMs;
    if (ttlMs <= 0 || this.warmTimers.length > 0) {
      return;
    }
    const diagnosticsIntervalMs = Math.max(5_000, ttlMs);
    const slowIntervalMs = Math.max(30_000, ttlMs * 6);
    const observability = getObservabilityRegistry();
    const diagnosticsPoller = observability.registerPoller({
      id: "dashboard:diagnostics-warm",
      owner: "dashboard",
      kind: "cache-warm",
      intervalMs: diagnosticsIntervalMs,
      currentDelayMs: diagnosticsIntervalMs,
      nextRunAt: Date.now() + diagnosticsIntervalMs,
    });
    const slowPoller = observability.registerPoller({
      id: "dashboard:version-adapter-warm",
      owner: "dashboard",
      kind: "cache-warm",
      intervalMs: slowIntervalMs,
      currentDelayMs: slowIntervalMs,
      nextRunAt: Date.now() + slowIntervalMs,
    });
    this.warmPollers = [diagnosticsPoller, slowPoller];
    this.warmTimers = [
      setInterval(() => {
        diagnosticsPoller.update({ nextRunAt: Date.now() + diagnosticsIntervalMs });
        if (!this.isActive()) {
          diagnosticsPoller.skip("dashboard inactive");
          return;
        }
        const finish = diagnosticsPoller.start();
        try {
          this.options.cache.warm(["diagnostics"]);
          finish();
        } catch (error) {
          finish(error);
        }
      }, diagnosticsIntervalMs),
      setInterval(() => {
        slowPoller.update({ nextRunAt: Date.now() + slowIntervalMs });
        if (!this.isActive()) {
          slowPoller.skip("dashboard inactive");
          return;
        }
        const finish = slowPoller.start();
        try {
          this.options.cache.warm(["version", "adapterHealth"]);
          finish();
        } catch (error) {
          finish(error);
        }
      }, slowIntervalMs),
    ];
    this.warmTimers.forEach((timer) => timer.unref?.());
  }

  stopBackgroundRefresh(): void {
    this.warmTimers.forEach((timer) => clearInterval(timer));
    this.warmTimers = [];
    this.warmPollers.forEach((poller) => poller.close());
    this.warmPollers = [];
  }

  async version(options: { forceRefresh?: boolean } = {}): Promise<Record<string, unknown>> {
    if (options.forceRefresh) {
      this.options.cache.invalidate("version");
      return this.produceVersion({ forceRefresh: true });
    }
    return this.cached("version");
  }

  async diagnostics(): Promise<WebDiagnosticsDto> {
    return this.cached<WebDiagnosticsDto>("diagnostics");
  }

  async refreshVoiceDiagnostics(): Promise<VoiceDiagnostics> {
    const diagnostics = await this.produceVoiceDiagnostics(true);
    this.options.cache.invalidate("diagnostics");
    this.options.cache.warm(["diagnostics"]);
    return diagnostics;
  }

  async adapterHealth(): Promise<WebAdapterHealthDto[]> {
    return this.cached<WebAdapterHealthDto[]>("adapterHealth");
  }

  invalidate(key?: RelayDashboardCacheKey): void {
    this.options.cache.invalidate(key);
    if (key) {
      this.options.cache.warm([key]);
      return;
    }
    this.options.cache.warm(this.keys);
  }

  private async cached<T>(key: RelayDashboardCacheKey): Promise<T> {
    return (await this.options.cache.get<T>(key, this.options.config.dashboardCacheTtlMs)).value;
  }

  private async produceVersion(options: { forceRefresh?: boolean } = {}): Promise<Record<string, unknown>> {
    const cliOptions = this.options.cliPathOptions();
    const [health, state, versionChecks] = await Promise.all([
      getConnectorHealth(cliOptions),
      readConnectorState(),
      getVersionChecks({ ...cliOptions, forceRefresh: options.forceRefresh }),
    ]);
    return {
      health,
      state,
      versionChecks,
    };
  }

  private async produceDiagnostics(): Promise<WebDiagnosticsDto> {
    const cliOptions = this.options.cliPathOptions();
    const [health, versionChecks, snapshot, session] = await Promise.all([
      getConnectorHealth(cliOptions),
      getVersionChecks(cliOptions),
      this.options.snapshot(),
      this.options.getSession(),
    ]);
    const [slackDiagnostics, matrixDiagnostics, voiceDiagnostics] = await Promise.all([
      collectSlackDiagnostics({
        config: this.options.config,
        timeoutMs: 2_500,
        rateLimit: getSlackRateLimitMetrics(),
      }),
      collectMatrixDiagnostics({
        config: this.options.config,
        timeoutMs: 2_500,
        rateLimit: getMatrixRateLimitMetrics(),
      }),
      this.produceVoiceDiagnostics(false),
    ]);
    return {
      health,
      versionChecks,
      snapshot,
      runtime: {
        stateBackend: this.options.config.stateBackend,
        sourceWorkspace: this.options.config.workspace,
        queuePaused: this.options.queuePaused(),
        externalMirror: this.options.externalMirror(),
        agentDiagnostics: getAgentDiagnostics(session, this.options.config),
        slackDiagnostics,
        matrixDiagnostics,
        voiceDiagnostics,
      },
    };
  }

  private async produceVoiceDiagnostics(forceRefresh: boolean): Promise<VoiceDiagnostics> {
    return getVoiceDiagnostics({
      preferredBackend: this.options.config.voicePreferredBackend,
      defaultLanguage: this.options.config.voiceDefaultLanguage ?? null,
      transcribeOnly: this.options.config.voiceTranscribeOnly,
      fasterWhisperPython: process.env.FASTER_WHISPER_PYTHON,
      forceRefresh,
      includeHeavyChecks: forceRefresh,
    });
  }

  private isActive(): boolean {
    return this.options.isActive?.() ?? true;
  }

  private async produceAdapterHealth(): Promise<WebAdapterHealthDto[]> {
    const cliOptions = this.options.cliPathOptions();
    const [health, versions] = await Promise.all([
      getConnectorHealth(cliOptions),
      getVersionChecks(cliOptions),
    ]);
    return Promise.all(listAgentAdapterDescriptors().map(async (descriptor) => {
      const enabled = enabledAgents(this.options.config).includes(descriptor.id);
      const auth = descriptor.capabilities.auth && enabled
        ? await this.options.authStatus(descriptor.id).catch((error): WebAuthDto => ({
          agentId: descriptor.id,
          agentLabel: descriptor.label,
          supported: descriptor.capabilities.auth,
          authenticated: false,
          detail: friendlyErrorText(error),
          loginSupported: descriptor.capabilities.login,
          logoutSupported: descriptor.capabilities.logout,
        }))
        : null;
      const cli = cliHealthForAgent(descriptor.id, health);
      const version = versionCheckForAgent(descriptor.id, versions);
      return {
        id: descriptor.id,
        label: descriptor.label,
        enabled,
        status: descriptor.status === "available" ? (enabled ? "enabled" : "disabled") : "planned",
        auth: {
          supported: descriptor.capabilities.auth,
          authenticated: auth ? auth.authenticated : null,
          method: auth?.method,
          detail: auth?.detail,
        },
        cli,
        version: {
          installed: version.installedLabel,
          latest: version.latestVersion,
          status: version.status,
          detail: version.detail,
        },
        capabilities: descriptor.capabilities,
        notes: descriptor.notes,
      };
    }));
  }
}
