import { UserStore } from "../../access/user-management.js";
import type { ConnectorConfig } from "../../core/config.js";
import { friendlyErrorText } from "../../core/error-messages.js";
import { collectMatrixDiagnostics } from "./matrix-diagnostics.js";
import { getMatrixRateLimitMetrics } from "./matrix-rate-limit.js";

export function logMatrixStartupDiagnostics(config: ConnectorConfig, userStore: UserStore): void {
  void collectMatrixDiagnostics({
    config,
    userStore,
    timeoutMs: 3_500,
    rateLimit: getMatrixRateLimitMetrics(),
  }).then((diagnostics) => {
    for (const check of diagnostics.checks.filter((item) => item.status === "warn" || item.status === "error")) {
      console.warn(`Matrix ${check.status}: ${check.label}: ${check.detail}`);
    }
    for (const room of diagnostics.roomChecks.filter((item) => item.status === "warn" || item.status === "error")) {
      console.warn(`Matrix ${room.status}: room ${room.roomId}: ${room.detail}`);
    }
  }).catch((error) => console.warn("Matrix diagnostics failed:", friendlyErrorText(error)));
}
