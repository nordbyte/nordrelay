import { UserStore } from "../../access/user-management.js";
import type { ConnectorConfig } from "../../core/config.js";
import { friendlyErrorText } from "../../core/error-messages.js";
import { collectSlackDiagnostics } from "./slack-diagnostics.js";
import { getSlackRateLimitMetrics } from "./slack-rate-limit.js";

export function logSlackStartupDiagnostics(config: ConnectorConfig, userStore: UserStore): void {
  void collectSlackDiagnostics({
    config,
    userStore,
    timeoutMs: 3_500,
    rateLimit: getSlackRateLimitMetrics(),
  }).then((diagnostics) => {
    for (const check of diagnostics.checks.filter((item) => item.status === "warn" || item.status === "error")) {
      console.warn(`Slack ${check.status}: ${check.label}: ${check.detail}`);
    }
    for (const channel of diagnostics.channelChecks.filter((item) => item.status === "warn" || item.status === "error")) {
      console.warn(`Slack ${channel.status}: channel ${channel.channelId}: ${channel.detail}`);
    }
  }).catch((error) => console.warn("Slack diagnostics failed:", friendlyErrorText(error)));
}
