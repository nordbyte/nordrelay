import { escapeHTML } from "./format.js";

export interface DualText {
  html: string;
  plain: string;
}

/**
 * Grouped command reference for /help.
 */
export function renderHelpMessage(): DualText {
  const sections = [
    {
      title: "💬 Session",
      commands: [
        ["/new", "Start a new thread"],
        ["/agent", "Select agent"],
        ["/session", "Current thread details"],
        ["/sessions", "Browse & switch threads"],
        ["/sync", "Sync active sessions from CLI state"],
        ["/pinned", "Show pinned threads"],
        ["/pin", "Pin current or given thread"],
        ["/unpin", "Unpin current or given thread"],
        ["/attach", "Bind a session to this topic"],
        ["/handback", "Hand session back to CLI"],
        ["/abort", "Cancel current operation"],
        ["/stop", "Cancel current operation"],
        ["/retry", "Resend the last prompt"],
        ["/queue", "Show queued prompts with cancel buttons"],
        ["/cancel", "Cancel a queued prompt"],
        ["/clearqueue", "Clear queued prompts"],
        ["/artifacts", "List or resend generated files"],
        ["/workspaces", "List allowed workspaces"],
      ],
    },
    {
      title: "🤖 Model",
      commands: [
        ["/launch_profiles", "Select launch profile"],
        ["/fast", "Toggle fast mode"],
        ["/model", "View & change model"],
        ["/reasoning", "Set reasoning effort"],
        ["/mirror", "Control CLI mirroring"],
        ["/notify", "Control completion notifications"],
      ],
    },
    {
      title: "🔐 Auth",
      commands: [
        ["/auth", "Check auth status"],
        ["/login", "Start authentication"],
        ["/logout", "Sign out"],
      ],
    },
    {
      title: "ℹ️ Utility",
      commands: [
        ["/start", "Welcome & status"],
        ["/help", "This reference"],
        ["/channels", "Messaging adapter status"],
        ["/agents", "Agent adapter status"],
        ["/voice", "Voice transcription status"],
        ["/status", "Connector runtime status"],
        ["/health", "Connector health report"],
        ["/version", "Connector version"],
        ["/tasks", "Current turn progress"],
        ["/activity", "Thread activity timeline"],
        ["/audit", "Recent audit events"],
      ],
    },
    {
      title: "🛠️ Admin",
      commands: [
        ["/logs", "Show connector log tail"],
        ["/diagnostics", "Connector diagnostics"],
        ["/lock", "Lock session writes to you"],
        ["/unlock", "Release session write lock"],
        ["/locks", "List active write locks"],
        ["/restart", "Restart connector"],
        ["/update", "Pull, build, and restart"],
      ],
    },
  ];

  const htmlLines: string[] = [];
  const plainLines: string[] = [];

  for (const section of sections) {
    htmlLines.push(`<b>${escapeHTML(section.title)}</b>`);
    plainLines.push(section.title);
    for (const [cmd, desc] of section.commands) {
      htmlLines.push(`  ${cmd} — ${escapeHTML(desc)}`);
      plainLines.push(`  ${cmd} — ${desc}`);
    }
    htmlLines.push("");
    plainLines.push("");
  }

  while (htmlLines.at(-1) === "") {
    htmlLines.pop();
  }
  while (plainLines.at(-1) === "") {
    plainLines.pop();
  }

  return {
    html: htmlLines.join("\n"),
    plain: plainLines.join("\n"),
  };
}

/**
 * Short /start message for first-time users (no prior interaction in this context).
 */
export function renderWelcomeFirstTime(authWarning?: string): DualText {
  const htmlLines = [
    "<b>👋 NordRelay is ready.</b>",
    "",
    "Send a message to start chatting with the selected coding agent.",
    "You can also send voice notes, photos, or documents.",
    "",
    "Type /help for all commands.",
  ];
  const plainLines = [
    "👋 NordRelay is ready.",
    "",
    "Send a message to start chatting with the selected coding agent.",
    "You can also send voice notes, photos, or documents.",
    "",
    "Type /help for all commands.",
  ];

  if (authWarning) {
    htmlLines.push("", `⚠️ ${escapeHTML(authWarning)}`);
    plainLines.push("", `⚠️ ${authWarning}`);
  }

  return { html: htmlLines.join("\n"), plain: plainLines.join("\n") };
}

/**
 * Concise /start message for returning users with session info.
 */
export function renderWelcomeReturning(
  sessionHtml: string,
  sessionPlain: string,
  isTopicSession: boolean,
  authWarning?: string,
): DualText {
  const label = isTopicSession
    ? "NordRelay (topic session)"
    : "NordRelay";

  const htmlLines = [`<b>👋 ${escapeHTML(label)}</b>`, "", sessionHtml];
  const plainLines = [`👋 ${label}`, "", sessionPlain];

  if (authWarning) {
    htmlLines.push("", `⚠️ ${escapeHTML(authWarning)}`);
    plainLines.push("", `⚠️ ${authWarning}`);
  }

  return { html: htmlLines.join("\n"), plain: plainLines.join("\n") };
}

/**
 * Format a session button label for /sessions list.
 * Wider workspace name (12 chars), model tag, short thread snippet.
 */
export function formatSessionLabel(
  options: {
    workspace: string;
    title: string;
    relativeTime: string;
    model?: string;
    isActive: boolean;
    isPinned?: boolean;
  },
): string {
  const prefix = options.isActive ? "✅" : options.isPinned ? "⭐" : "📁";
  const workspaceName = trimLabel(getWorkspaceShortName(options.workspace), 12) || "(unknown)";
  const title = trimLabel(options.title || "(untitled)", 20) || "(untitled)";
  const time = options.relativeTime;

  let label = `${prefix} ${workspaceName} · ${title} · ${time}`;

  if (options.model) {
    const shortModel = trimLabel(options.model, 10);
    label += ` · ${shortModel}`;
  }

  return label;
}

function trimLabel(text: string, maxLength: number): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLength) {
    return singleLine;
  }
  return `${singleLine.slice(0, maxLength - 1)}…`;
}

function getWorkspaceShortName(workspace: string): string {
  return workspace.split(/[\\/]/).filter(Boolean).pop() ?? workspace;
}
