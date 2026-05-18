import type { Permission } from "../access/access-control.js";

export interface DashboardPage {
  id: string;
  label: string;
  permission: Permission;
}

export interface DashboardNavSection {
  id: string;
  label: string;
  defaultOpen?: boolean;
  pages: DashboardPage[];
}

export const DASHBOARD_PRIMARY_NAV_PAGES: DashboardPage[] = [
  { id: "overview", label: "Overview", permission: "inspect" },
  { id: "chat", label: "Chat", permission: "sessions.read" },
  { id: "workflows", label: "Workflows", permission: "workflows.read" },
  { id: "sessions", label: "Sessions", permission: "sessions.read" },
  { id: "queue", label: "Queue", permission: "queue.read" },
  { id: "monitor", label: "Monitor", permission: "inspect" },
];

export const DASHBOARD_NAV_SECTIONS: DashboardNavSection[] = [
  {
    id: "operations",
    label: "Operations",
    pages: [
      { id: "adapters", label: "Adapters", permission: "inspect" },
      { id: "version", label: "Version", permission: "inspect" },
      { id: "logs", label: "Logs", permission: "logs.read" },
      { id: "metrics", label: "Metrics", permission: "inspect" },
      { id: "diagnostics", label: "Diagnostics", permission: "diagnostics.read" },
    ],
  },
  {
    id: "administration",
    label: "Administration",
    pages: [
      { id: "access", label: "Users", permission: "users.read" },
      { id: "settings", label: "Settings", permission: "settings.read" },
      { id: "peers", label: "Peers", permission: "peers.read" },
    ],
  },
];

export const DASHBOARD_PAGES: DashboardPage[] = [
  ...DASHBOARD_PRIMARY_NAV_PAGES,
  ...DASHBOARD_NAV_SECTIONS.flatMap((section) => section.pages),
];

function renderDashboardPageButton(page: DashboardPage, activePage: string): string {
  return `<button type="button" data-page="${page.id}" data-permission="${page.permission}"${page.id === activePage ? ' class="active"' : ""}>${page.label}</button>`;
}

function renderDashboardNavSection(section: DashboardNavSection, activePage: string): string {
  const isOpen = section.defaultOpen === true || section.pages.some((page) => page.id === activePage);
  const itemsId = `nav-section-${section.id}`;
  return `<div class="nav-section" data-nav-section="${section.id}" data-nav-open="${isOpen ? "true" : "false"}" data-nav-default-open="${section.defaultOpen === true ? "true" : "false"}">
          <button type="button" class="nav-section-toggle" data-nav-toggle="${section.id}" aria-expanded="${isOpen ? "true" : "false"}" aria-controls="${itemsId}">${section.label}</button>
          <div class="nav-section-items" id="${itemsId}"${isOpen ? "" : " hidden"}>
            ${section.pages.map((page) => renderDashboardPageButton(page, activePage)).join("\n            ")}
          </div>
        </div>`;
}

export function renderDashboardNav(activePage = "overview"): string {
  const primary = `<div class="nav-primary">
            ${DASHBOARD_PRIMARY_NAV_PAGES.map((page) => renderDashboardPageButton(page, activePage)).join("\n            ")}
          </div>`;
  const sections = DASHBOARD_NAV_SECTIONS.map((section) => renderDashboardNavSection(section, activePage)).join("\n        ");
  return `${primary}\n        ${sections}`;
}
