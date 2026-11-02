import type { AppClient } from "@omp-app/client";
import type { FolderPath, WorkspaceRelativePath } from "@omp-app/contracts";
import type { DockviewApi, IDockviewPanelProps } from "dockview-react";
import { createContext, type ReactNode, use, useEffect } from "react";
import type { ChatController } from "../chat/controller";
import { usePhone } from "../phone";
import { PaneModeOutline } from "../workspace/paneMode";
import { FILE_PANE_COMPONENT, type FilePaneParams, filePaneId } from "./files/filePaneParams";
import { baseName } from "./files/names";
import { PANELS } from "./registry";

/** The side pane's id: at most one in each workspace tab. */
export const SIDE_PANE = "side";

/** The side pane's parameters: the panel it shows, a registry id. */
export interface SidePaneParams {
  readonly panel: string;
}

/** What the side pane draws from: the app's client and folder, the chat it follows, and the goal dialog. */
export interface SidePaneHost {
  readonly client: AppClient;
  readonly folder: FolderPath;
  /** The chat of the pane focused last in the shown tab; null when that tab has none. */
  readonly chat: ChatController | null;
  readonly openGoal: (chat: ChatController) => void;
}

export const SidePaneContext = createContext<SidePaneHost | null>(null);

/**
 * The workspace tab shown, as its dockview: every tab's panes stay mounted, and a side pane in a hidden tab draws
 * nothing (the BTW panel tells its chat whether its answers are seen).
 */
export const ShownTabContext = createContext<DockviewApi | null>(null);

/** A panel by its id; the first panel for an id no panel has (one an older layout kept). */
export const panelOf = (id: string) => PANELS.find((item) => item.id === id) ?? PANELS[0];

/**
 * The side panel as a pane of the workspace: one panel at a time (Usage, Agents, Progress, Jobs, BTW history) for the chat of
 * the pane focused last, resized, moved and closed like a chat's pane. The rail at the window's right edge picks the
 * panel; the side panel's key shows or hides it.
 */
export function SidePane({
  params,
  api,
  containerApi,
}: IDockviewPanelProps<SidePaneParams>): ReactNode {
  const host = use(SidePaneContext);
  // By the dockview's id, not its api object: a pane restored from a saved layout is given an api object of its own
  // (dockview's deserializer), so after a start or a reload the objects never match and the panel drew nothing (#2773).
  const shown = use(ShownTabContext)?.id === containerApi.id;
  const chosen = panelOf(params.panel);
  const phone = usePhone();
  useEffect(() => {
    if (chosen !== undefined) api.setTitle(chosen.title);
  }, [api, chosen]);
  if (host === null || chosen === undefined) return null;
  /** A file of the folder as a pane left of this one, or the one already showing it brought forward. */
  const openFileTab = (path: WorkspaceRelativePath): void => {
    const id = filePaneId(host.folder, path);
    const existing = containerApi.getPanel(id);
    if (existing !== undefined) {
      existing.api.setActive();
      return;
    }
    containerApi.addPanel({
      id,
      component: FILE_PANE_COMPONENT,
      title: baseName(path),
      params: { kind: "file", folder: host.folder, path } satisfies FilePaneParams,
      position: { referencePanel: api.id, direction: "left" },
    });
  };
  return (
    <aside
      data-tour="side-panel"
      aria-label="Side panel"
      className="relative flex h-full min-h-0 flex-col bg-panel"
    >
      <div role="tabpanel" aria-label={chosen.title} className="min-h-0 flex-1 overflow-y-auto">
        {shown && chosen.render(phone ? host : { ...host, openFileTab })}
      </div>
      <PaneModeOutline api={api} />
    </aside>
  );
}
