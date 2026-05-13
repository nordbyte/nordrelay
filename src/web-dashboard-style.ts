import { dashboardStyleComponents } from "./webui/style-components.js";
import { dashboardStyleLayout } from "./webui/style-layout.js";
import { dashboardStyleResponsive } from "./webui/style-responsive.js";
import { dashboardStyleTheme } from "./webui/style-theme.js";

export function dashboardCss(): string {
  return [
    dashboardStyleTheme(),
    dashboardStyleComponents(),
    dashboardStyleLayout(),
    dashboardStyleResponsive(),
  ].join("\n");
}
