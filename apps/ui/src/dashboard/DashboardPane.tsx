import type { IDockviewPanelProps } from "dockview-react";
import { lazy, type ReactNode, Suspense, use } from "react";
import { PaneHostContext } from "../workspace/ChatPanel";
import type { DashboardPaneParams } from "./dashboardPane";

/** The dashboard's page, loaded when it first shows. */
const DashboardBody = lazy(() =>
  import("./DashboardPage").then((module) => ({ default: module.DashboardBody })),
);

/**
 * The dashboard as a pane: a page in a workspace, as a chat is. It opens in a workspace of its own, and like any pane it
 * can be moved beside a chat, or to a window's right edge.
 */
export function DashboardPane(_props: IDockviewPanelProps<DashboardPaneParams>): ReactNode {
  const host = use(PaneHostContext);
  if (host === null) return null;
  return (
    <Suspense fallback={null}>
      <DashboardBody client={host.client} />
    </Suspense>
  );
}
