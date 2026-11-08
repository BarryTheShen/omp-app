import {
  AppFailure,
  type BrowserGo,
  type BrowserInput,
  BrowserPort,
  type BrowserStatus,
  type BrowserTarget,
  type StreamKey,
  streamKey,
} from "@omp-app/contracts";
import type { RelayHost } from "../../../browser/edge-relay";
import type { ServerBrowser } from "../../../browser/server-browser";
import type { Logger } from "../../../logging";
import type { PortRegistration } from "../../../registry/ports";
import type { StreamActivityListener } from "../../../replay";

/** omp's settings that name the browser chats use, for every folder. */
export type BrowserSettingKey = "browser.cdpUrl" | "browser.relay";

export interface BrowserSettings {
  /** The value set now, or null when none is. */
  read(key: BrowserSettingKey): Promise<string | boolean | null>;
  /** Sets it, or takes it out with null. */
  write(key: BrowserSettingKey, value: string | boolean | null): Promise<void>;
}

/** Whether "Your own browser" was chosen in the panel, kept across the server's restarts (its relay starts again then). */
export interface EdgeChoiceStore {
  read(): Promise<boolean>;
  write(chosen: boolean): Promise<void>;
}

export interface BrowserPortContext {
  /** The app's browser; null when no Chrome was found on this machine. */
  readonly browser: ServerBrowser | null;
  /** omp's relay for the user's own browser. */
  readonly edge: RelayHost;
  /** The command that links the laptop's relay port to this machine. */
  readonly edgeLink: string;
  readonly edgeChoice: EdgeChoiceStore;
  readonly settings: BrowserSettings;
  /** Publishes an event into the replay hub. */
  readonly publish: (stream: StreamKey, payload: unknown) => unknown;
  /** Delivers an event to its subscribers now and keeps no copy (the frames). */
  readonly publishLive: (stream: StreamKey, payload: unknown) => void;
  /** First and last subscriber of every stream that begins with a prefix. */
  readonly watchStreams: (prefix: string, listener: StreamActivityListener) => () => void;
  readonly now?: () => number;
  readonly logger?: Logger;
}

export interface BrowserRuntime {
  readonly registration: PortRegistration;
  /** Settles the checks made at start (tests wait for it). */
  readonly ready: Promise<void>;
  stop(): Promise<void>;
}

const unavailable = (message: string) =>
  new AppFailure({ code: "unavailable", message, retryable: true });

/** The size a tab is drawn at until its viewer says. */
const DEFAULT_SIZE = { width: 1280, height: 800 } as const;
/** How often the relay is looked at while chats use it. */
const EDGE_POLL_MS = 2_000;

/**
 * The Browser panel's port (B2, B4, B5, B7): the app's browser's state and tabs, pages opened and shown, the viewer's
 * input, the live picture of a tab while anyone watches it (`frame` scoped by the tab's id), and which browser chats use.
 * The picture starts with the first watcher and stops with the last; frames are delivered live and never kept.
 *
 * Which browser chats use is omp's own settings: `browser.relay` (the user's own browser; whoever set it) before
 * `browser.cdpUrl` (the app's browser when it names it). "Your own browser", chosen in the panel or set in omp's settings
 * by hand, stays until another browser is chosen here; one chosen in the panel has its relay started again after a
 * restart. When chats use the app's browser, it starts with the server.
 */
export function createBrowserRuntime(context: BrowserPortContext): BrowserRuntime {
  const { browser, edge, settings } = context;
  const now = context.now ?? Date.now;
  const changed = streamKey(BrowserPort.name, "changed");
  const framePrefix = `${BrowserPort.name}/frame/`;
  const announce = () => context.publish(changed, { at: now() });
  let problem: string | null =
    browser === null ? "No Chrome or Chromium was found on the server's machine." : null;
  const sizes = new Map<string, { width: number; height: number }>();
  /** The pictures being sent, by tab: how to stop each. */
  const watching = new Map<string, Promise<() => Promise<void>>>();
  let edgePoll: ReturnType<typeof setInterval> | undefined;
  let edgeSeen = "";

  const target = async (): Promise<BrowserTarget> => {
    if ((await settings.read("browser.relay")) === true) return "edge";
    const address = browser?.address() ?? null;
    return address !== null && (await settings.read("browser.cdpUrl")) === address ? "app" : "off";
  };
  const status = async (): Promise<BrowserStatus> => {
    const relay = edge.state();
    return {
      target: await target(),
      app: {
        available: browser !== null,
        running: browser?.running ?? false,
        problem,
        tabs: [...(browser?.tabs() ?? [])],
        front: browser?.front() ?? null,
      },
      edge: { ...relay, tabs: [...relay.tabs], link: context.edgeLink },
    };
  };
  const needBrowser = (): ServerBrowser => {
    if (browser === null) throw unavailable(problem ?? "The app's browser is not available.");
    return browser;
  };
  const start = async (running: ServerBrowser): Promise<void> => {
    try {
      await running.start();
    } catch (error) {
      problem = error instanceof Error ? error.message : String(error);
      announce();
      throw unavailable(problem);
    }
  };

  /** Looks at the relay and tells the panel when what it shows changed. */
  const lookAtEdge = async (): Promise<void> => {
    const state = await edge.refresh();
    const seen = JSON.stringify([
      state.running,
      state.connected,
      state.browser,
      state.tabs,
      state.problem,
    ]);
    if (seen === edgeSeen) return;
    edgeSeen = seen;
    announce();
  };
  const watchEdge = (): void => {
    edgePoll ??= setInterval(() => void lookAtEdge(), EDGE_POLL_MS);
  };
  /** Chats stop using the user's Edge: the setting goes, and the app's own relay with it. */
  const edgeOff = async (): Promise<void> => {
    await context.edgeChoice.write(false);
    clearInterval(edgePoll);
    edgePoll = undefined;
    if ((await settings.read("browser.relay")) !== null)
      await settings.write("browser.relay", null);
    edge.stop();
    await lookAtEdge();
  };
  /** Chats use the user's Edge, until another browser is chosen: the setting, and the app's own relay running. */
  const edgeOn = async (): Promise<void> => {
    if ((await settings.read("browser.relay")) !== true)
      await settings.write("browser.relay", true);
    await context.edgeChoice.write(true);
    watchEdge();
    try {
      await edge.ensure();
    } finally {
      await lookAtEdge();
    }
  };
  /** The app's browser stops being the chats' one, when it is. */
  const releaseApp = async (): Promise<void> => {
    const address = browser?.address() ?? null;
    if (address !== null && (await settings.read("browser.cdpUrl")) === address)
      await settings.write("browser.cdpUrl", null);
  };

  const stopWatching = async (id: string): Promise<void> => {
    const stopping = watching.get(id);
    watching.delete(id);
    if (stopping !== undefined) await (await stopping.catch(() => async () => undefined))();
  };
  const startWatching = (id: string): void => {
    if (browser === null || watching.has(id)) return;
    const stream = streamKey(BrowserPort.name, "frame", id);
    const started = browser.watch(id, sizes.get(id) ?? DEFAULT_SIZE, (frame) =>
      context.publishLive(stream, frame),
    );
    started.catch((error: unknown) => {
      watching.delete(id);
      context.logger?.warn("browser.watch_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    watching.set(id, started);
  };

  const stopTabs = browser?.onTabs(() => announce()) ?? (() => undefined);
  const stopRunning =
    browser?.onRunning((running) => {
      if (running) problem = null;
      else watching.clear();
      announce();
    }) ?? (() => undefined);
  const stopStreams = context.watchStreams(framePrefix, (stream, active) => {
    const id = stream.slice(framePrefix.length);
    if (active) startWatching(id);
    else void stopWatching(id);
  });
  // At start: "Your own browser" chosen in the panel gets its relay again; one set by hand is watched. The app's browser,
  // when chats use it, starts now so its setting reaches a running browser.
  const ready = (async () => {
    if (await context.edgeChoice.read()) {
      await edgeOn();
    } else if ((await target()) === "edge") {
      watchEdge();
      await lookAtEdge();
    }
    if (browser !== null && (await target()) === "app") await start(browser);
  })().catch((error: unknown) =>
    context.logger?.warn("browser.start_check_failed", {
      error: error instanceof Error ? error.message : String(error),
    }),
  );

  const handlers = {
    status: async (): Promise<BrowserStatus> => status(),
    start: async (): Promise<BrowserStatus> => {
      await start(needBrowser());
      return status();
    },
    setTarget: async (args: unknown): Promise<BrowserStatus> => {
      const { target: wanted } = args as { target: BrowserTarget };
      if (wanted === "app") {
        const running = needBrowser();
        await edgeOff();
        await start(running);
        await settings.write("browser.cdpUrl", running.address());
      } else if (wanted === "edge") {
        await releaseApp();
        try {
          await edgeOn();
        } catch (error) {
          announce();
          throw unavailable(error instanceof Error ? error.message : String(error));
        }
      } else {
        await edgeOff();
        await releaseApp();
      }
      announce();
      return status();
    },
    open: async (args: unknown): Promise<{ id: string }> => {
      const { url } = args as { url: string };
      return { id: await needBrowser().open(url) };
    },
    close: async (args: unknown): Promise<null> => {
      const { id } = args as { id: string };
      await stopWatching(id);
      await needBrowser().close(id);
      return null;
    },
    show: async (args: unknown): Promise<null> => {
      await needBrowser().show((args as { id: string }).id);
      return null;
    },
    go: async (args: unknown): Promise<null> => {
      const { id, to } = args as { id: string; to: BrowserGo };
      await needBrowser().go(id, to);
      return null;
    },
    input: async (args: unknown): Promise<null> => {
      const { id, input } = args as { id: string; input: BrowserInput };
      await needBrowser().input(id, input);
      return null;
    },
    view: async (args: unknown): Promise<null> => {
      const { id, width, height } = args as { id: string; width: number; height: number };
      const before = sizes.get(id);
      sizes.set(id, { width, height });
      // A tab being watched is drawn again at the new size.
      if (watching.has(id) && (before?.width !== width || before?.height !== height)) {
        await stopWatching(id);
        startWatching(id);
      }
      return null;
    },
  };

  return {
    registration: { port: BrowserPort, context, handlers },
    ready,
    async stop() {
      stopStreams();
      stopTabs();
      stopRunning();
      clearInterval(edgePoll);
      edge.stop();
      for (const id of [...watching.keys()]) await stopWatching(id);
      await browser?.stop();
    },
  };
}
