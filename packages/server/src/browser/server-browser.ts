import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { delimiter, join } from "node:path";
import type { Logger } from "../logging";
import { CdpConnection, type CdpEvent } from "./cdp";

/** A page in the server's browser. */
export interface BrowserTab {
  readonly id: string;
  readonly url: string;
  readonly title: string;
}

/** What the viewer did, in the page's own CSS pixels: the browser gets it as its own input. */
export type BrowserInput =
  | {
      readonly kind: "mouse";
      readonly type: "mousePressed" | "mouseReleased" | "mouseMoved";
      readonly x: number;
      readonly y: number;
      readonly button: "none" | "left" | "middle" | "right";
      readonly clickCount: number;
      readonly modifiers: number;
    }
  | {
      readonly kind: "wheel";
      readonly x: number;
      readonly y: number;
      readonly deltaX: number;
      readonly deltaY: number;
      readonly modifiers: number;
    }
  | {
      readonly kind: "key";
      readonly type: "keyDown" | "keyUp";
      readonly key: string;
      readonly code: string;
      /** The text a key down types, when it types one. */
      readonly text?: string;
      readonly keyCode: number;
      readonly modifiers: number;
    }
  | { readonly kind: "text"; readonly text: string };

/** One frame of the shown page: a JPEG, and the size it was drawn at. */
export interface BrowserFrame {
  readonly data: string;
  readonly width: number;
  readonly height: number;
}

export type BrowserGo =
  | { readonly kind: "url"; readonly url: string }
  | { readonly kind: "back" }
  | { readonly kind: "forward" }
  | { readonly kind: "reload" };

export interface ServerBrowserOptions {
  /** The Chrome or Chromium to run. */
  readonly chrome: string;
  /** Its profile: sign-ins and cookies stay here across restarts. */
  readonly profileDir: string;
  /** Its DevTools port on 127.0.0.1, which omp's browser tool attaches to (`browser.cdpUrl`); 0 lets Chrome choose one. */
  readonly port: number;
  /**
   * Runs Chrome without its sandbox: only where the sandbox cannot start (a container without user namespaces, as the
   * tests run in). It weakens Chrome against a hostile page, so it is never the default.
   */
  readonly noSandbox?: boolean;
  readonly logger?: Logger;
}

/** The DevTools port the app's browser uses unless told another. */
export const SERVER_BROWSER_PORT = 9333;
/** How often Chrome's tab list is read again for new titles. */
const TAB_SYNC_MS = 1_000;
/**
 * How long an input may go unanswered. Chrome answers at once a tab that is in front, and never one that is behind
 * another (its page neither draws nor takes input there): such an input fails in this time instead of waiting for good.
 */
const INPUT_MS = 5_000;

/**
 * What the browser tells websites it is: plain Chrome of its own version, as a desktop Chrome on Linux says it. Headless
 * Chrome says "HeadlessChrome", which sites such as Google's sign-in refuse as a browser driven by software; its client
 * hints already name Google Chrome. Null when the version cannot be read: the browser then says what it says itself.
 */
export function chromeUserAgent(versionLine: string): string | null {
  const major = /(\d+)\.\d+\.\d+\.\d+/.exec(versionLine)?.[1];
  if (major === undefined) return null;
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

/** The Chrome's own version line (`Google Chrome 156.0.8078.73`); empty when it cannot be run within 10 s. */
async function chromeVersion(chrome: string): Promise<string> {
  try {
    const run = Bun.spawn([chrome, "--version"], { stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => run.kill(), 10_000);
    const text = await new Response(run.stdout).text();
    clearTimeout(timer);
    return text;
  } catch {
    return "";
  }
}

/** The Chrome on this machine: `OMP_APP_CHROME`, or the first of the usual names on the path; null when there is none. */
export function findChrome(env: Record<string, string | undefined>): string | null {
  if (env.OMP_APP_CHROME !== undefined && env.OMP_APP_CHROME !== "") return env.OMP_APP_CHROME;
  for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"])
    for (const folder of (env.PATH ?? "").split(delimiter)) {
      const candidate = join(folder, name);
      if (folder !== "" && existsSync(candidate)) return candidate;
    }
  return null;
}

/** An address as typed: a scheme is kept, a bare name gets `https://`. */
export function addressOf(typed: string): string {
  const trimmed = typed.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

/**
 * The app's own browser (a Chrome on the server's machine): its pages listed as they change, the shown page streamed as
 * frames while someone watches, and the viewer's input sent to it. omp's browser tool drives the same browser through its
 * DevTools port, so the user and the agent share its tabs and sign-ins. Started headless: the frames are the page itself.
 */
export class ServerBrowser {
  readonly #options: ServerBrowserOptions;
  #child: ChildProcess | null = null;
  #cdp: CdpConnection | null = null;
  #starting: Promise<void> | null = null;
  /** The DevTools port Chrome listens on, as it wrote it. */
  #port: number | null = null;
  readonly #tabs = new Map<string, BrowserTab>();
  readonly #sessions = new Map<string, Promise<string>>();
  readonly #tabListeners = new Set<(tabs: readonly BrowserTab[]) => void>();
  readonly #stateListeners = new Set<(running: boolean) => void>();
  /**
   * The tab in front, which draws and takes input; null while none is known to be there. A new tab comes to the front,
   * whoever opens it (the panel, a chat, a page); a tab is brought there by `show` and by the input meant for it.
   */
  #front: string | null = null;
  /** Tabs with a mouse move on its way: another move to them is left out, as the next one carries the pointer. */
  readonly #moving = new Set<string>();
  /** Chrome lists the tabs it has while target discovery starts: those are not new tabs coming to the front. */
  #discovering = false;
  /** Chrome tells a tab's new address but not its new title: the list is read again every second while it runs. */
  #sync: ReturnType<typeof setInterval> | undefined;

  constructor(options: ServerBrowserOptions) {
    this.#options = options;
  }

  get running(): boolean {
    return this.#cdp !== null && !this.#cdp.closed;
  }

  /** The address omp's browser tool attaches to; null while the browser is not running. */
  cdpUrl(): string | null {
    return this.running && this.#port !== null ? `http://127.0.0.1:${this.#port}` : null;
  }

  /**
   * The address omp's settings name for this browser, running or not: its port as configured, or the one Chrome chose
   * once it runs; null for a chosen port before the first start.
   */
  address(): string | null {
    const port = this.#port ?? (this.#options.port > 0 ? this.#options.port : null);
    return port === null ? null : `http://127.0.0.1:${port}`;
  }

  tabs(): readonly BrowserTab[] {
    return [...this.#tabs.values()];
  }

  /** The tab in front: the one that draws and takes input; null while none is known to be there. */
  front(): string | null {
    return this.#front;
  }

  onTabs(listener: (tabs: readonly BrowserTab[]) => void): () => void {
    this.#tabListeners.add(listener);
    return () => this.#tabListeners.delete(listener);
  }

  onRunning(listener: (running: boolean) => void): () => void {
    this.#stateListeners.add(listener);
    return () => this.#stateListeners.delete(listener);
  }

  /** Starts the browser, once; a second call while it starts waits for the first. */
  start(): Promise<void> {
    if (this.running) return Promise.resolve();
    this.#starting ??= this.#start().finally(() => {
      this.#starting = null;
    });
    return this.#starting;
  }

  async #start(): Promise<void> {
    const { chrome, profileDir, port, logger, noSandbox } = this.#options;
    await mkdir(profileDir, { recursive: true });
    const portFile = join(profileDir, "DevToolsActivePort");
    await rm(portFile, { force: true });
    const userAgent = chromeUserAgent(await chromeVersion(chrome));
    const child = spawn(
      chrome,
      [
        "--headless=new",
        `--remote-debugging-port=${port}`,
        "--remote-debugging-address=127.0.0.1",
        `--user-data-dir=${profileDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-blink-features=AutomationControlled",
        "--mute-audio",
        "--window-size=1280,800",
        ...(userAgent === null ? [] : [`--user-agent=${userAgent}`]),
        ...(noSandbox === true ? ["--no-sandbox"] : []),
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    // Chrome says where DevTools listens on its error output; it writes `DevToolsActivePort` only for a port it chose
    // itself (Chrome 156 with the fixed 9333 wrote none, so the app waited out its 20 s).
    let early = "";
    let listening: DevToolsAddress | null = null;
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr = `${stderr}${text}`.slice(-2_000);
      if (listening === null && early.length < 64_000) {
        early += text;
        listening = devToolsAddress(early);
      }
    });
    this.#child = child;
    // A program that cannot start emits an error and may never exit: either ends the wait, and neither reaches the app.
    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.once("error", (error) => {
        stderr = `${stderr}\n${error.message}`;
        resolve();
      });
    });
    const active = await waitForDevTools(() => listening, portFile, exited);
    if (active === null) {
      child.kill("SIGKILL");
      this.#child = null;
      throw new Error(`The app's browser did not start. ${lastLine(stderr)}`.trim());
    }
    this.#port = active.port;
    const cdp = await CdpConnection.open(`ws://127.0.0.1:${active.port}${active.path}`);
    this.#cdp = cdp;
    cdp.on((event) => this.#onEvent(event));
    cdp.onClose(() => this.#onClosed());
    child.once("exit", () => cdp.close());
    this.#discovering = true;
    await cdp.send("Target.setDiscoverTargets", { discover: true });
    const { targetInfos } = await cdp.send<{ targetInfos: TargetInfo[] }>("Target.getTargets");
    this.#discovering = false;
    for (const info of targetInfos) this.#remember(info);
    // Chrome starts with one tab, in front; of several, which is in front is not known until one is shown.
    this.#front = this.#tabs.size === 1 ? ([...this.#tabs.keys()][0] ?? null) : null;
    this.#sync = setInterval(() => void this.#syncTabs(cdp), TAB_SYNC_MS);
    logger?.info("browser.started", { port: active.port, pid: child.pid ?? 0 });
    this.#tellTabs();
    for (const listener of this.#stateListeners) listener(true);
  }

  /** Opens a page in a new tab; its id. */
  async open(url: string): Promise<string> {
    const cdp = await this.#ready();
    const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", {
      url: url === "" ? "about:blank" : addressOf(url),
    });
    this.#front = targetId;
    this.#tellTabs();
    return targetId;
  }

  async close(id: string): Promise<void> {
    const cdp = await this.#ready();
    await cdp.send("Target.closeTarget", { targetId: id });
  }

  /** Brings a tab to the front, where the browser and the agent see it as the active one. */
  async show(id: string): Promise<void> {
    const cdp = await this.#ready();
    await cdp.send("Target.activateTarget", { targetId: id });
    this.#front = id;
    this.#tellTabs();
  }

  async go(id: string, to: BrowserGo): Promise<void> {
    const cdp = await this.#ready();
    const session = await this.#session(id);
    if (to.kind === "url") {
      await cdp.send("Page.navigate", { url: addressOf(to.url) }, session);
      return;
    }
    if (to.kind === "reload") {
      await cdp.send("Page.reload", {}, session);
      return;
    }
    const history = await cdp.send<{
      currentIndex: number;
      entries: { id: number }[];
    }>("Page.getNavigationHistory", {}, session);
    const entry = history.entries[history.currentIndex + (to.kind === "back" ? -1 : 1)];
    if (entry !== undefined)
      await cdp.send("Page.navigateToHistoryEntry", { entryId: entry.id }, session);
  }

  /**
   * Sends the viewer's input to a tab. A click, a key, the wheel or text brings the tab to the front first, as a click
   * on a tab does: Chrome leaves input to a tab behind another unanswered. A mouse move to a tab that is not in front is
   * left out instead (it would bring the tab forward on a mere pass of the pointer), and so is one while another move to
   * the tab is on its way.
   */
  async input(id: string, input: BrowserInput): Promise<void> {
    const cdp = await this.#ready();
    const session = await this.#session(id);
    if (input.kind === "mouse" && input.type === "mouseMoved") {
      if (this.#front !== id || this.#moving.has(id)) return;
      this.#moving.add(id);
      try {
        await this.#dispatch(cdp, session, "Input.dispatchMouseEvent", {
          type: input.type,
          x: input.x,
          y: input.y,
          button: input.button,
          clickCount: input.clickCount,
          modifiers: input.modifiers,
        });
      } finally {
        this.#moving.delete(id);
      }
      return;
    }
    if (this.#front !== id) await this.show(id);
    switch (input.kind) {
      case "mouse":
        await this.#dispatch(cdp, session, "Input.dispatchMouseEvent", {
          type: input.type,
          x: input.x,
          y: input.y,
          button: input.button,
          clickCount: input.clickCount,
          modifiers: input.modifiers,
        });
        return;
      case "wheel":
        await this.#dispatch(cdp, session, "Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: input.x,
          y: input.y,
          deltaX: input.deltaX,
          deltaY: input.deltaY,
          modifiers: input.modifiers,
        });
        return;
      case "key":
        await this.#dispatch(cdp, session, "Input.dispatchKeyEvent", {
          type: input.type === "keyDown" && input.text === undefined ? "rawKeyDown" : input.type,
          key: input.key,
          code: input.code,
          windowsVirtualKeyCode: input.keyCode,
          modifiers: input.modifiers,
          ...(input.text === undefined ? {} : { text: input.text, unmodifiedText: input.text }),
        });
        return;
      case "text":
        await this.#dispatch(cdp, session, "Input.insertText", { text: input.text });
        return;
    }
  }

  /**
   * One input to a tab's page, answered within `INPUT_MS`. One that is not means the tab is behind another after all
   * (a chat brought another forward): it is no longer counted as in front, so the next input brings it there, and that
   * releases the input still waiting.
   */
  async #dispatch(
    cdp: CdpConnection,
    session: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<"late">((resolve) => {
      timer = setTimeout(() => resolve("late"), INPUT_MS);
    });
    try {
      if ((await Promise.race([cdp.send(method, params, session), late])) !== "late") return;
    } finally {
      clearTimeout(timer);
    }
    this.#front = null;
    this.#tellTabs();
    throw new Error("The page did not take that input in time. Try again.");
  }

  /**
   * Streams the tab while the viewer watches: the page is drawn at the viewer's size, and every frame goes to `onFrame`
   * (acknowledged, so the browser sends the next one only after). The function returned stops it.
   */
  async watch(
    id: string,
    size: { readonly width: number; readonly height: number },
    onFrame: (frame: BrowserFrame) => void,
  ): Promise<() => Promise<void>> {
    const cdp = await this.#ready();
    const session = await this.#session(id);
    const width = Math.max(200, Math.round(size.width));
    const height = Math.max(200, Math.round(size.height));
    await cdp.send(
      "Emulation.setDeviceMetricsOverride",
      { width, height, deviceScaleFactor: 1, mobile: false },
      session,
    );
    const stopFrames = cdp.on((event) => {
      if (event.method !== "Page.screencastFrame" || event.sessionId !== session) return;
      const params = event.params as {
        data: string;
        sessionId: number;
        metadata: { deviceWidth: number; deviceHeight: number };
      };
      onFrame({
        data: params.data,
        width: params.metadata.deviceWidth,
        height: params.metadata.deviceHeight,
      });
      void cdp
        .send("Page.screencastFrameAck", { sessionId: params.sessionId }, session)
        .catch(() => undefined);
    });
    await cdp.send(
      "Page.startScreencast",
      { format: "jpeg", quality: 70, maxWidth: width, maxHeight: height },
      session,
    );
    return async () => {
      stopFrames();
      if (!cdp.closed) await cdp.send("Page.stopScreencast", {}, session).catch(() => undefined);
    };
  }

  async stop(): Promise<void> {
    const child = this.#child;
    this.#cdp?.close();
    if (child === null || child.exitCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    const killer = setTimeout(() => child.kill("SIGKILL"), 3_000);
    await exited;
    clearTimeout(killer);
  }

  async #ready(): Promise<CdpConnection> {
    await this.start();
    const cdp = this.#cdp;
    if (cdp === null || cdp.closed) throw new Error("The app's browser is not running.");
    return cdp;
  }

  /** The page session of a tab, attached once (flattened onto the browser's connection). */
  #session(id: string): Promise<string> {
    let session = this.#sessions.get(id);
    if (session === undefined) {
      session = this.#ready().then(async (cdp) => {
        const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", {
          targetId: id,
          flatten: true,
        });
        await cdp.send("Page.enable", {}, sessionId);
        return sessionId;
      });
      session.catch(() => this.#sessions.delete(id));
      this.#sessions.set(id, session);
    }
    return session;
  }

  #onEvent(event: CdpEvent): void {
    switch (event.method) {
      case "Target.targetCreated": {
        const info = event.params.targetInfo as TargetInfo;
        // A new tab comes to the front, whoever opened it: a chat's browser tool, a page's own new window.
        const fronted = info.type === "page" && !this.#discovering;
        if (fronted) this.#front = info.targetId;
        if (this.#remember(info) || fronted) this.#tellTabs();
        return;
      }
      case "Target.targetInfoChanged":
        if (this.#remember(event.params.targetInfo as TargetInfo)) this.#tellTabs();
        return;
      case "Target.targetDestroyed": {
        const id = event.params.targetId as string;
        this.#sessions.delete(id);
        this.#moving.delete(id);
        // Chrome brings another tab forward, and does not say which: none is known to be in front until one is shown.
        if (this.#front === id) this.#front = null;
        if (this.#tabs.delete(id)) this.#tellTabs();
        return;
      }
    }
  }

  /** Keeps a page target; true when the list changed. */
  #remember(info: TargetInfo): boolean {
    if (info.type !== "page") return false;
    const before = this.#tabs.get(info.targetId);
    if (before !== undefined && before.url === info.url && before.title === info.title)
      return false;
    this.#tabs.set(info.targetId, { id: info.targetId, url: info.url, title: info.title });
    return true;
  }

  #tellTabs(): void {
    const tabs = this.tabs();
    for (const listener of this.#tabListeners) listener(tabs);
  }

  /** Reads Chrome's own list of tabs: titles change without an event. */
  async #syncTabs(cdp: CdpConnection): Promise<void> {
    try {
      const { targetInfos } = await cdp.send<{ targetInfos: TargetInfo[] }>("Target.getTargets");
      let changed = false;
      const pages = new Set<string>();
      for (const info of targetInfos) {
        if (info.type !== "page") continue;
        pages.add(info.targetId);
        if (this.#remember(info)) changed = true;
      }
      for (const id of [...this.#tabs.keys()])
        if (!pages.has(id)) {
          this.#tabs.delete(id);
          this.#sessions.delete(id);
          this.#moving.delete(id);
          if (this.#front === id) this.#front = null;
          changed = true;
        }
      if (changed) this.#tellTabs();
    } catch {
      // The connection is closing: `#onClosed` ends the reading.
    }
  }

  #onClosed(): void {
    clearInterval(this.#sync);
    this.#sync = undefined;
    this.#cdp = null;
    this.#child = null;
    this.#sessions.clear();
    this.#tabs.clear();
    this.#moving.clear();
    this.#front = null;
    this.#options.logger?.info("browser.stopped", {});
    this.#tellTabs();
    for (const listener of this.#stateListeners) listener(false);
  }
}

interface TargetInfo {
  readonly targetId: string;
  readonly type: string;
  readonly url: string;
  readonly title: string;
}

/** Where Chrome's DevTools listen: the port and the browser's own path. */
export interface DevToolsAddress {
  readonly port: number;
  readonly path: string;
}

/** The address in Chrome's "DevTools listening on ws://…" line, or null when its output has none yet. */
export function devToolsAddress(output: string): DevToolsAddress | null {
  const url = /DevTools listening on (ws:\/\/\S+)/.exec(output)?.[1];
  if (url === undefined) return null;
  try {
    const parsed = new URL(url);
    const port = Number(parsed.port);
    return Number.isInteger(port) && port > 0 && parsed.pathname.length > 1
      ? { port, path: parsed.pathname }
      : null;
  } catch {
    return null;
  }
}

/**
 * Waits for Chrome's DevTools: the address from its output, or else its `DevToolsActivePort` file; null when Chrome
 * exits or 20 s pass.
 */
async function waitForDevTools(
  said: () => DevToolsAddress | null,
  file: string,
  exited: Promise<void>,
): Promise<DevToolsAddress | null> {
  let gone = false;
  void exited.then(() => {
    gone = true;
  });
  const until = Date.now() + 20_000;
  while (!gone && Date.now() < until) {
    const fromOutput = said();
    if (fromOutput !== null) return fromOutput;
    const lines = (await readFile(file, "utf8").catch(() => "")).split("\n");
    const port = Number(lines[0]?.trim());
    const path = lines[1]?.trim();
    if (Number.isInteger(port) && port > 0 && path !== undefined && path !== "")
      return { port, path };
    await Bun.sleep(100);
  }
  return null;
}

const lastLine = (text: string): string =>
  text
    .trim()
    .split("\n")
    .filter((line) => line.trim() !== "")
    .at(-1) ?? "";
