/** The dashboard as a pane of the workspace: `kind` tells it from a chat's pane. */
export interface DashboardPaneParams {
  readonly kind: "dashboard";
}

/** The workspace's component name for the dashboard, and its pane's id: one dashboard across the workspaces. */
export const DASHBOARD_PANE = "dashboard";

/** Whether a pane's parameters are the dashboard's. */
export function isDashboardPane(params: unknown): params is DashboardPaneParams {
  return (params as { kind?: unknown } | undefined)?.kind === "dashboard";
}
