import {
  collectRecentWorkspaceArtifacts,
  createArtifactZipBundle,
  formatArtifactSummary,
  isTelegramImagePreview,
  persistWorkspaceArtifactReport,
  type Artifact,
} from "../../artifacts/artifacts.js";
import { artifactDeliveryPolicy, type ArtifactDeliveryPolicy } from "../../artifacts/artifact-delivery.js";
import type { AgentSessionService } from "../../agents/shared/agent.js";
import type { ConnectorConfig } from "../../core/config.js";
import type { WebActivityEvent } from "../../web/web-state.js";
import type { ChannelExternalMirrorState } from "./channel-bridge-state.js";
import type { ChannelContextKey } from "./context-key.js";
import { isEmptyArtifactReport } from "./bot-rendering.js";

export interface ChannelCliArtifactDeliveryOptions<MessageId extends string | number> {
  config: ConnectorConfig;
  contextKey: ChannelContextKey;
  session: AgentSessionService;
  startedAt: Date | null | undefined;
  turnId: string | null;
  state?: ChannelExternalMirrorState<MessageId>;
  autoSend: boolean;
  deliveryPolicy?: ArtifactDeliveryPolicy;
  sendSummaryWhenAutoSendDisabled?: boolean;
  logPrefix: string;
  sendSummary(summary: string): Promise<void>;
  sendArtifact(artifact: Artifact): Promise<void>;
  appendActivity(input: Omit<WebActivityEvent, "id" | "timestamp"> & { timestamp?: string }): void;
}

export async function deliverChannelCliArtifacts<MessageId extends string | number>(
  options: ChannelCliArtifactDeliveryOptions<MessageId>,
): Promise<void> {
  if (!options.config.artifactsEnabled) {
    return;
  }
  if (!options.startedAt || !options.turnId) {
    return;
  }
  if (
    options.state?.artifactsDeliveredForTurnId === options.turnId ||
    options.state?.artifactsDeliveryInFlightForTurnId === options.turnId
  ) {
    return;
  }
  if (options.state) {
    options.state.artifactsDeliveryInFlightForTurnId = options.turnId;
  }

  try {
    const workspace = options.session.getInfo().workspace;
    const report = await collectRecentWorkspaceArtifacts(workspace, {
      since: options.startedAt,
      until: new Date(),
      maxFileSize: options.config.maxFileSize,
      limit: 5,
      ignoreDirs: options.config.artifactIgnoreDirs,
      ignoreGlobs: options.config.artifactIgnoreGlobs,
    });
    if (isEmptyArtifactReport(report)) {
      if (options.state) options.state.artifactsDeliveredForTurnId = options.turnId;
      return;
    }

    const persistedReport = await persistWorkspaceArtifactReport(workspace, options.turnId, report).catch((error) => {
      console.error(`Failed to persist ${options.logPrefix} CLI artifact report:`, error);
      return null;
    });

    const policy = options.deliveryPolicy ?? artifactDeliveryPolicy(options.autoSend ? "auto-files" : "manual-only");
    const summary = formatArtifactSummary(report.artifacts, report.skippedCount, report.omittedCount);
    if (policy.sendSummary || options.sendSummaryWhenAutoSendDisabled) {
      await options.sendSummary(summary);
    }

    if (policy.autoSendZip) {
      const zip = await createArtifactZipBundle(persistedReport?.artifacts ?? report.artifacts, persistedReport?.outDir ?? workspace, {
        maxFileSize: options.config.maxFileSize,
        bundleName: `nordrelay-artifacts-${options.turnId}.zip`,
      });
      if (zip) {
        await options.sendArtifact(zip);
      }
    } else if (policy.autoSendFiles) {
      const artifacts = (persistedReport?.artifacts ?? report.artifacts)
        .filter((artifact) => !policy.imagesOnly || isTelegramImagePreview(artifact))
        .slice(0, 5);
      for (const artifact of artifacts) {
        await options.sendArtifact(artifact);
      }
    }

    const info = options.session.getInfo();
    options.appendActivity({
      source: "cli",
      status: "info",
      type: policy.autoSendFiles || policy.autoSendZip ? "artifacts_sent" : "artifacts_detected",
      contextKey: options.contextKey,
      threadId: info.threadId,
      workspace: info.workspace,
      agentId: info.agentId,
      actor: { channel: "cli", label: `${info.agentLabel} CLI` },
      detail: `${policy.mode}: ${summary}`,
    });
    if (options.state) options.state.artifactsDeliveredForTurnId = options.turnId;
  } finally {
    if (options.state?.artifactsDeliveryInFlightForTurnId === options.turnId) {
      options.state.artifactsDeliveryInFlightForTurnId = null;
    }
  }
}
