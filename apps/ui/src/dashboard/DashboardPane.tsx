import type { IDockviewPanelProps } from "dockview-react";
import { type ReactNode, Suspense, use } from "react";
import { loadable } from "../loadable";
import { PaneHostContext } from "../workspace/ChatPanel";
import type { DashboardPaneParams } from "./dashboardPane";

/** The dashboard's page, loaded a little after the app is ready (`preloadPages` in `App.tsx`), or when it first shows. */
export const dashboardBody = loadable(() =>
  import("./DashboardPage").then((module) => module.DashboardBody),
);
const DashboardBody = dashboardBody.Component;

/**
 * The dashboard as a pane: a page in a workspace, as a chat is. It opens in a workspace of its own, and like any pane it
 * can be moved beside a chat, or to a window's right edge.
 */
export function DashboardPane(_props: IDockviewPanelProps<DashboardPaneParams>): ReactNode {
  const host = use(PaneHostContext);
  if (host === null) return null;
  return (
    <Suspense fallback={null}>
      <DashboardBody client={host.client} onOpenChat={(target) => host.openChat(target, "front")} />
    </Suspense>
  );
}
