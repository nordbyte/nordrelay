import type { Bot, Context } from "grammy";

import type { BotPreferencesStore } from "../../state/bot-preferences.js";
import {
  capabilitiesOf,
  labelOf,
} from "../shared/bot-rendering.js";
import type { ChannelCommandService } from "../shared/channel-command-service.js";
import type { ConnectorConfig } from "../../core/config.js";
import type { TelegramContextKey } from "../shared/context-key.js";
import { escapeHTML } from "../../core/format.js";
import { renderTargetPeerMirrorPreference, type RemotePeerWebClient } from "../shared/channel-peer-sessions.js";
import {
  evaluateWorkspacePolicy,
  filterAllowedWorkspaces,
  renderWorkspacePolicyLine,
} from "../../core/workspace-policy.js";
import type { GetTelegramContextSession } from "./telegram-command-types.js";
import { safeReply } from "./telegram-output.js";

export interface TelegramPreferenceCommandOptions {
  bot: Bot<Context>;
  config: ConnectorConfig;
  commandService: ChannelCommandService;
  preferencesStore: BotPreferencesStore;
  getContextSession: GetTelegramContextSession;
  remoteClient?: RemotePeerWebClient;
  onMirrorChanged?: (contextKey: TelegramContextKey) => void;
}

export function registerTelegramPreferenceCommands(options: TelegramPreferenceCommandOptions): void {
  options.bot.command("mirror", async (ctx) => {
    const contextSession = await options.getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }
    const { contextKey, session } = contextSession;
    const argument = (ctx.message?.text ?? "").replace(/^\/mirror(?:@\w+)?\s*/i, "").trim();
    const remoteResponse = await renderTargetPeerMirrorPreference({
      source: "telegram",
      contextKey,
      argument,
      preferencesStore: options.preferencesStore,
      remoteClient: options.remoteClient,
    }).catch(async (error) => {
      const text = `Remote mirror failed: ${error instanceof Error ? error.message : String(error)}`;
      await safeReply(ctx, escapeHTML(text), { fallbackText: text });
      return null;
    });
    if (remoteResponse) {
      await safeReply(ctx, remoteResponse.response.html, { fallbackText: remoteResponse.response.plain });
      options.onMirrorChanged?.(contextKey);
      return;
    }
    if (!capabilitiesOf(session.getInfo()).cliMirror) {
      const text = `CLI mirroring is not supported for ${labelOf(session.getInfo())} yet.`;
      await safeReply(ctx, escapeHTML(text), { fallbackText: text });
      return;
    }
    const response = options.commandService.renderMirrorPreference({
      source: "telegram",
      contextKey,
      argument,
      preferencesStore: options.preferencesStore,
      cliMirrorSupported: capabilitiesOf(session.getInfo()).cliMirror,
      agentLabel: labelOf(session.getInfo()),
    });
    await safeReply(ctx, response.html, { fallbackText: response.plain });
    options.onMirrorChanged?.(contextKey);
  });

  options.bot.command("notify", async (ctx) => {
    const contextSession = await options.getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }
    const { contextKey } = contextSession;
    const argument = (ctx.message?.text ?? "").replace(/^\/notify(?:@\w+)?\s*/i, "").trim();
    const response = options.commandService.renderNotifyPreference({
      source: "telegram",
      contextKey,
      argument,
      preferencesStore: options.preferencesStore,
    });
    await safeReply(ctx, response.html, { fallbackText: response.plain });
  });

  options.bot.command("workspaces", async (ctx) => {
    const contextSession = await options.getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }
    const { session } = contextSession;
    const agentName = labelOf(session.getInfo());
    const workspaces = filterAllowedWorkspaces(session.listWorkspaces(), options.config);
    const currentWorkspace = session.getInfo().workspace;
    const lines = workspaces.slice(0, 20).map((workspace, index) => {
      const prefix = workspace === currentWorkspace ? "*" : `${index + 1}.`;
      const policy = renderWorkspacePolicyLine(workspace, options.config);
      return `${prefix} ${workspace}${policy ? ` (${policy})` : ""}`;
    });
    const currentPolicy = evaluateWorkspacePolicy(currentWorkspace, options.config);
    const header = [
      "Workspaces:",
      `Current: ${currentWorkspace}`,
      currentPolicy.warning ? `Current warning: ${currentPolicy.warning}` : undefined,
      options.config.workspaceAllowedRoots.length > 0 ? `Allowed roots: ${options.config.workspaceAllowedRoots.join(", ")}` : "Allowed roots: unrestricted",
      "",
    ].filter((line): line is string => Boolean(line));
    const plain = [...header, ...(lines.length > 0 ? lines : [`No workspaces found in ${agentName} state.`])].join("\n");
    const html = [
      "<b>Workspaces:</b>",
      `<b>Current:</b> <code>${escapeHTML(currentWorkspace)}</code>`,
      currentPolicy.warning ? `<b>Current warning:</b> <code>${escapeHTML(currentPolicy.warning)}</code>` : undefined,
      `<b>Allowed roots:</b> <code>${escapeHTML(options.config.workspaceAllowedRoots.length > 0 ? options.config.workspaceAllowedRoots.join(", ") : "unrestricted")}</code>`,
      "",
      ...(lines.length > 0 ? lines.map((line) => `<code>${escapeHTML(line)}</code>`) : [`<code>No workspaces found in ${escapeHTML(agentName)} state.</code>`]),
    ].filter((line): line is string => Boolean(line)).join("\n");
    await safeReply(ctx, html, { fallbackText: plain });
  });

  options.bot.command("voice", async (ctx) => {
    if (!ctx.chat) {
      return;
    }

    const contextSession = await options.getContextSession(ctx, { deferThreadStart: true });
    if (!contextSession) {
      return;
    }
    const { contextKey } = contextSession;
    const argument = (ctx.message?.text ?? "").replace(/^\/voice(?:@\w+)?\s*/i, "").trim();
    const response = await options.commandService.renderVoicePreference({
      source: "telegram",
      contextKey,
      argument,
      preferencesStore: options.preferencesStore,
    });
    await safeReply(ctx, response.html, { fallbackText: response.plain });
  });
}
