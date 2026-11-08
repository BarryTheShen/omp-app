import { z } from "zod";
import type { PortClient, PortHandlers } from "../../core/envelope";
import { definePort } from "../../core/envelope";

const EmptyArgs = z.object({}).strict();
const TabId = z.string().min(1).max(200);
const Coordinate = z.number().min(-100_000).max(100_000);
/** CDP's modifier bits: Alt 1, Ctrl 2, Meta 4, Shift 8. */
const Modifiers = z.number().int().min(0).max(15);

/** A page in the app's browser (a Chrome on the server's machine). */
export const BrowserTab = z.object({ id: TabId, url: z.string(), title: z.string() }).strict();
export type BrowserTab = z.infer<typeof BrowserTab>;

/** The browser chats use (omp's browser tool): their own, the app's, or the user's Edge through omp's relay. */
export const BrowserTarget = z.enum(["off", "app", "edge"]);
export type BrowserTarget = z.infer<typeof BrowserTarget>;

/** A tab of the user's browser, as omp's relay lists it. */
export const EdgeTab = z
  .object({ id: z.string(), url: z.string(), title: z.string(), active: z.boolean() })
  .strict();
export type EdgeTab = z.infer<typeof EdgeTab>;

export const BrowserStatus = z
  .object({
    /** The browser chats use, as omp's settings say. */
    target: BrowserTarget,
    /** The app's own browser: a Chrome on the server's machine, shown in the Browser panel. */
    app: z
      .object({
        /** A Chrome to run was found on the server's machine. */
        available: z.boolean(),
        running: z.boolean(),
        /** Why it is not available or did not start, in plain words; null when all is well. */
        problem: z.string().nullable(),
        tabs: z.array(BrowserTab),
        /**
         * The tab in front: the one that draws and takes input (a tab behind another does neither), and the one the
         * panel shows. Null while none is known to be there.
         */
        front: TabId.nullable(),
      })
      .strict(),
    /**
     * The user's own browser (Edge on the laptop), through omp's relay run by the app while chosen: its relay extension
     * connects to 127.0.0.1:9224 on the laptop, which `link` carries to the server.
     */
    edge: z
      .object({
        running: z.boolean(),
        /** The extension is connected: chats can drive the browser now. */
        connected: z.boolean(),
        /** The browser's name and version, as the extension says. */
        browser: z.string().nullable(),
        tabs: z.array(EdgeTab),
        problem: z.string().nullable(),
        /** The command that links the laptop's 127.0.0.1:9224 to the server. */
        link: z.string(),
      })
      .strict(),
  })
  .strict();
export type BrowserStatus = z.infer<typeof BrowserStatus>;

/** What the viewer did in the shown page, in the page's own CSS pixels. */
export const BrowserInput = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("mouse"),
      type: z.enum(["mousePressed", "mouseReleased", "mouseMoved"]),
      x: Coordinate,
      y: Coordinate,
      button: z.enum(["none", "left", "middle", "right"]),
      clickCount: z.number().int().min(0).max(3),
      modifiers: Modifiers,
    })
    .strict(),
  z
    .object({
      kind: z.literal("wheel"),
      x: Coordinate,
      y: Coordinate,
      deltaX: Coordinate,
      deltaY: Coordinate,
      modifiers: Modifiers,
    })
    .strict(),
  z
    .object({
      kind: z.literal("key"),
      type: z.enum(["keyDown", "keyUp"]),
      key: z.string().min(1).max(40),
      code: z.string().max(40),
      /** The text a key down types, when it types one. */
      text: z.string().min(1).max(8).optional(),
      keyCode: z.number().int().min(0).max(255),
      modifiers: Modifiers,
    })
    .strict(),
  z.object({ kind: z.literal("text"), text: z.string().min(1).max(10_000) }).strict(),
]);
export type BrowserInput = z.infer<typeof BrowserInput>;

export const BrowserGo = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("url"), url: z.string().min(1).max(4_000) }).strict(),
  z.object({ kind: z.literal("back") }).strict(),
  z.object({ kind: z.literal("forward") }).strict(),
  z.object({ kind: z.literal("reload") }).strict(),
]);
export type BrowserGo = z.infer<typeof BrowserGo>;

/** One picture of the shown page: a JPEG, and the size the page was drawn at. */
export const BrowserFrame = z
  .object({ data: z.string(), width: z.number().int(), height: z.number().int() })
  .strict();
export type BrowserFrame = z.infer<typeof BrowserFrame>;

const IdArgs = z.object({ id: TabId }).strict();

/**
 * The app's own browser (Browser and relay control, B2): its state and tabs, opening and showing pages, the viewer's
 * input, and the live picture of a tab, sent to `frame` subscribers scoped by the tab's id while anyone watches.
 */
export const BrowserPort = definePort({
  name: "A0.browser",
  methods: {
    status: { args: EmptyArgs, result: BrowserStatus },
    /** Starts the app's browser if it is not running. */
    start: { args: EmptyArgs, result: BrowserStatus },
    /**
     * Which browser chats use (every folder): "app" starts the app's browser and sets omp's `browser.cdpUrl` to it;
     * "edge" runs omp's relay for the user's Edge and sets `browser.relay`, until another browser is chosen; "off" takes
     * both out. A chat running already follows once it is opened again.
     */
    setTarget: { args: z.object({ target: BrowserTarget }).strict(), result: BrowserStatus },
    open: {
      args: z.object({ url: z.string().max(4_000) }).strict(),
      result: z.object({ id: TabId }).strict(),
    },
    close: { args: IdArgs, result: z.null() },
    show: { args: IdArgs, result: z.null() },
    go: { args: z.object({ id: TabId, to: BrowserGo }).strict(), result: z.null() },
    input: { args: z.object({ id: TabId, input: BrowserInput }).strict(), result: z.null() },
    /** The size the viewer shows the tab at: the page is drawn at that size while it is watched. */
    view: {
      args: z
        .object({
          id: TabId,
          width: z.number().int().min(200).max(4_000),
          height: z.number().int().min(200).max(4_000),
        })
        .strict(),
      result: z.null(),
    },
  },
  events: {
    /** The browser started or stopped, or its tabs changed. */
    changed: { payload: z.object({ at: z.number() }).strict() },
    /** A picture of the watched tab; subscribed with the tab's id as the scope. */
    frame: { payload: BrowserFrame },
  },
});
export type BrowserPort = typeof BrowserPort;
export type BrowserClient = PortClient<BrowserPort>;
export type BrowserHandlers<Context> = PortHandlers<BrowserPort, Context>;
