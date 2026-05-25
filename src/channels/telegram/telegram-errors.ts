import type { Bot } from "grammy";

export function registerTelegramErrorHandler(bot: Bot): void {
  bot.catch((error) => {
    const message = error.error instanceof Error ? error.error.message : String(error.error);
    console.error("Telegram bot error:", message);
  });
}
