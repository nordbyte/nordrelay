export type ChannelCommandOption = {
  type: 3;
  name: string;
  description: string;
  required?: boolean;
};

export type ChannelCommandDefinition = {
  name: string;
  description: string;
  telegramDescription?: string;
  discordDescription?: string;
  slackDescription?: string;
  telegram?: boolean;
  discord?: boolean;
  slack?: boolean;
  matrix?: boolean;
  discordOptions?: ChannelCommandOption[];
};

const textOption = (name = "value", description = "Value", required = false): ChannelCommandOption => ({
  type: 3,
  name,
  description,
  required,
});

export const CHANNEL_COMMANDS: readonly ChannelCommandDefinition[] = [
  { name: "start", description: "Welcome and status", discordDescription: "Start or inspect the current NordRelay context" },
  { name: "help", description: "Command reference", discordDescription: "Show Discord adapter help" },
  { name: "prompt", description: "Send a prompt to the selected agent", telegram: false, discordOptions: [textOption("text", "Prompt text", true)] },
  { name: "link", description: "Link account to NordRelay user", telegramDescription: "Link Telegram to NordRelay user", discordDescription: "Link this Discord account with a NordRelay code", discordOptions: [textOption("value", "Link code", true)] },
  { name: "whoami", description: "Show your NordRelay user", discordDescription: "Show linked NordRelay user" },
  { name: "register_chat", description: "Admin: enable this group chat", discord: false },
  { name: "register_channel", description: "Enable this Discord channel for NordRelay", telegram: false },
  { name: "channels", description: "Messaging adapter status", discordDescription: "Show channel adapters" },
  { name: "peers", description: "NordRelay peer status", discordDescription: "Show paired NordRelay instances" },
  { name: "nodes", description: "Select local or peer node", discordDescription: "Select the local node or a peer" },
  { name: "target", description: "Select local or peer target", discordDescription: "Select local or peer target", discordOptions: [textOption("value", "local or peer id")] },
  { name: "agents", description: "Agent adapter status", discordDescription: "Show agent adapters" },
  { name: "agent", description: "Select agent", discordDescription: "Select or show the active agent", discordOptions: [textOption("value", "Agent id")] },
  { name: "new", description: "Start a new thread", discordDescription: "Create a new session", discordOptions: [textOption("value", "Workspace path")] },
  { name: "session", description: "Current thread details", discordDescription: "Show the active session" },
  { name: "sessions", description: "Browse and switch threads", discordDescription: "Browse recent sessions", discordOptions: [textOption("query", "Search query")] },
  { name: "switch", description: "Switch to a thread by ID", discordDescription: "Switch to a session", discordOptions: [textOption("thread_id", "Thread id", true)] },
  { name: "attach", description: "Bind a session to this topic", discordDescription: "Attach a session", discordOptions: [textOption("thread_id", "Thread id", true)] },
  { name: "handback", description: "Hand session back to CLI", discordDescription: "Hand the active session back to the native CLI" },
  { name: "sync", description: "Sync active session from CLI state", discordDescription: "Sync from local agent state" },
  { name: "pinned", description: "Show pinned threads" },
  { name: "pin", description: "Pin current or given thread", discordOptions: [textOption("value", "Thread id")] },
  { name: "unpin", description: "Unpin current or given thread", discordOptions: [textOption("value", "Thread id")] },
  { name: "retry", description: "Resend the last prompt", discordDescription: "Retry the last prompt" },
  { name: "last", description: "Resend the last agent reply", discordDescription: "Resend the last agent reply", discordOptions: [textOption("value", "Optional count, up to 5")] },
  { name: "templates", description: "List prompt templates", discordDescription: "List prompt templates" },
  { name: "template", description: "Run a prompt template", discordDescription: "Run a prompt template", discordOptions: [textOption("value", "Template id", true)] },
  { name: "workflows", description: "List workflows", discordDescription: "List workflows" },
  { name: "workflow", description: "Run a workflow", discordDescription: "Run a workflow", discordOptions: [textOption("value", "Workflow id", true)] },
  { name: "queue", description: "Show queued prompts", discordDescription: "Show or manage queue", discordOptions: [textOption("action", "pause/resume/clear/run/cancel/top/up/down"), textOption("id", "Queue id")] },
  { name: "cancel", description: "Cancel a queued prompt", discordOptions: [textOption("value", "Queue id", true)] },
  { name: "clearqueue", description: "Clear queued prompts", discordDescription: "Clear queue" },
  { name: "artifacts", description: "List or resend generated files", discordDescription: "List or send artifacts", discordOptions: [textOption("value", "zip <turn-id>")] },
  { name: "workspaces", description: "List allowed workspaces" },
  { name: "abort", description: "Cancel current operation", discordDescription: "Abort the active task" },
  { name: "stop", description: "Cancel current operation", discordDescription: "Abort the active task" },
  { name: "launch", description: "Select or apply launch profile", discordOptions: [textOption("value", "Launch profile id, optionally with apply/confirm")] },
  { name: "launch_profiles", description: "Select or apply launch profile", discordOptions: [textOption("value", "Launch profile id, optionally with apply/confirm")] },
  { name: "fast", description: "Toggle fast mode", discordOptions: [textOption("value", "on/off")] },
  { name: "model", description: "View and change model", discordDescription: "Select or show models", discordOptions: [textOption("value", "Model id")] },
  { name: "effort", description: "Set reasoning effort", discordDescription: "Select reasoning effort", discordOptions: [textOption("value", "Reasoning value")] },
  { name: "reasoning", description: "Set reasoning effort", discordDescription: "Select reasoning effort", discordOptions: [textOption("value", "Reasoning value")] },
  { name: "mirror", description: "Control CLI mirroring", discordDescription: "Set mirror mode", discordOptions: [textOption("value", "off/on")] },
  { name: "notify", description: "Control notifications", discordDescription: "Set notification mode", discordOptions: [textOption("value", "off/minimal/all")] },
  { name: "auth", description: "Check auth status", discordDescription: "Show selected agent auth status" },
  { name: "login", description: "Start authentication", discordDescription: "Start selected agent login" },
  { name: "logout", description: "Sign out", discordDescription: "Sign out of the selected agent" },
  { name: "voice", description: "Voice transcription status", discordDescription: "Show or change voice settings", discordOptions: [textOption("value", "transcribe-only on/off")] },
  { name: "tasks", description: "Current turn progress", discordDescription: "Show recent tasks", discordOptions: [textOption("value", "Limit")] },
  { name: "progress", description: "Current turn progress", discordDescription: "Show current turn progress" },
  { name: "activity", description: "Thread activity timeline", discordDescription: "Show recent activity", discordOptions: [textOption("value", "Limit")] },
  { name: "audit", description: "Admin: recent audit events", discordDescription: "Show recent audit events", discordOptions: [textOption("value", "Limit")] },
  { name: "status", description: "Connector runtime status", discordDescription: "Show status" },
  { name: "health", description: "Connector health report", discordDescription: "Show health" },
  { name: "version", description: "Connector version", discordDescription: "Show versions" },
  { name: "logs", description: "Admin: show connector logs", discordDescription: "Show logs", discordOptions: [textOption("value", "Target and line count")] },
  { name: "diagnostics", description: "Admin: connector diagnostics", discordDescription: "Show diagnostics" },
  { name: "support", description: "Admin: export diagnostics bundle", discordDescription: "Show support diagnostics" },
  { name: "lock", description: "Lock session writes to you", discordDescription: "Lock this context" },
  { name: "unlock", description: "Release session write lock", discordDescription: "Unlock this context" },
  { name: "locks", description: "List session write locks", discordDescription: "List locks" },
  { name: "restart", description: "Admin: restart connector", discordDescription: "Restart NordRelay" },
  { name: "update", description: "Admin: update connector or agents", discordDescription: "Update NordRelay or agents", discordOptions: [textOption("target", "jobs, install, log, cancel, input, or agent id"), textOption("agent", "Agent id or job id"), textOption("input", "Text for update input")] },
];

export function telegramCommandCatalog(): Array<{ command: string; description: string }> {
  return CHANNEL_COMMANDS
    .filter((entry) => entry.telegram !== false)
    .map((entry) => ({
      command: entry.name,
      description: entry.telegramDescription ?? entry.description,
    }));
}

export function discordCommandCatalog(): Array<Required<Pick<ChannelCommandDefinition, "name" | "description">> & { options: ChannelCommandOption[] }> {
  return CHANNEL_COMMANDS
    .filter((entry) => entry.discord !== false)
    .map((entry) => ({
      name: entry.name,
      description: entry.discordDescription ?? entry.description,
      options: entry.discordOptions ?? [],
    }));
}

export function discordHelpCommandList(): string {
  return discordCommandCatalog()
    .filter((entry) => !["start", "help", "prompt"].includes(entry.name))
    .map((entry) => `/${entry.name}`)
    .join(", ");
}

export function slackHelpCommandList(): string {
  return CHANNEL_COMMANDS
    .filter((entry) => entry.slack !== false && !["start", "help", "prompt"].includes(entry.name))
    .map((entry) => `/${entry.name}`)
    .join(", ");
}

export function matrixHelpCommandList(): string {
  return CHANNEL_COMMANDS
    .filter((entry) => entry.matrix !== false && !["start", "help", "prompt"].includes(entry.name))
    .map((entry) => `/${entry.name}`)
    .join(", ");
}
