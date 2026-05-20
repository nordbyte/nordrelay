import { collectRecentWorkspaceArtifacts, createArtifactZipBundle, formatArtifactSummary, listRecentArtifactReports, totalArtifactSize, type Artifact, type ArtifactTurnReport } from "../../artifacts/artifacts.js";
import { ARTIFACT_DELIVERY_MODES, artifactDeliveryPolicy, isArtifactDeliveryMode, type ArtifactDeliveryMode, type ArtifactDeliveryPolicy } from "../../artifacts/artifact-delivery.js";
import { filterArtifactReports as filterArtifactReportsForCommand } from "../shared/bot-rendering.js";
import { renderArtifactCleanupAction, renderArtifactDeliveryAction, renderArtifactReportsAction, renderArtifactUsageAction } from "../shared/channel-actions.js";
import type { ChannelContext, ChannelRuntime } from "../shared/channel-adapter.js";
import { deliverChannelAction } from "../shared/channel-runtime.js";
import type { ConnectorConfig } from "../../core/config.js";
import type { ChannelContextKey } from "../shared/context-key.js";
import type { AgentSessionService } from "../../agents/shared/agent.js";
import type { RelayArtifactService } from "../../runtime/relay-artifact-service.js";
import type { WebActivityEvent } from "../../web/web-state.js";

export interface SlackArtifactRequest {
  contextKey: ChannelContextKey;
  context: ChannelContext;
}

export interface SlackArtifactCommandDeps<TRequest extends SlackArtifactRequest> {
  config: ConnectorConfig;
  runtime: ChannelRuntime;
  artifactService: RelayArtifactService;
  getSession: (request: TRequest, options?: { deferThreadStart?: boolean }) => Promise<AgentSessionService>;
  reply: (request: TRequest, content: string) => Promise<void>;
  appendActivity: (
    request: TRequest,
    input: Partial<Omit<WebActivityEvent, "id" | "timestamp" | "source">> & Pick<WebActivityEvent, "status" | "type"> & { timestamp?: string },
  ) => void;
  getArtifactDeliveryMode?: (request: TRequest) => string | undefined;
  setArtifactDeliveryMode?: (request: TRequest, mode: ArtifactDeliveryMode | null) => Promise<string>;
}

export function createSlackArtifactCommandHandler<TRequest extends SlackArtifactRequest>(
  deps: SlackArtifactCommandDeps<TRequest>,
): (request: TRequest, argument: string) => Promise<void> {
  return async (request, argument) => {
    const session = await deps.getSession(request, { deferThreadStart: true });
    const [action, turnId] = argument.trim().split(/\s+/, 2);
    const tokens = argument.trim().split(/\s+/).filter(Boolean);
    const subcommand = tokens[0]?.toLowerCase();
    const info = session.getInfo();
    const workspace = info.workspace;

    if (subcommand === "quota" || subcommand === "usage") {
      await deps.reply(request, renderArtifactUsageAction(await deps.artifactService.usage(workspace)).plain);
      return;
    }

    if (subcommand === "cleanup") {
      const plan = tokens[1]?.toLowerCase() === "run"
        ? await deps.artifactService.cleanupRun(workspace)
        : await deps.artifactService.cleanupPreview(workspace);
      deps.appendActivity(request, {
        status: "info",
        type: "artifact_cleanup",
        threadId: info.threadId,
        workspace,
        agentId: info.agentId,
        detail: `${plan.candidates.length} candidates, ${plan.removedBytes} bytes`,
      });
      await deps.reply(request, renderArtifactCleanupAction(plan).plain);
      return;
    }

    if (subcommand === "delivery") {
      const requested = tokens[1]?.toLowerCase();
      if (!requested) {
        await deps.reply(request, renderArtifactDeliveryAction(deps.getArtifactDeliveryMode?.(request) ?? deps.config.slackArtifactDeliveryMode, "user").plain);
        return;
      }
      if (requested === "default" || requested === "inherit") {
        const mode = await deps.setArtifactDeliveryMode?.(request, null);
        await deps.reply(request, renderArtifactDeliveryAction(mode ?? deps.config.slackArtifactDeliveryMode, "user").plain);
        return;
      }
      if (!isArtifactDeliveryMode(requested)) {
        await deps.reply(request, `Unknown artifact delivery mode. Use one of: ${ARTIFACT_DELIVERY_MODES.join(", ")}, default.`);
        return;
      }
      const mode = await deps.setArtifactDeliveryMode?.(request, requested);
      await deps.reply(request, renderArtifactDeliveryAction(mode ?? requested, "user").plain);
      return;
    }

    const reports = await listRecentArtifactReports(workspace, 10, deps.config.maxFileSize);
    if (reports.length === 0) {
      await deps.reply(request, "No generated artifacts found for this workspace.");
      return;
    }

    if (action) {
      if (action.toLowerCase() === "delete" && turnId) {
        const selected = findArtifactReport(reports, turnId);
        if (!selected) {
          await deps.reply(request, `No artifact turn found for "${turnId}".`);
          return;
        }
        const removed = await deps.artifactService.delete(workspace, selected.turnId);
        deps.appendActivity(request, {
          status: removed ? "info" : "failed",
          type: "artifact_deleted",
          threadId: info.threadId,
          workspace,
          agentId: info.agentId,
          detail: selected.turnId,
        });
        await deps.reply(request, removed ? `Deleted artifact turn: ${selected.turnId}` : `Artifact turn not found: ${selected.turnId}`);
        return;
      }

      const filtered = filterArtifactReportsForCommand(reports, argument);
      if (filtered) {
        if (filtered.length === 0) {
          await deps.reply(request, `No artifacts matched "${argument}".`);
          return;
        }
        await deliverChannelAction(deps.runtime, request.context, renderSlackArtifactReports(request.contextKey, filtered));
        return;
      }

      const normalizedAction = action.toLowerCase();
      const shouldZip = normalizedAction === "zip";
      const shouldSend = normalizedAction === "send";
      const selected = findArtifactReport(reports, shouldZip || shouldSend ? turnId : action);
      if (!selected) {
        await deps.reply(request, `No artifact turn found for "${argument}".`);
        return;
      }
      deps.appendActivity(request, {
        status: "info",
        type: shouldZip ? "artifact_zip_sent" : "artifacts_sent",
        threadId: info.threadId,
        workspace,
        agentId: info.agentId,
        detail: selected.turnId,
      });
      if (shouldZip) {
        await deliverSlackArtifactZip(deps, request, selected);
      } else {
        await deliverSlackArtifactReport(deps, request, selected);
      }
      return;
    }

    await deliverChannelAction(deps.runtime, request.context, renderSlackArtifactReports(request.contextKey, reports));
  };
}

export async function sendRecentSlackArtifacts<TRequest extends SlackArtifactRequest>(
  deps: SlackArtifactCommandDeps<TRequest>,
  request: TRequest,
  session: AgentSessionService,
  since: Date,
  turnId: string,
  policy: ArtifactDeliveryPolicy = artifactDeliveryPolicy(deps.config.slackAutoSendArtifacts ? "auto-files" : "manual-only"),
): Promise<void> {
  const report = await collectRecentWorkspaceArtifacts(session.getInfo().workspace, {
    since,
    until: new Date(),
    maxFileSize: deps.config.maxFileSize,
    limit: 5,
  });
  if (report.artifacts.length === 0) {
    return;
  }
  const summary = formatArtifactSummary(report.artifacts, report.skippedCount, report.omittedCount);
  if (policy.includeActions) {
    await deliverChannelAction(deps.runtime, request.context, renderSlackArtifactReports(request.contextKey, [{
      turnId,
      outDir: session.getInfo().workspace,
      updatedAt: new Date(),
      artifacts: report.artifacts,
      skippedCount: report.skippedCount,
      omittedCount: report.omittedCount,
      totalSizeBytes: totalArtifactSize(report.artifacts),
      source: "workspace",
    }]));
  } else if (policy.sendSummary && summary) {
    await deps.reply(request, summary);
  }
  if (policy.autoSendZip) {
    const bundle = await createArtifactZipBundle(report.artifacts, session.getInfo().workspace, {
      maxFileSize: deps.config.maxFileSize,
      bundleName: `nordrelay-artifacts-${turnId}.zip`,
    });
    if (bundle) await sendSlackArtifactFile(deps, request, bundle);
  } else if (policy.autoSendFiles) {
    for (const artifact of report.artifacts.filter((item) => !policy.imagesOnly || /\.(png|jpe?g|gif|webp)$/i.test(item.name)).slice(0, 5)) {
      await sendSlackArtifactFile(deps, request, artifact);
    }
  }
  deps.appendActivity(request, {
    status: "info",
    type: "artifacts_sent",
    detail: `${report.artifacts.length} artifacts for ${turnId}`,
    threadId: session.getInfo().threadId,
    workspace: session.getInfo().workspace,
    agentId: session.getInfo().agentId,
  });
}

function renderSlackArtifactReports(contextKey: ChannelContextKey, reports: ArtifactTurnReport[]) {
  const rendered = renderArtifactReportsAction(reports);
  return {
    ...rendered,
    buttons: reports.slice(0, 5).map((report, index) => [
      { label: `${index + 1} Send`, action: `slack_artifact_send:${contextKey}:${report.turnId}` },
      { label: `${index + 1} ZIP`, action: `slack_artifact_zip:${contextKey}:${report.turnId}` },
      { label: `${index + 1} Delete`, action: `slack_artifact_delete:${contextKey}:${report.turnId}` },
    ]),
  };
}

function findArtifactReport(reports: ArtifactTurnReport[], requested: string | undefined): ArtifactTurnReport | undefined {
  const value = requested?.trim();
  if (!value || value.toLowerCase() === "latest") {
    return reports[0];
  }
  return reports.find((report) => report.turnId === value || report.turnId.startsWith(value));
}

async function deliverSlackArtifactZip<TRequest extends SlackArtifactRequest>(
  deps: SlackArtifactCommandDeps<TRequest>,
  request: TRequest,
  report: ArtifactTurnReport,
): Promise<void> {
  const bundle = await createArtifactZipBundle(report.artifacts, report.outDir, {
    maxFileSize: deps.config.maxFileSize,
    bundleName: `nordrelay-artifacts-${report.turnId}.zip`,
  });
  if (!bundle) {
    await deps.reply(request, "Could not create a ZIP bundle for this artifact turn.");
    return;
  }
  if (!deps.runtime.sendFile) {
    await deps.reply(request, "This Slack runtime cannot send artifact files.");
    return;
  }
  await deps.runtime.sendFile(request.context, { localPath: bundle.localPath, name: bundle.name });
  await deps.reply(request, `Sent ZIP artifact bundle: ${bundle.name}`);
}

async function deliverSlackArtifactReport<TRequest extends SlackArtifactRequest>(
  deps: SlackArtifactCommandDeps<TRequest>,
  request: TRequest,
  report: ArtifactTurnReport,
): Promise<void> {
  if (report.artifacts.length === 0 && report.skippedCount === 0 && !report.omittedCount) {
    await deps.reply(request, "No generated artifacts found for this turn.");
    return;
  }
  let failedCount = 0;
  let bundledArtifact: Artifact | null = null;
  if (report.artifacts.length > 5) {
    bundledArtifact = await createArtifactZipBundle(report.artifacts, report.outDir, {
      maxFileSize: deps.config.maxFileSize,
    });
  }
  const delivered = bundledArtifact ? [bundledArtifact] : report.artifacts;
  for (const artifact of delivered) {
    if (!await sendSlackArtifactFile(deps, request, artifact)) {
      failedCount += 1;
    }
  }
  const summary = formatArtifactSummary(report.artifacts, report.skippedCount + failedCount, report.omittedCount);
  if (summary) {
    const bundleNote = bundledArtifact ? `\nSent as ZIP: ${bundledArtifact.name}` : "";
    await deps.reply(request, `${summary}${bundleNote}`);
  }
}

async function sendSlackArtifactFile<TRequest extends SlackArtifactRequest>(
  deps: SlackArtifactCommandDeps<TRequest>,
  request: TRequest,
  artifact: Artifact,
): Promise<boolean> {
  if (!deps.runtime.sendFile) {
    await deps.reply(request, "This Slack runtime cannot send artifact files.");
    return false;
  }
  try {
    await deps.runtime.sendFile(request.context, { localPath: artifact.localPath, name: artifact.name });
    return true;
  } catch (error) {
    console.error(`Failed to send Slack artifact ${artifact.name}:`, error);
    return false;
  }
}
