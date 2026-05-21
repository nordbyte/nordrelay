import { readFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();

const budgets = [
  { file: "src/runtime/relay-runtime.ts", maxLines: 850 },
  { file: "src/runtime/relay-runtime-active-sessions.ts", maxLines: 650 },
  { file: "src/runtime/relay-runtime-dashboard.ts", maxLines: 400 },
  { file: "src/runtime/relay-runtime-prompt-queue-artifacts.ts", maxLines: 550 },
  { file: "src/runtime/relay-runtime-sessions.ts", maxLines: 900 },
  { file: "src/runtime/relay-runtime-updates-jobs.ts", maxLines: 600 },
  { file: "src/runtime/relay-runtime-delegate.ts", maxLines: 260 },
  { file: "src/state/workflow-store.ts", maxLines: 1120 },
  { file: "src/web/web-dashboard.ts", maxLines: 1100 },
  { file: "src/channels/shared/channel-cli-artifacts.ts", maxLines: 120 },
  { file: "src/channels/shared/channel-external-mirror-controller.ts", maxLines: 360 },
  { file: "src/channels/shared/channel-attachments.ts", maxLines: 80 },
  { file: "src/channels/discord/discord-bot.ts", maxLines: 1780 },
  { file: "src/channels/discord/discord-types.ts", maxLines: 120 },
  { file: "src/channels/slack/slack-bot.ts", maxLines: 1500 },
  { file: "src/channels/slack/slack-types.ts", maxLines: 140 },
  { file: "src/channels/telegram/bot.ts", maxLines: 4060 },
  { file: "src/channels/telegram/telegram-runtime-types.ts", maxLines: 140 },
  { file: "plugins/nordrelay/scripts/nordrelay.mjs", maxLines: 2900 },
];

const failures = [];

for (const budget of budgets) {
  const filePath = path.join(root, budget.file);
  const lines = readFileSync(filePath, "utf8").split(/\r?\n/).length;
  if (lines > budget.maxLines) {
    failures.push(`${budget.file}: ${lines} lines exceeds ${budget.maxLines}`);
  }
}

if (failures.length > 0) {
  console.error("Module size budget exceeded:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(`Module size check passed (${budgets.length} budgets).`);
