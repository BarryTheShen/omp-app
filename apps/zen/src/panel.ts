import { appAddressOf, type HostContext, openPanel } from "@omp-app/embed";
import { keepKeyFor, keyFor, saveAppAddress, storedAppAddress } from "./address";
import { watchSelection } from "./page";
import { appOrigins, firefoxTabs, pageTools, type TabScope } from "./tools";

/**
 * The sidebar's panel. Opened on a tab (the toolbar button binds the panel to the tab it was pressed on), it shows omp
 * app's chat for that tab: the chat it showed there before, signed in with this browser's key. Each tab has its own
 * panel (`sidebarAction.setPanel` with `?tab=`); a tab that has none yet offers to start one.
 */

const root = document.getElementById("panel") as HTMLElement;

/** The tab this panel was opened on, from its address; null for the panel of a tab that has none yet. */
function boundTabOf(search: string): number | null {
  const asked = Number(new URLSearchParams(search).get("tab"));
  return Number.isInteger(asked) && asked > 0 ? asked : null;
}

const chatKey = (tabId: number): string => `chat:${tabId}`;
const ownedKey = (tabId: number): string => `owned:${tabId}`;

/** Binds the panel to a tab: from now on, that tab shows this panel, with its own chat. */
async function bindTo(tabId: number): Promise<void> {
  const panel = browser.runtime.getURL(`panel.html?tab=${tabId}`);
  await browser.sidebarAction.setPanel({ tabId, panel });
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
      textContent:
        "Where is omp app? Its address, as you open it in a browser. In omp app, also turn on Settings → App → Integrations → Firefox and Zen extensions.",
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

/** A tab with no chat yet: the person starts one, so passing tabs start nothing. */
async function offerChat(): Promise<void> {
  const [active] = await browser.tabs.query({ active: true, currentWindow: true });
  if (active?.id === undefined) {
    root.replaceChildren(
      element("p", { className: "setup", textContent: "No tab to chat about." }),
    );
    return;
  }
  const tabId = active.id;
  const start = element("button", { type: "button", textContent: "Chat about this tab" });
  start.addEventListener("click", () => {
    // The person may have switched tabs since this was shown: only the tab it names is bound.
    void browser.tabs.query({ active: true, currentWindow: true }).then(([now]) => {
      if (now?.id === tabId) void bindTo(tabId);
      else void offerChat();
    });
  });
  root.replaceChildren(
    element("div", { className: "setup" }, [
      element("h1", { textContent: "omp app" }),
      element("p", {
        textContent: `${active.title || "This tab"}: a chat here can read and act on this tab, and on tabs it opens, and no other.`,
      }),
      start,
    ]),
  );
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
}

async function start(): Promise<void> {
  const app = await storedAppAddress();
  if (app === null) {
    askForAddress();
    return;
  }
  const bound = boundTabOf(location.search);
  if (bound === null) {
    // The panel of tabs that have none of their own: it follows the tab in front.
    browser.tabs.onActivated.addListener(() => void offerChat());
    await offerChat();
    return;
  }
  try {
    await browser.tabs.get(bound);
  } catch {
    // The tab closed: its panel offers the tab now shown instead.
    await offerChat();
    return;
  }
  await showChat(app, bound);
}

void start();
