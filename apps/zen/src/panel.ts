import { appAddressOf, type HostContext, openPanel } from "@omp-app/embed";
import { keepKeyFor, keyFor, STORED, saveAppAddress, storedAppAddress } from "./address";
import { Follower } from "./follow";
import { watchSelection } from "./page";
import { appOrigins, firefoxTabs, pageTools, type TabScope } from "./tools";

/**
 * The sidebar's panel: one for the window, open and loaded while you go from tab to tab, with one chat (the window's,
 * kept while the browser runs), signed in with this browser's key. The chat is pointed at the tab in front: each
 * message carries that tab, and the page tools act on it (`Follower`: while a reply runs, on the tab in front when it
 * began) and on the tabs the chat opened.
 */

const root = document.getElementById("panel") as HTMLElement;

const chatKey = (windowId: number): string => `chat:window:${windowId}`;
const ownedKey = (windowId: number): string => `owned:window:${windowId}`;

/**
 * The window this panel serves: the sidebar's own, or, for the panel's page opened as a tab of its own (the tests open
 * it so: WebDriver cannot reach the sidebar), the window `?window=` names. In the sidebar the page is no tab, so its
 * address cannot point it at another window.
 */
async function servedWindow(search: string): Promise<number | undefined> {
  const named = Number(new URLSearchParams(search).get("window"));
  const asTab = await browser.tabs.getCurrent().catch(() => undefined);
  if (Number.isInteger(named) && named > 0 && asTab !== undefined) return named;
  return (await browser.windows.getCurrent()).id;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  properties: Partial<HTMLElementTagNameMap[K]> = {},
  children: readonly (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const made = Object.assign(document.createElement(tag), properties);
  made.append(...children);
  return made;
}

/** The first open: where omp app is. */
function askForAddress(): void {
  const field = element("input", {
    type: "url",
    placeholder: "https://omp.example.com",
    required: true,
  });
  field.setAttribute("aria-label", "omp app's address");
  const problem = element("p", { className: "problem", role: "alert" });
  const form = element("form", {}, [
    element("h1", { textContent: "omp app" }),
    element("p", {
      textContent: "Where is omp app? Its address, as you open it in a browser.",
    }),
    field,
    element("button", { type: "submit", textContent: "Save" }),
    problem,
  ]);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const checked = appAddressOf(field.value);
    if ("problem" in checked) {
      problem.textContent = checked.problem;
      return;
    }
    void saveAppAddress(checked.address).then(() => location.reload());
  });
  root.replaceChildren(element("div", { className: "setup" }, [form]));
  field.focus();
}

/** A tab's address as it goes with each message: no query and no fragment, where sign-in codes and tokens travel. */
function bareAddress(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.origin === "null"
      ? `${parsed.protocol}${parsed.pathname}`
      : `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.split(/[?#]/)[0] ?? "";
  }
}

/** What the tab shows, as the chat's messages carry it. */
function contextOf(tab: browser.tabs.Tab, selection: string): HostContext {
  let fallback = "Untitled page";
  try {
    if (tab.url !== undefined) fallback = new URL(tab.url).hostname || fallback;
  } catch {
    // Not an address: the fallback stays.
  }
  const title = (tab.title ?? "").trim().slice(0, 300) || fallback;
  return {
    kind: "page",
    title,
    ...(tab.url === undefined ? {} : { uri: bareAddress(tab.url).slice(0, 2_000) }),
    ...(selection === "" ? {} : { selection: selection.slice(0, 8_000) }),
  };
}

/** The window's chat, pointed at the tab in front of the window. */
async function showChat(app: string, windowId: number): Promise<void> {
  const session = await browser.storage.session.get([chatKey(windowId), ownedKey(windowId)]);
  const chat = session[chatKey(windowId)];
  const ownedSaved = session[ownedKey(windowId)];
  const owned = new Set<number>(
    Array.isArray(ownedSaved)
      ? ownedSaved.filter((id): id is number => typeof id === "number")
      : [],
  );
  const follower = new Follower();
  const scope: TabScope = {
    get bound(): number {
      return follower.bound();
    },
    owned,
    own(id) {
      owned.add(id);
      void browser.storage.session.set({ [ownedKey(windowId)]: [...owned] });
    },
  };
  /** What each tab of the window has selected, by the person's own pointer or keys (`watchSelection`). */
  const selections = new Map<number, string>();
  let front: browser.tabs.Tab | undefined;
  const contextNow = (): HostContext | null =>
    front === undefined ? null : contextOf(front, selections.get(front.id ?? -1) ?? "");

  [front] = await browser.tabs.query({ active: true, windowId });
  follower.front(front?.id ?? null);
  const panel = openPanel({
    app,
    into: root,
    host: "zen",
    title: "omp app",
    ...(typeof chat === "string" ? { chat } : {}),
    context: contextNow(),
    tools: pageTools(scope, firefoxTabs, app),
    keys: {
      get: () => keyFor(app),
      set: (key) => keepKeyFor(app, key),
    },
    onReady: (ready) => void browser.storage.session.set({ [chatKey(windowId)]: ready.chat }),
    onTurn: (working, sent) => follower.turn(working, sent),
  });

  const watch = (tabId: number): void => {
    void firefoxTabs.run(tabId, watchSelection, [appOrigins(app)]).catch(() => undefined);
  };
  /** The tab now in front: the chat is pointed at it, as the chip under the box shows. */
  const show = (tab: browser.tabs.Tab): void => {
    front = tab;
    follower.front(tab.id ?? null);
    panel.setContext(contextNow());
  };
  if (front?.id !== undefined) watch(front.id);

  /** The latest tab brought to the front: an earlier switch's answer that comes after it is dropped. */
  let latest = front?.id;
  browser.tabs.onActivated.addListener((now) => {
    if (now.windowId !== windowId) return;
    latest = now.tabId;
    void browser.tabs
      .get(now.tabId)
      .then((tab) => {
        if (latest !== now.tabId) return;
        show(tab);
        watch(now.tabId);
      })
      .catch(() => undefined);
  });
  browser.tabs.onUpdated.addListener((updated, change, next) => {
    if (change.url !== undefined) selections.delete(updated);
    if (updated !== front?.id) return;
    if (change.status === "complete") watch(updated);
    if (change.title !== undefined || change.url !== undefined || change.status === "complete")
      show(next);
  });
  browser.tabs.onRemoved.addListener((closed) => {
    selections.delete(closed);
    if (owned.delete(closed))
      void browser.storage.session.set({ [ownedKey(windowId)]: [...owned] });
  });
  browser.runtime.onMessage.addListener((message, sender) => {
    const from = sender.tab;
    if (from?.id === undefined || from.windowId !== windowId) return;
    const sent = message as { type?: unknown; selection?: unknown };
    if (sent.type !== "omp-app-selection" || typeof sent.selection !== "string") return;
    selections.set(from.id, sent.selection.trim());
    if (from.id === front?.id) panel.setContext(contextNow());
  });
  // A switch between the first look and the listeners above was not heard: look once more.
  const [now] = await browser.tabs.query({ active: true, windowId });
  if (now?.id !== undefined && now.id !== front?.id && latest === front?.id) {
    latest = now.id;
    show(now);
    watch(now.id);
  }
}

async function start(): Promise<void> {
  const app = await storedAppAddress();
  if (app === null) {
    askForAddress();
    return;
  }
  const windowId = await servedWindow(location.search);
  if (windowId === undefined) {
    root.replaceChildren(
      element("p", { className: "setup", textContent: "No window to chat beside." }),
    );
    return;
  }
  await showChat(app, windowId);
  // Options changed where omp app is (and forgot the key): the panel loads again, for the new address.
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && STORED.app in changes) location.reload();
  });
}

void start();
