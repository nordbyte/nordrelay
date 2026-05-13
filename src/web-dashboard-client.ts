import { dashboardClientAdmin } from "./webui/client-admin.js";
import { dashboardClientEvents } from "./webui/client-events.js";
import { dashboardClientFoundation } from "./webui/client-foundation.js";
import { dashboardClientWorkflows } from "./webui/client-workflows.js";

export function dashboardJs(): string {
  return [
    dashboardClientFoundation(),
    dashboardClientEvents(),
    dashboardClientWorkflows(),
    dashboardClientAdmin(),
  ].join("\n");
}
