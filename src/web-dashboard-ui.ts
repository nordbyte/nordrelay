export interface DashboardPage {
  id: string;
  label: string;
}

export const DASHBOARD_PAGES: DashboardPage[] = [
  { id: "overview", label: "Overview" },
  { id: "chat", label: "Chat" },
  { id: "sessions", label: "Sessions" },
  { id: "queue", label: "Queue" },
  { id: "tasks", label: "Tasks" },
  { id: "activity", label: "Activity" },
  { id: "artifacts", label: "Artifacts" },
  { id: "adapters", label: "Adapters" },
  { id: "access", label: "Access" },
  { id: "version", label: "Version" },
  { id: "settings", label: "Settings" },
  { id: "logs", label: "Logs" },
  { id: "diagnostics", label: "Diagnostics" },
];

export function renderDashboardNav(activePage = "overview"): string {
  return DASHBOARD_PAGES.map((page) =>
    `<button data-page="${page.id}"${page.id === activePage ? ' class="active"' : ""}>${page.label}</button>`,
  ).join("\n        ");
}
