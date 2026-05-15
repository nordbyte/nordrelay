import type { Permission } from "./access-control.js";

export interface DashboardPage {
  id: string;
  label: string;
  permission: Permission;
}

export const DASHBOARD_PAGES: DashboardPage[] = [
  { id: "overview", label: "Overview", permission: "inspect" },
  { id: "chat", label: "Chat", permission: "sessions.read" },
  { id: "sessions", label: "Sessions", permission: "sessions.read" },
  { id: "queue", label: "Queue", permission: "queue.read" },
  { id: "tasks", label: "Tasks", permission: "inspect" },
  { id: "metrics", label: "Metrics", permission: "inspect" },
  { id: "activity", label: "Activity", permission: "sessions.read" },
  { id: "artifacts", label: "Artifacts", permission: "files.read" },
  { id: "adapters", label: "Adapters", permission: "inspect" },
  { id: "peers", label: "Peers", permission: "peers.read" },
  { id: "access", label: "Users", permission: "users.read" },
  { id: "version", label: "Version", permission: "inspect" },
  { id: "settings", label: "Settings", permission: "settings.read" },
  { id: "logs", label: "Logs", permission: "logs.read" },
  { id: "diagnostics", label: "Diagnostics", permission: "diagnostics.read" },
];

export function renderDashboardNav(activePage = "overview"): string {
  return DASHBOARD_PAGES.map((page) =>
    `<button data-page="${page.id}" data-permission="${page.permission}"${page.id === activePage ? ' class="active"' : ""}>${page.label}</button>`,
  ).join("\n        ");
}
