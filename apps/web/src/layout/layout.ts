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
  | "statusBar";

/** Every placeable piece of UI, by a short stable id. */
export type SurfaceId =
  | "folder"
  | "sessions"
  | "title"
  | "model"
  | "todo"
  | "attachments"
  | "attach"
  | "mode"
  | "queue"
  | "context";

export type AppLayout = Readonly<Record<LayoutAreaName, readonly SurfaceId[]>>;

export const LAYOUT: AppLayout = {
  /** Left sidebar, top to bottom. */
  sidebar: ["folder", "sessions"],
  /** Above the conversation, left to right; the title takes the free space. */
  header: ["title", "model"],
  /** Right sidebar; with more than one panel they become tabs, in this order. */
  panels: ["todo"],
  /** The row under the message box, left to right. */
  composerToolbar: ["attach", "mode", "queue"],
  /** Under that row. */
  composerFooter: ["attachments"],
  /** The bottom bar, left to right. */
  statusBar: ["context"],
};
