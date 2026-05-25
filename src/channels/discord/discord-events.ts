import { Events, type Client, type Interaction, type Message } from "discord.js";

export interface DiscordBridgeEventHandlers {
  handleMessage(message: Message): Promise<void>;
  handleInteraction(interaction: Interaction): Promise<void>;
  handleReady(tag: string): Promise<void>;
}

export function registerDiscordBridgeEvents(client: Client, handlers: DiscordBridgeEventHandlers): void {
  client.on(Events.MessageCreate, (message) => {
    void handlers.handleMessage(message).catch((error) => {
      console.error("Discord message handling failed:", error);
    });
  });
  client.on(Events.InteractionCreate, (interaction) => {
    void handlers.handleInteraction(interaction).catch((error) => {
      console.error("Discord interaction handling failed:", error);
    });
  });
  client.once(Events.ClientReady, (readyClient) => {
    void handlers.handleReady(readyClient.user.tag).catch((error) => {
      console.error("Discord ready handling failed:", error);
    });
  });
}
