import { friendlyErrorText } from "../core/error-messages.js";
import { getObservabilityRegistry } from "../observability/observability-registry.js";
import { runtimeMetricHistorySample } from "./metrics.js";
import type { RelayRuntimeDelegate } from "./relay-runtime-delegate.js";

const METRICS_HISTORY_INTERVAL_MS = 60_000;
const INITIAL_METRICS_HISTORY_DELAY_MS = 2_000;

export function startRuntimeMetricsHistory(runtime: RelayRuntimeDelegate): void {
  runtime.metricsHistoryPoller = getObservabilityRegistry().registerPoller({
    id: "runtime:metrics-history",
    owner: "runtime",
    kind: "metrics-history",
    intervalMs: METRICS_HISTORY_INTERVAL_MS,
    currentDelayMs: METRICS_HISTORY_INTERVAL_MS,
    nextRunAt: Date.now() + INITIAL_METRICS_HISTORY_DELAY_MS,
  });
  const record = async () => {
    await runtime.metrics()
      .then((metrics) => runtime.metricsHistoryStore.append(runtimeMetricHistorySample(metrics)))
      .catch((error) => runtime.broadcastStatus(`Failed to record metrics history: ${friendlyErrorText(error)}`, "warn"));
  };
  const run = (delayMs: number) => {
    runtime.metricsHistoryPoller?.update({ currentDelayMs: delayMs, nextRunAt: Date.now() + METRICS_HISTORY_INTERVAL_MS });
    const finish = runtime.metricsHistoryPoller?.start();
    void record().then(() => finish?.()).catch((error) => finish?.(error));
  };
  const initialTimer = setTimeout(() => run(INITIAL_METRICS_HISTORY_DELAY_MS), INITIAL_METRICS_HISTORY_DELAY_MS);
  initialTimer.unref?.();
  runtime.metricsHistoryTimer = setInterval(() => run(METRICS_HISTORY_INTERVAL_MS), METRICS_HISTORY_INTERVAL_MS);
  runtime.metricsHistoryTimer.unref?.();
}
