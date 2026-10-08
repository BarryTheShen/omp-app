/**
 * Where every piece of the app's UI goes. To move a control to another area, hide it or change its
 * order, edit only this file: each area lists surface ids in display order. What an id renders is
 * wired once in `apps/web/src/app/root.tsx` (`sidebarSurfaces`, `threadSurfaces`); how an area lays
 * its pieces out is in `./area.tsx`.
 */

/** The areas of the app shell. */
export type LayoutAreaName =
  | "sidebar"
  | "header"
  | "panels"
  | "composerToolbar"
  | "composerFooter"
  | "threadFooter"
  | "statusBar";

/** Every placeable piece of UI, by a short stable id. */
export type SurfaceId =
  | "folder"
  | "sessions"
  | "title"
  | "model"
  | "settings"
  | "todo"
  | "attachments"
  | "mode"
  | "queue"
  | "scrollFollow"
  | "editRun"
  | "editHandoff"
  | "context"
  | "theme";

export type AppLayout = Readonly<Record<LayoutAreaName, readonly SurfaceId[]>>;

export const LAYOUT: AppLayout = {
  /** Left sidebar, top to bottom; the theme control sits at the bottom. */
  sidebar: ["folder", "sessions", "theme"],
  /** Above the conversation, left to right; the title takes the free space. */
  header: ["title", "model", "settings"],
  /** Right sidebar; with more than one panel they become tabs, in this order. */
  panels: ["todo"],
  /** The inline control row inside the composer, left to right. */
  composerToolbar: ["mode", "queue"],
  /** Under that row. */
  composerFooter: ["editHandoff", "attachments"],
  /** At the bottom of the transcript. */
  threadFooter: ["editRun", "scrollFollow"],
  /** The bottom bar, left to right. */
  statusBar: ["context"],
};
