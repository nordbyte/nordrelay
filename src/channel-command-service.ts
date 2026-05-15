import { listAgentAdapterDescriptors } from "./agent-adapter.js";
import type { AgentActivityEvent, AgentHandbackResult, AgentId, AgentSessionInfo } from "./agent.js";
import { enabledAgents } from "./agent-factory.js";
import type { AuditEvent } from "./audit-log.js";
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
  renderActivityTimeline,
  renderAuditEvents,
  renderProgressHTML,
  renderProgressPlain,
  renderVersionCheckHTML,
  renderVersionCheckPlain,
  type ActivityOptions,
  type BusyState,
  type TurnProgress,
} from "./bot-rendering.js";
import { renderSessionInfoHTML, renderSessionInfoPlain } from "./session-format.js";

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

  renderAuthStatus(status: { label: string; authenticated: boolean; method?: string; detail: string }): ChannelActionResponse {
    const icon = status.authenticated ? "✅" : "❌";
    return {
      plain: [
        `${icon} ${status.label} auth: ${status.authenticated ? "authenticated" : "not authenticated"}`,
        `Method: ${status.method ?? "-"}`,
        `Detail: ${status.detail}`,
      ].join("\n"),
      html: [
        `<b>${icon} ${escapeHTML(status.label)} auth:</b> <code>${status.authenticated ? "authenticated" : "not authenticated"}</code>`,
        `<b>Method:</b> <code>${escapeHTML(status.method ?? "-")}</code>`,
        `<b>Detail:</b> <code>${escapeHTML(status.detail)}</code>`,
      ].join("\n"),
    };
  }

  renderAuthActionResult(action: "login" | "logout", result: { success: boolean; message: string }): ChannelActionResponse {
    const label = action === "login" ? "Login" : "Logout";
    const icon = result.success ? "✅" : "❌";
    return {
      plain: [`${icon} ${label} ${result.success ? "started" : "failed"}.`, "", result.message].join("\n"),
      html: [`<b>${icon} ${escapeHTML(label)} ${result.success ? "started" : "failed"}.</b>`, "", `<code>${escapeHTML(result.message)}</code>`].join("\n"),
    };
  }

  renderHostAuthInstruction(label: string, command: string, action: "login" | "logout"): ChannelActionResponse {
    const text = `${label} ${action} is not managed remotely. Run this on the host: ${command}`;
    return {
      plain: text,
      html: `<b>${escapeHTML(label)} ${escapeHTML(action)} is not managed remotely.</b>\nRun this on the host:\n<code>${escapeHTML(command)}</code>`,
    };
  }

  renderProgress(progress: TurnProgress | undefined, queueLength: number, busyState: BusyState, info: AgentSessionInfo): ChannelActionResponse {
    return {
      plain: renderProgressPlain(progress, queueLength, busyState, info),
      html: renderProgressHTML(progress, queueLength, busyState, info),
    };
  }

  renderActivity(threadId: string, events: AgentActivityEvent[], options: ActivityOptions): ChannelActionResponse {
    return renderActivityTimeline(threadId, events, options);
  }

  renderAudit(events: AuditEvent[]): ChannelActionResponse {
    return renderAuditEvents(events);
  }

  renderWorkspaces(info: AgentSessionInfo, workspaces: string[]): ChannelActionResponse {
    const unique = [...new Set(workspaces)].filter(Boolean);
    const rows = unique.length > 0
      ? unique.map((workspace, index) => `${index + 1}. ${workspace}${workspace === info.workspace ? " (current)" : ""}`)
      : [`No workspaces found in ${info.agentLabel} state.`];
    return {
      plain: [`${info.agentLabel} workspaces:`, ...rows].join("\n"),
      html: [
        `<b>${escapeHTML(info.agentLabel)} workspaces:</b>`,
        ...rows.map((line) => `<code>${escapeHTML(line)}</code>`),
      ].join("\n"),
    };
  }

  renderHandback(result: AgentHandbackResult): ChannelActionResponse {
    const command = result.command ?? (result.threadId
      ? `cd ${shellEscape(result.workspace)} && codex resume ${shellEscape(result.threadId)}`
      : "");
    if (!result.threadId || !command) {
      const text = "This thread has not started yet, so there is no resumable thread ID. Send a message to create one, or start a new session.";
      return { plain: text, html: escapeHTML(text) };
    }
    const label = result.label ?? "Agent CLI";
    return {
      plain: [
        `Thread handed back to ${label}.`,
        "",
        "Run this in your terminal:",
        command,
        "",
        "Send any message here to start a new NordRelay thread.",
      ].join("\n"),
      html: [
        `<b>Thread handed back to ${escapeHTML(label)}.</b>`,
        "",
        "Run this in your terminal:",
        `<pre>${escapeHTML(command)}</pre>`,
        "",
        "Send any message here to start a new NordRelay thread.",
      ].join("\n"),
    };
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

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
