import { appAddressOf, type HostContext, openPanel } from "@omp-app/embed";
import { keepKeyFor, keyFor, saveAppAddress, storedAppAddress } from "./address";
import { watchSelection } from "./page";
import { appOrigins, firefoxTabs, pageTools, type TabScope } from "./tools";

/**
 * The sidebar's panel: omp app's chat for a tab, the chat it showed there before when there was one, signed in with this
 * browser's key. Each tab has its own panel (`sidebarAction.setPanel` with `?tab=`). The toolbar button binds the panel
 * to the tab it was pressed on, and the panel of tabs that have none yet binds the tab in front by itself, on load and
 * whenever another tab comes to the front, so a tab gets its chat as soon as the sidebar shows it.
 */

const root = document.getElementById("panel") as HTMLElement;

/** The tab this panel was opened on, from its address; null for the panel of a tab that has none yet. */
function boundTabOf(search: string): number | null {
  const asked = Number(new URLSearchParams(search).get("tab"));
  return Number.isInteger(asked) && asked > 0 ? asked : null;
}

const chatKey = (tabId: number): string => `chat:${tabId}`;
const ownedKey = (tabId: number): string => `owned:${tabId}`;

/** Counts each look for the tab in front (`bindActive`): only the latest may move the panel. */
let latestBind = 0;

/**
 * Binds the panel to a tab: from now on, that tab shows this panel, with its own chat. The person may have gone to
 * another tab while this waited, and the panel must never end up on a tab that is not in front: then it asks again.
 */
async function bindTo(tabId: number, generation: number): Promise<void> {
  const panel = browser.runtime.getURL(`panel.html?tab=${tabId}`);
  await browser.sidebarAction.setPanel({ tabId, panel });
  if (generation !== latestBind) return;
  const [front] = await browser.tabs.query({ active: true, currentWindow: true });
  if (generation !== latestBind) return;
  if (front?.id !== tabId) {
    await bindActive();
    return;
  }
  location.replace(panel);
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

/** The tab in front gets its chat as soon as the sidebar shows it: nothing is asked. */
async function bindActive(): Promise<void> {
  const generation = ++latestBind;
  const [active] = await browser.tabs.query({ active: true, currentWindow: true });
  // A newer call knows better which tab is in front: it alone goes on.
  if (generation !== latestBind) return;
  if (active?.id === undefined) {
    root.replaceChildren(
      element("p", { className: "setup", textContent: "No tab to chat about." }),
    );
    return;
  }
  await bindTo(active.id, generation);
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

/** The chat for the bound tab. */
async function showChat(app: string, tabId: number): Promise<void> {
  const session = await browser.storage.session.get([chatKey(tabId), ownedKey(tabId)]);
  const chat = session[chatKey(tabId)];
  const ownedSaved = session[ownedKey(tabId)];
  const owned = new Set<number>(
    Array.isArray(ownedSaved)
      ? ownedSaved.filter((id): id is number => typeof id === "number")
      : [],
  );
  const scope: TabScope = {
    bound: tabId,
    owned,
    own(id) {
      owned.add(id);
      void browser.storage.session.set({ [ownedKey(tabId)]: [...owned] });
    },
  };
  browser.tabs.onRemoved.addListener((closed) => {
    if (owned.delete(closed)) void browser.storage.session.set({ [ownedKey(tabId)]: [...owned] });
  });

  let tab = await browser.tabs.get(tabId);
  let selection = "";
  const panel = openPanel({
    app,
    into: root,
    host: "zen",
    title: "omp app",
    ...(typeof chat === "string" ? { chat } : {}),
    context: contextOf(tab, selection),
    tools: pageTools(scope, firefoxTabs, app),
    keys: {
      get: () => keyFor(app),
      set: (key) => keepKeyFor(app, key),
    },
    onReady: (ready) => void browser.storage.session.set({ [chatKey(tabId)]: ready.chat }),
  });

  const watch = (): void => {
    void firefoxTabs.run(tabId, watchSelection, [appOrigins(app)]).catch(() => undefined);
  };
  watch();
  browser.tabs.onUpdated.addListener((updated, change, next) => {
    if (updated !== tabId) return;
    tab = next;
    if (change.url !== undefined) selection = "";
    if (change.status === "complete") watch();
    if (change.title !== undefined || change.url !== undefined || change.status === "complete")
      panel.setContext(contextOf(tab, selection));
  });
  browser.runtime.onMessage.addListener((message, sender) => {
    if (sender.tab?.id !== tabId) return;
    const sent = message as { type?: unknown; selection?: unknown };
    if (sent.type !== "omp-app-selection" || typeof sent.selection !== "string") return;
    selection = sent.selection.trim();
    panel.setContext(contextOf(tab, selection));
  });
  // The person went to another tab of this window while this panel still shows the one it is bound to: the panel then
  // follows the tab in front, as the sidebar's own switch would (the other tab may have a panel of its own, or none).
  browser.tabs.onActivated.addListener((now) => {
    if (now.windowId === tab.windowId && now.tabId !== tabId) void bindActive();
  });
}

async function start(): Promise<void> {
  const app = await storedAppAddress();
  if (app === null) {
    askForAddress();
    return;
  }
  const bound = boundTabOf(location.search);
  if (bound === null) {
    // The panel of tabs that have none of their own: it binds the tab in front, and again when another comes to the front.
    browser.tabs.onActivated.addListener(() => void bindActive());
    await bindActive();
    return;
  }
  try {
    await browser.tabs.get(bound);
  } catch {
    // The tab closed: its panel binds the tab now in front instead.
    await bindActive();
    return;
  }
  await showChat(app, bound);
}

void start();
