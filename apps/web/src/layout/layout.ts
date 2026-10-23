/**
 * Where every piece of the app's UI goes. To move a control to another area, hide it or change its
 * order, edit only this file: each area lists surface ids in display order. What an id renders is
 * wired once in `apps/web/src/app/app-surfaces.tsx` (`sidebarSurfaces`) and in
 * `apps/web/src/app/thread-surfaces.tsx` (`threadSurfaces`); how an area lays its pieces out is in
 * `./area.tsx`.
 */

/** The areas of the app shell. */
export type LayoutAreaName =
  | "sidebar"
  | "header"
  | "panels"
  | "composerToolbar"
  | "composerFooter"
  | "threadFooter"
  | "threadOverlay"
  | "threadNotices"
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
  | "toolCalls"
  | "toolsHidden"
  | "editRun"
  | "editHandoff"
  | "context"
  | "contextCard"
  | "statusSegments"
  | "notifications"
  | "notices"
  | "connection"
  | "watchNotice"
  | "theme"
  | "rewind"
  | "commandOutput"
  | "agents"
  | "rules"
  | "executionModes"
  | "liveVoice";

export type AppLayout = Readonly<Record<LayoutAreaName, readonly SurfaceId[]>>;

export const LAYOUT: AppLayout = {
  /** Left sidebar, top to bottom; the theme control sits at the bottom. */
  sidebar: ["folder", "sessions", "theme"],
  /** Above the conversation, left to right; the title takes the free space. */
  header: ["title", "toolCalls", "settings"],
  /**
   * Right sidebar; with more than one panel they become tabs, in this order. An on-demand panel
   * (`Surface.open`) is listed only while it is open.
   */
  panels: ["todo", "contextCard", "agents", "rules", "rewind", "commandOutput"],
  composerToolbar: ["model", "mode", "executionModes"],
  /** Under the controls, at the foot of the composer. */
  composerFooter: ["editHandoff", "attachments"],
  /**
   * At the bottom of the transcript. The hidden-tools line comes first: while tool activity is shown it is empty, so
   * the controls on the right stay where they were.
   */
  threadFooter: ["toolsHidden", "connection", "watchNotice", "editRun", "scrollFollow"],
  /**
   * Over the end of the transcript, just above its footer: the notices and the queued messages float here. Each surface
   * catches its own pointer events, so the footer's controls (Jump to latest) stay usable; the composer and the status bar
   * do not move for them. Used by an empty chat only; a chat with messages draws them in `threadNotices`.
   */
  threadOverlay: ["notices", "queue"],
  /**
   * Between the transcript and the composer, in a row of its own outside the transcript's scroll: the notices and the
   * queued messages take their own space, so nothing is drawn over a message and the composer does not move. A chat
   * with messages draws them here; an empty chat draws the notices in `threadOverlay`.
   */
  threadNotices: ["notices", "queue"],
  /** The bottom bar, left to right. */
  statusBar: ["notifications", "statusSegments", "context"],
};
