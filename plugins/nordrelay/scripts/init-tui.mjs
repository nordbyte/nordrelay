import { ask, askChoice, askSecret } from "./prompt-utils.mjs";
import { tuiStyle } from "./tui-style.mjs";

let initRenderLineCount = 0;

export async function collectInitConfig(options) {
  const values = initialInitConfig(options);
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return await collectSequentialInitConfig(options);
  }
  return await runInitTui(values);
}

function initialInitConfig(options) {
  return normalizeInitConfig({
    enableWebui: options.disableWebui ? "false" : "true",
    enableAutostart: options.disableAutostart ? "false" : "true",
    enableWebuiAutostart: options.disableWebui || options.disableWebuiAutostart ? "false" : "true",
    enableTelegram: options.disableTelegram ? "false" : options.telegramBotToken ? "true" : "false",
    telegramBotToken: options.telegramBotToken || process.env.TELEGRAM_BOT_TOKEN || "",
    enableDiscord: options.enableDiscord ? "true" : "false",
    discordBotToken: options.discordBotToken || process.env.DISCORD_BOT_TOKEN || "",
    discordClientId: options.discordClientId || process.env.DISCORD_CLIENT_ID || "",
    enableSlack: options.enableSlack ? "true" : "false",
    slackBotToken: options.slackBotToken || process.env.SLACK_BOT_TOKEN || "",
    slackAppToken: options.slackAppToken || process.env.SLACK_APP_TOKEN || "",
    slackSigningSecret: options.slackSigningSecret || process.env.SLACK_SIGNING_SECRET || "",
    enableMatrix: options.enableMatrix ? "true" : "false",
    matrixHomeserverUrl: options.matrixHomeserverUrl || process.env.MATRIX_HOMESERVER_URL || "",
    matrixAccessToken: options.matrixAccessToken || process.env.MATRIX_ACCESS_TOKEN || "",
    matrixUserId: options.matrixUserId || process.env.MATRIX_USER_ID || "",
    matrixDeviceId: options.matrixDeviceId || process.env.MATRIX_DEVICE_ID || "",
    adminEmail: options.adminEmail || "",
    adminName: options.adminName || "Admin",
    adminPassword: options.adminPassword || "",
    telegramUserId: options.telegramUserId || "",
    discordUserId: options.discordUserId || "",
    slackUserId: options.slackUserId || "",
    slackTeamId: options.slackTeamId || "",
    linkedMatrixUserId: options.matrixLinkedUserId || "",
    linkedMatrixHomeserver: options.matrixLinkedHomeserver || "",
    enableCodex: options.disableCodex ? "false" : "true",
    enablePi: options.enablePi ? "true" : "false",
    enableHermes: options.enableHermes ? "true" : "false",
    enableOpenClaw: options.enableOpenClaw ? "true" : "false",
    enableClaudeCode: options.enableClaudeCode ? "true" : "false",
    stateBackend: options.stateBackend || "json",
  });
}

async function collectSequentialInitConfig(options) {
  const enableWebui = options.disableWebui ? "false" : await askChoice(null, "Enable WebUI", "true");
  const enableAutostart = options.disableAutostart ? "false" : await askChoice(null, "Enable NordRelay autostart", "true");
  const enableWebuiAutostart = enableWebui === "true"
    ? (options.disableWebuiAutostart ? "false" : await askChoice(null, "Enable WebUI autostart", "true"))
    : "false";
  const enableTelegram = options.disableTelegram ? "false" : await askChoice(null, "Enable Telegram", options.telegramBotToken ? "true" : "false");
  const telegramBotToken = enableTelegram === "true"
    ? options.telegramBotToken || process.env.TELEGRAM_BOT_TOKEN || await ask(null, "Telegram bot token", "")
    : "";
  const enableDiscord = options.enableDiscord ? "true" : await askChoice(null, "Enable Discord", "false");
  const discordBotToken = enableDiscord === "true"
    ? options.discordBotToken || process.env.DISCORD_BOT_TOKEN || await ask(null, "Discord bot token", "")
    : "";
  const discordClientId = enableDiscord === "true"
    ? options.discordClientId || process.env.DISCORD_CLIENT_ID || await ask(null, "Discord client ID", "")
    : "";
  const enableSlack = options.enableSlack ? "true" : await askChoice(null, "Enable Slack", "false");
  const slackBotToken = enableSlack === "true"
    ? options.slackBotToken || process.env.SLACK_BOT_TOKEN || await ask(null, "Slack bot token", "")
    : "";
  const slackAppToken = enableSlack === "true"
    ? options.slackAppToken || process.env.SLACK_APP_TOKEN || await ask(null, "Slack app-level token for Socket Mode", "")
    : "";
  const slackSigningSecret = enableSlack === "true"
    ? options.slackSigningSecret || process.env.SLACK_SIGNING_SECRET || await ask(null, "Slack signing secret (optional for Socket Mode)", "")
    : "";
  const enableMatrix = options.enableMatrix ? "true" : await askChoice(null, "Enable Matrix", "false");
  const matrixHomeserverUrl = enableMatrix === "true"
    ? options.matrixHomeserverUrl || process.env.MATRIX_HOMESERVER_URL || await ask(null, "Matrix homeserver URL", "")
    : "";
  const matrixAccessToken = enableMatrix === "true"
    ? options.matrixAccessToken || process.env.MATRIX_ACCESS_TOKEN || await ask(null, "Matrix access token", "")
    : "";
  const matrixUserId = enableMatrix === "true"
    ? options.matrixUserId || process.env.MATRIX_USER_ID || await ask(null, "Matrix bot user ID", "")
    : "";
  const matrixDeviceId = enableMatrix === "true"
    ? options.matrixDeviceId || process.env.MATRIX_DEVICE_ID || await ask(null, "Matrix device ID (optional)", "")
    : "";
  const adminEmail = options.adminEmail || await ask(null, "Admin email", "");
  const adminName = options.adminName || await ask(null, "Admin name", "Admin");
  const adminPassword = options.adminPassword || await askSecret(null, "Admin password", "");
  const telegramUserId = options.telegramUserId || await ask(null, "Optional Telegram user id to link", "");
  const discordUserId = options.discordUserId || await ask(null, "Optional Discord user id to link", "");
  const slackUserId = options.slackUserId || await ask(null, "Optional Slack user id to link", "");
  const slackTeamId = slackUserId ? (options.slackTeamId || await ask(null, "Optional Slack team id for linked user", "")) : "";
  const linkedMatrixUserId = options.matrixLinkedUserId || await ask(null, "Optional Matrix user id to link", "");
  const linkedMatrixHomeserver = linkedMatrixUserId ? (options.matrixLinkedHomeserver || await ask(null, "Optional Matrix homeserver for linked user", "")) : "";
  const enableCodex = options.disableCodex ? "false" : await askChoice(null, "Enable Codex", "true");
  const enablePi = options.enablePi ? "true" : await askChoice(null, "Enable Pi", "false");
  const enableHermes = options.enableHermes ? "true" : await askChoice(null, "Enable Hermes", "false");
  const enableOpenClaw = options.enableOpenClaw ? "true" : await askChoice(null, "Enable OpenClaw", "false");
  const enableClaudeCode = options.enableClaudeCode ? "true" : await askChoice(null, "Enable Claude Code", "false");
  const stateBackend = options.stateBackend || await askChoice(null, "State backend (json/sqlite)", "json");
  return normalizeInitConfig({
    enableWebui,
    enableAutostart,
    enableWebuiAutostart,
    enableTelegram,
    telegramBotToken,
    enableDiscord,
    discordBotToken,
    discordClientId,
    enableSlack,
    slackBotToken,
    slackAppToken,
    slackSigningSecret,
    enableMatrix,
    matrixHomeserverUrl,
    matrixAccessToken,
    matrixUserId,
    matrixDeviceId,
    adminEmail,
    adminName,
    adminPassword,
    telegramUserId,
    discordUserId,
    slackUserId,
    slackTeamId,
    linkedMatrixUserId,
    linkedMatrixHomeserver,
    enableCodex,
    enablePi,
    enableHermes,
    enableOpenClaw,
    enableClaudeCode,
    stateBackend,
  });
}

async function runInitTui(values) {
  let selected = 0;
  let message = "Use Up/Down to select, Enter to edit, Space to toggle, s to save, q to cancel.";
  while (true) {
    const rows = initTuiRows(values);
    selected = clampInitSelection(rows, selected);
    renderInitTui(rows, selected, message);
    const key = await readInitKey();
    if (key === "ctrl-c" || key === "q") {
      process.stdout.write("\x1b[?25h\n");
      throw new Error("Init cancelled.");
    }
    if (key === "up") {
      selected = moveInitSelection(rows, selected, -1);
      continue;
    }
    if (key === "down") {
      selected = moveInitSelection(rows, selected, 1);
      continue;
    }
    if (key === "s") {
      const errors = validateInitConfig(values);
      if (errors.length) {
        message = errors.join("\n");
        selected = firstInvalidInitSelection(rows, values) ?? selected;
        continue;
      }
      process.stdout.write("\x1b[2J\x1b[H\x1b[?25h");
      return normalizeInitConfig(values);
    }
    const row = rows[selected];
    if (!row?.selectable) {
      continue;
    }
    if (row.action === "save") {
      const errors = validateInitConfig(values);
      if (errors.length) {
        message = errors.join("\n");
        selected = firstInvalidInitSelection(rows, values) ?? selected;
        continue;
      }
      process.stdout.write("\x1b[2J\x1b[H\x1b[?25h");
      return normalizeInitConfig(values);
    }
    if (row.action === "cancel") {
      process.stdout.write("\x1b[?25h\n");
      throw new Error("Init cancelled.");
    }
    if ((key === "enter" || key === "space") && row.field) {
      await editInitField(values, row.field, key);
      values = normalizeInitConfig(values);
      message = "Updated. Use s to save or select another field to revise it.";
    }
  }
}

export function initTuiRows(values) {
  const fields = initFieldDefinitions(values);
  const rows = [];
  for (const field of fields) {
    if (field.section) {
      rows.push({ type: "section", label: field.section, selectable: false });
      continue;
    }
    rows.push({
      type: "field",
      label: field.label,
      selectable: true,
      field,
      value: initFieldDisplay(values, field),
      hint: field.hint,
    });
  }
  rows.push({ type: "section", label: "Finish", selectable: false });
  rows.push({ type: "action", label: "Save config and create admin", value: "writes nordrelay.env", selectable: true, action: "save" });
  rows.push({ type: "action", label: "Cancel init", value: "no files written", selectable: true, action: "cancel" });
  return rows;
}

function initFieldDefinitions(values) {
  return [
    { section: "Access surfaces" },
    { key: "enableWebui", label: "WebUI enabled", type: "bool", hint: "Login-protected dashboard." },
    { key: "enableAutostart", label: "NordRelay autostart", type: "bool", hint: "Start connector at system boot." },
    { key: "enableWebuiAutostart", label: "WebUI autostart", type: "bool", hint: "Start dashboard at system boot." },
    { section: "Telegram" },
    { key: "enableTelegram", label: "Telegram enabled", type: "bool" },
    { key: "telegramBotToken", label: "Telegram bot token", type: "secret", dependsOn: "enableTelegram" },
    { key: "telegramUserId", label: "Link Telegram user ID", type: "text", dependsOn: "enableTelegram" },
    { section: "Discord" },
    { key: "enableDiscord", label: "Discord enabled", type: "bool" },
    { key: "discordBotToken", label: "Discord bot token", type: "secret", dependsOn: "enableDiscord" },
    { key: "discordClientId", label: "Discord client ID", type: "text", dependsOn: "enableDiscord" },
    { key: "discordUserId", label: "Link Discord user ID", type: "text", dependsOn: "enableDiscord" },
    { section: "Slack" },
    { key: "enableSlack", label: "Slack enabled", type: "bool" },
    { key: "slackBotToken", label: "Slack bot token", type: "secret", dependsOn: "enableSlack" },
    { key: "slackAppToken", label: "Slack app-level token", type: "secret", dependsOn: "enableSlack" },
    { key: "slackSigningSecret", label: "Slack signing secret", type: "secret", dependsOn: "enableSlack" },
    { key: "slackUserId", label: "Link Slack user ID", type: "text", dependsOn: "enableSlack" },
    { key: "slackTeamId", label: "Link Slack team ID", type: "text", dependsOn: "enableSlack" },
    { section: "Matrix" },
    { key: "enableMatrix", label: "Matrix enabled", type: "bool" },
    { key: "matrixHomeserverUrl", label: "Matrix homeserver URL", type: "text", dependsOn: "enableMatrix" },
    { key: "matrixAccessToken", label: "Matrix access token", type: "secret", dependsOn: "enableMatrix" },
    { key: "matrixUserId", label: "Matrix bot user ID", type: "text", dependsOn: "enableMatrix" },
    { key: "matrixDeviceId", label: "Matrix device ID", type: "text", dependsOn: "enableMatrix" },
    { key: "linkedMatrixUserId", label: "Link Matrix user ID", type: "text", dependsOn: "enableMatrix" },
    { key: "linkedMatrixHomeserver", label: "Link Matrix homeserver", type: "text", dependsOn: "enableMatrix" },
    { section: "Admin user" },
    { key: "adminEmail", label: "Admin email", type: "text" },
    { key: "adminName", label: "Admin name", type: "text" },
    { key: "adminPassword", label: "Admin password", type: "secret" },
    { section: "Agents" },
    { key: "enableCodex", label: "Codex enabled", type: "bool" },
    { key: "enablePi", label: "Pi enabled", type: "bool" },
    { key: "enableHermes", label: "Hermes enabled", type: "bool" },
    { key: "enableOpenClaw", label: "OpenClaw enabled", type: "bool" },
    { key: "enableClaudeCode", label: "Claude Code enabled", type: "bool" },
    { section: "Storage" },
    { key: "stateBackend", label: "State backend", type: "enum", choices: ["json", "sqlite"] },
  ].filter((field) => initFieldVisible(values, field));
}

function initFieldVisible(values, field) {
  return !field.dependsOn || values[field.dependsOn] === "true";
}

function renderInitTui(rows, selected, message) {
  const width = Math.max(80, process.stdout.columns || 100);
  const height = Math.max(20, process.stdout.rows || 32);
  const listHeight = Math.max(8, height - 8);
  const first = initViewportStart(rows, selected, listHeight);
  const visible = rows.slice(first, first + listHeight);
  const lines = [
    initStyle("title", "NordRelay init"),
    initStyle("help", "Configure all setup options below. Existing answers can be selected again and changed before saving."),
    initStyle("help", "Keys: Up/Down select | Enter edit | Space toggle booleans | s save | q cancel"),
    initStyle("rule", "-".repeat(Math.min(width, 120))),
  ];
  for (let index = 0; index < visible.length; index += 1) {
    const rowIndex = first + index;
    const row = visible[index];
    if (row.type === "section") {
      lines.push("", initStyle("section", row.label));
      continue;
    }
    const isSelected = rowIndex === selected;
    const pointer = initStyle(isSelected ? "selectedPointer" : "pointer", isSelected ? ">" : " ");
    const label = initStyle(isSelected ? "selectedLabel" : "label", String(row.label).padEnd(28, " "));
    const value = initStyledRowValue(row);
    lines.push(`${pointer} ${label} ${value}`);
    if (rowIndex === selected && row.hint) {
      lines.push(`  ${"".padEnd(28, " ")} ${initStyle("hint", row.hint)}`);
      lines.push("");
    }
  }
  if (rows.length > listHeight) {
    const from = first + 1;
    const to = Math.min(rows.length, first + listHeight);
    lines.push("", `Showing ${from}-${to} of ${rows.length}`);
  }
  const errors = String(message || "").split("\n").filter(Boolean).slice(0, 5);
  if (errors.length) {
    const level = errors.some((line) => /required|must|At least|missing/i.test(line)) ? "error" : "success";
    lines.push("", ...errors.map((line) => initStyle(level, `! ${line}`)));
  }
  renderInitScreen(lines);
}

function renderInitScreen(lines) {
  const lineCount = Math.max(lines.length, initRenderLineCount);
  const output = ["\x1b[?25l\x1b[H"];
  for (let index = 0; index < lineCount; index += 1) {
    output.push("\x1b[2K", lines[index] ?? "");
    if (index < lineCount - 1) output.push("\n");
  }
  initRenderLineCount = lines.length;
  process.stdout.write(`${output.join("")}\x1b[J`);
}

function initViewportStart(rows, selected, listHeight) {
  const maxStart = Math.max(0, rows.length - listHeight);
  const desired = selected - Math.floor(listHeight / 2);
  return Math.max(0, Math.min(maxStart, desired));
}

function clampInitSelection(rows, selected) {
  if (rows[selected]?.selectable) return selected;
  return moveInitSelection(rows, Math.max(0, Math.min(rows.length - 1, selected)), 1);
}

function moveInitSelection(rows, selected, direction) {
  if (!rows.length) return 0;
  let index = selected;
  for (let step = 0; step < rows.length; step += 1) {
    index = (index + direction + rows.length) % rows.length;
    if (rows[index]?.selectable) return index;
  }
  return selected;
}

async function editInitField(values, field, key) {
  if (field.type === "bool") {
    values[field.key] = values[field.key] === "true" ? "false" : "true";
    return;
  }
  if (field.type === "enum") {
    values[field.key] = await selectInitOption(field.label, field.choices, values[field.key]);
    return;
  }
  if (key === "space") {
    return;
  }
  process.stdout.write("\x1b[2J\x1b[H\x1b[?25h");
  console.log(initStyle("title", `Edit ${field.label}`));
  console.log(initStyle("help", "Press Enter to keep the current value. Enter - to clear an optional value.") + "\n");
  const current = values[field.key] || "";
  const next = field.type === "secret"
    ? await askSecret(null, `${field.label} (hidden)`, current)
    : await ask(null, field.label, current);
  values[field.key] = next === "-" ? "" : next;
}

async function selectInitOption(label, choices, current) {
  let selected = Math.max(0, choices.indexOf(current));
  let message = "Use Up/Down and Enter to select. Esc cancels.";
  while (true) {
    const lines = [initStyle("title", label), initStyle("help", message), ""];
    choices.forEach((choice, index) => {
      const isSelected = index === selected;
      const pointer = initStyle(isSelected ? "selectedPointer" : "pointer", isSelected ? ">" : " ");
      lines.push(`${pointer} ${initStyle(isSelected ? "selectedLabel" : "label", choice)}`);
    });
    renderInitScreen(lines);
    const key = await readInitKey();
    if (key === "ctrl-c") {
      process.stdout.write("\x1b[?25h\n");
      throw new Error("Init cancelled.");
    }
    if (key === "escape" || key === "q") return current;
    if (key === "up") selected = (selected - 1 + choices.length) % choices.length;
    else if (key === "down") selected = (selected + 1) % choices.length;
    else if (key === "enter" || key === "space") return choices[selected];
    else message = "Use Up/Down and Enter to select. Esc cancels.";
  }
}

function readInitKey() {
  return new Promise((resolve) => {
    const input = process.stdin;
    const wasRaw = input.isRaw;
    const cleanup = () => {
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onEnd);
      input.setRawMode(Boolean(wasRaw));
      input.pause();
    };
    const finish = (key) => {
      cleanup();
      resolve(key);
    };
    const onData = (chunk) => {
      const text = chunk.toString("utf8");
      if (text === "\u0003") return finish("ctrl-c");
      if (text === "\r" || text === "\n") return finish("enter");
      if (text === " ") return finish("space");
      if (text === "s" || text === "S") return finish("s");
      if (text === "q" || text === "Q") return finish("q");
      if (text === "\u001b") return finish("escape");
      if (text === "\u001b[A") return finish("up");
      if (text === "\u001b[B") return finish("down");
      return finish("unknown");
    };
    const onEnd = () => finish("ctrl-c");
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
    input.on("end", onEnd);
    input.on("error", onEnd);
  });
}

function initFieldDisplay(values, field) {
  const value = values[field.key] ?? "";
  if (field.type === "bool") return value === "true" ? "true" : "false";
  if (field.type === "secret") return value ? `configured (${String(value).length} chars)` : missingInitFieldLabel(values, field);
  return value || missingInitFieldLabel(values, field);
}

function initStyledRowValue(row) {
  if (row.type === "action") return initStyle(row.action === "save" ? "action" : "danger", row.value ? String(row.value) : "");
  if (!row.field) return row.value ? String(row.value) : "";
  const value = row.value ? String(row.value) : "";
  if (row.field.type === "bool") return initStyle(value === "true" ? "enabled" : "disabled", value);
  if (value === "missing") return initStyle("missing", value);
  if (value === "(empty)") return initStyle("empty", value);
  if (row.field.type === "secret" && value.startsWith("configured")) return initStyle("configured", value);
  return initStyle("value", value);
}

function initStyle(kind, text) {
  return tuiStyle(kind, text);
}

function missingInitFieldLabel(values, field) {
  const required = initRequiredFields(values);
  return required.has(field.key) ? "missing" : "(empty)";
}

function firstInvalidInitSelection(rows, values) {
  const errors = initInvalidFieldKeys(values);
  if (!errors.size) return null;
  const index = rows.findIndex((row) => row.field && errors.has(row.field.key));
  return index >= 0 ? index : null;
}

function initInvalidFieldKeys(values) {
  const keys = new Set();
  const required = initRequiredFields(values);
  for (const key of required) {
    if (!String(values[key] || "").trim()) keys.add(key);
  }
  if (!["json", "sqlite"].includes(values.stateBackend)) keys.add("stateBackend");
  if (values.enableWebui !== "true" && values.enableTelegram !== "true" && values.enableDiscord !== "true" && values.enableSlack !== "true" && values.enableMatrix !== "true") {
    keys.add("enableWebui");
  }
  if (values.enableCodex !== "true" && values.enablePi !== "true" && values.enableHermes !== "true" && values.enableOpenClaw !== "true" && values.enableClaudeCode !== "true") {
    keys.add("enableCodex");
  }
  return keys;
}

function initRequiredFields(values) {
  const required = new Set(["adminEmail", "adminPassword"]);
  if (values.enableTelegram === "true") required.add("telegramBotToken");
  if (values.enableDiscord === "true") required.add("discordBotToken");
  if (values.enableSlack === "true") {
    required.add("slackBotToken");
    required.add("slackAppToken");
  }
  if (values.enableMatrix === "true") {
    required.add("matrixHomeserverUrl");
    required.add("matrixAccessToken");
    required.add("matrixUserId");
  }
  return required;
}

export function validateInitConfig(values) {
  const errors = [];
  if (values.enableTelegram === "true" && !values.telegramBotToken) errors.push("Telegram bot token is required when Telegram is enabled.");
  if (values.enableDiscord === "true" && !values.discordBotToken) errors.push("Discord bot token is required when Discord is enabled.");
  if (values.enableSlack === "true" && !values.slackBotToken) errors.push("Slack bot token is required when Slack is enabled.");
  if (values.enableSlack === "true" && !values.slackAppToken) errors.push("Slack app-level token is required for default Socket Mode.");
  if (values.enableMatrix === "true" && (!values.matrixHomeserverUrl || !values.matrixAccessToken || !values.matrixUserId)) errors.push("Matrix homeserver URL, access token, and bot user ID are required when Matrix is enabled.");
  if (values.enableWebui !== "true" && values.enableTelegram !== "true" && values.enableDiscord !== "true" && values.enableSlack !== "true" && values.enableMatrix !== "true") {
    errors.push("At least WebUI or one chat adapter must be enabled.");
  }
  if (!values.adminEmail) errors.push("Admin email is required.");
  if (!values.adminPassword) errors.push("Admin password is required.");
  if (values.enableCodex !== "true" && values.enablePi !== "true" && values.enableHermes !== "true" && values.enableOpenClaw !== "true" && values.enableClaudeCode !== "true") errors.push("At least one agent must be enabled.");
  if (!["json", "sqlite"].includes(values.stateBackend)) errors.push("State backend must be json or sqlite.");
  return errors;
}

function normalizeInitConfig(values) {
  const normalized = { ...values };
  for (const key of [
    "enableWebui",
    "enableAutostart",
    "enableWebuiAutostart",
    "enableTelegram",
    "enableDiscord",
    "enableSlack",
    "enableMatrix",
    "enableCodex",
    "enablePi",
    "enableHermes",
    "enableOpenClaw",
    "enableClaudeCode",
  ]) {
    normalized[key] = normalizeBoolString(normalized[key]);
  }
  if (normalized.enableWebui !== "true") {
    normalized.enableWebuiAutostart = "false";
  }
  normalized.stateBackend = String(normalized.stateBackend || "json").trim().toLowerCase();
  for (const [key, value] of Object.entries(normalized)) {
    if (typeof value === "string" && key !== "adminPassword") {
      normalized[key] = value.trim();
    }
  }
  return normalized;
}

function normalizeBoolString(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (["1", "yes", "y", "true", "on"].includes(text)) return "true";
  if (["0", "no", "n", "false", "off"].includes(text)) return "false";
  return text || "false";
}
