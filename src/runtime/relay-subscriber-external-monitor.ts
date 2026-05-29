import type { RelayRuntimeDelegate } from "./relay-runtime-delegate.js";
import { startAdaptiveExternalMonitor } from "./relay-external-monitor-scheduler.js";

const subscriberStartedMonitors = new WeakSet<RelayRuntimeDelegate>();

export function ensureSubscriberExternalMonitor(runtime: RelayRuntimeDelegate): void {
  if (runtime.externalMonitor || runtime.config.codexExternalBusyCheckMs <= 0) {
    return;
  }
  runtime.externalMonitor = startAdaptiveExternalMonitor({
    id: `runtime:external-activity-monitor:${runtime.contextKey}`,
    owner: `runtime:${runtime.contextKey}`,
    baseMs: runtime.config.codexExternalBusyCheckMs,
    run: () => runtime.externalActivityMonitor.monitorSafe(),
  });
  subscriberStartedMonitors.add(runtime);
  void runtime.externalActivityMonitor.monitorSafe();
}

export function stopSubscriberExternalMonitorIfIdle(runtime: RelayRuntimeDelegate): void {
  if (!subscriberStartedMonitors.has(runtime) || runtime.subscribers.size > 0) {
    return;
  }
  runtime.externalMonitor?.close();
  runtime.externalMonitor = undefined;
  subscriberStartedMonitors.delete(runtime);
}
