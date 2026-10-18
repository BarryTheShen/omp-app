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
  | "composerQueue"
  | "composerFooter"
  | "threadFooter"
  | "threadOverlay"
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
  | "executionModes"
  | "liveVoice";

export type AppLayout = Readonly<Record<LayoutAreaName, readonly SurfaceId[]>>;

export const LAYOUT: AppLayout = {
  /** Left sidebar, top to bottom; the theme control sits at the bottom. */
  sidebar: ["folder", "sessions", "theme"],
  /** Above the conversation, left to right; the title takes the free space. */
  header: ["title", "settings"],
  /**
   * Right sidebar; with more than one panel they become tabs, in this order. An on-demand panel
   * (`Surface.open`) is listed only while it is open.
   */
  panels: ["todo", "contextCard", "agents", "rewind", "commandOutput"],
  /** The inline control row inside the composer, left to right. */
  composerToolbar: ["model", "mode", "executionModes"],
  /** The queued messages, on a row of their own under the controls. The row is open only while a message waits. */
  composerQueue: ["queue"],
  /** Under the controls and the queue, at the foot of the composer. */
  composerFooter: ["editHandoff", "attachments"],
  /**
   * At the bottom of the transcript. The hidden-tools line comes first: while tool activity is shown it is empty, so
   * the controls on the right stay where they were.
   */
  threadFooter: [
    "toolsHidden",
    "connection",
    "watchNotice",
    "editRun",
    "toolCalls",
    "scrollFollow",
    "liveVoice",
  ],
  /**
   * Over the end of the transcript, just above its footer: the notices float here and never cover the
   * footer's controls (Jump to latest), and the composer and the status bar do not move for them.
   */
  threadOverlay: ["notices"],
  /** The bottom bar, left to right. */
  statusBar: ["notifications", "statusSegments", "context"],
};
