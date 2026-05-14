import { listAgentAdapterDescriptors } from "./agent-adapter.js";
import type { AgentId } from "./agent.js";
import { enabledAgents } from "./agent-factory.js";
import {
  logTailRequests,
  parseLogsCommand,
  renderAgentsAction,
  renderChannelsAction,
  renderLogTailsAction,
  type ChannelActionResponse,
} from "./channel-actions.js";
import { listChannelDescriptors } from "./channel-adapter.js";
import type { ConnectorConfig } from "./config.js";
import { escapeHTML } from "./format.js";
import {
  getConnectorHealth,
  getVersionChecks,
  readConnectorState,
  readFormattedLogTail,
} from "./operations.js";
import {
  formatCliPathHTML,
  formatCliPathPlain,
  renderVersionCheckHTML,
  renderVersionCheckPlain,
} from "./bot-rendering.js";

export class ChannelCommandService {
  constructor(private readonly config: ConnectorConfig) {}

  renderChannels(): ChannelActionResponse {
    return renderChannelsAction(listChannelDescriptors());
  }

  renderAgents(agentIds: AgentId[] = enabledAgents(this.config)): ChannelActionResponse {
    return renderAgentsAction(listAgentAdapterDescriptors(), agentIds);
  }

  async renderLogs(argument: string): Promise<ChannelActionResponse> {
    const logRequest = parseLogsCommand(argument);
    const logs = await Promise.all(logTailRequests(logRequest.target).map(async (request) => ({
      title: request.title,
      tail: await readFormattedLogTail(logRequest.lines, request.path),
    })));
    return renderLogTailsAction(logs);
  }

  async renderVersion(): Promise<ChannelActionResponse> {
    const health = await getConnectorHealth(cliPathOptions(this.config));
    const state = await readConnectorState();
    const versions = await getVersionChecks(cliPathOptions(this.config));
    const plain = [
      renderVersionCheckPlain(versions.nordrelay),
      `Runtime status: ${state.status ?? "unknown"}`,
      formatCliPathPlain("Codex CLI", health.codexCliPath, health.codexCli),
      renderVersionCheckPlain(versions.codex),
      formatCliPathPlain("Pi CLI", health.piCliPath, health.piCli),
      renderVersionCheckPlain(versions.pi),
      formatCliPathPlain("Hermes CLI", health.hermesCliPath, health.hermesCli),
      renderVersionCheckPlain(versions.hermes),
      formatCliPathPlain("OpenClaw CLI", health.openClawCliPath, health.openClawCli),
      renderVersionCheckPlain(versions.openclaw),
      formatCliPathPlain("Claude Code CLI", health.claudeCodeCliPath, health.claudeCodeCli),
      renderVersionCheckPlain(versions.claudeCode),
    ].join("\n");
    const html = [
      renderVersionCheckHTML(versions.nordrelay),
      `<b>Runtime status:</b> <code>${escapeHTML(state.status ?? "unknown")}</code>`,
      formatCliPathHTML("Codex CLI", health.codexCliPath, health.codexCli),
      renderVersionCheckHTML(versions.codex),
      formatCliPathHTML("Pi CLI", health.piCliPath, health.piCli),
      renderVersionCheckHTML(versions.pi),
      formatCliPathHTML("Hermes CLI", health.hermesCliPath, health.hermesCli),
      renderVersionCheckHTML(versions.hermes),
      formatCliPathHTML("OpenClaw CLI", health.openClawCliPath, health.openClawCli),
      renderVersionCheckHTML(versions.openclaw),
      formatCliPathHTML("Claude Code CLI", health.claudeCodeCliPath, health.claudeCodeCli),
      renderVersionCheckHTML(versions.claudeCode),
    ].join("\n");
    return { plain, html };
  }
}

export function cliPathOptions(config: ConnectorConfig): {
  piCliPath?: string;
  hermesCliPath?: string;
  openClawCliPath?: string;
  claudeCodeCliPath?: string;
} {
  return {
    piCliPath: config.piCliPath,
    hermesCliPath: config.hermesCliPath,
    openClawCliPath: config.openClawCliPath,
    claudeCodeCliPath: config.claudeCodeCliPath,
  };
}
