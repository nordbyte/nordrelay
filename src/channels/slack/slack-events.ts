import type { ConnectorConfig } from "../../core/config.js";
import type { SlackMessageEvent } from "./slack-request-context.js";
import type { SlackBoltApp, SlackSlashCommandPayload } from "./slack-types.js";

export interface SlackBridgeActionEvent {
  action: { action_id?: string };
  body: unknown;
  respond(message: unknown): Promise<unknown>;
}

export interface SlackBridgeEventHandlers {
  handleMessage(event: SlackMessageEvent): Promise<void>;
  handleSlashCommand(command: SlackSlashCommandPayload, respond: (message: unknown) => Promise<unknown>): Promise<void>;
  handleAction(event: SlackBridgeActionEvent): Promise<void>;
}

export function registerSlackBridgeEvents(app: SlackBoltApp, config: ConnectorConfig, handlers: SlackBridgeEventHandlers): void {
  app.event("message", async ({ event }) => {
    await handlers.handleMessage(event as SlackMessageEvent);
  });
  app.event("app_mention", async ({ event }) => {
    await handlers.handleMessage(event as SlackMessageEvent);
  });
  app.command(config.slackCommand, async ({ command, ack, respond }) => {
    await ack();
    await handlers.handleSlashCommand(command as SlackSlashCommandPayload, respond);
  });
  app.action(/^nr:/, async ({ action, body, ack, respond }) => {
    await ack();
    await handlers.handleAction({ action, body, respond });
  });
}
