export type WebActivityCategory =
  | "prompt"
  | "session"
  | "queue"
  | "agent-update"
  | "artifact"
  | "system"
  | "auth"
  | "security"
  | "tool";

export interface WebActivityActor {
  channel: "web" | "telegram" | "discord" | "slack" | "matrix" | "cli" | "system";
  id?: string;
  label?: string;
  username?: string;
  channelUserId?: string;
}

export function activityCategoryForType(type: string): WebActivityCategory {
  if (/^(prompt|cli_turn|voice|upload|attachment)/.test(type)) return "prompt";
  if (/^(session|agent_switch|handback|model_|reasoning_|fast_|launch_)/.test(type)) return "session";
  if (/^queue_/.test(type)) return "queue";
  if (/^agent_(install|update)/.test(type)) return "agent-update";
  if (/^(artifact|artifacts)/.test(type)) return "artifact";
  if (/^(auth|login|logout)/.test(type)) return "auth";
  if (/^(user_|group_|telegram_chat_|telegram_link|discord_channel_|discord_link|slack_channel_|slack_link|matrix_room_|matrix_link|peer_|permission_|access_|lock_)/.test(type)) return "security";
  if (/^(tool_|cli_tool)/.test(type)) return "tool";
  return "system";
}

export function activityActorLabel(actor: WebActivityActor | undefined): string {
  if (!actor) {
    return "system";
  }
  return actor.label || actor.username || actor.id || actor.channelUserId || actor.channel;
}

export function auditCategoryForAction(action: string): WebActivityCategory {
  if (/^prompt_/.test(action)) return "prompt";
  if (/^queue_/.test(action)) return "queue";
  if (/^lock_/.test(action)) return "security";
  if (/^auth_/.test(action)) return "auth";
  if (/^(permission_|user_|group_|telegram_|discord_|slack_|matrix_|peer_)/.test(action)) return "security";
  if (/^(artifact|file)/.test(action)) return "artifact";
  if (/^(model_|reasoning_|fast_|launch_|session_|handback)/.test(action)) return "session";
  if (/^(tool_)/.test(action)) return "tool";
  return "system";
}
