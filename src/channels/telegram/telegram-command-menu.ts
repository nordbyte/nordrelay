import type { Bot, Context } from "grammy";

import { telegramCommandCatalog } from "../shared/channel-command-catalog.js";

export const TELEGRAM_COMMANDS = telegramCommandCatalog();

export async function registerCommands(bot: Bot<Context>): Promise<void> {
  await bot.api.setMyCommands([...TELEGRAM_COMMANDS]);
}
