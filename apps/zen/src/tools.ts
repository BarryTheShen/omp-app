import type { EmbedToolResult, HostTool } from "@omp-app/embed";
import {
  clickTarget,
  hasText,
  type PageOutcome,
  type PageReading,
  readPage,
  scrollPage,
  typeInto,
} from "./page";

/** The tabs one panel may act on: the tab it was opened on, and the tabs it opened itself. */
export interface TabScope {
  readonly bound: number;
  readonly owned: ReadonlySet<number>;
  /** A tab this panel opened: from now on it may act on it. */
  own(tabId: number): void;
}

/** What the tools need from the browser: Firefox's `browser`, or a stand-in in tests. */
export interface TabsApi {
  run<A extends unknown[], R>(tabId: number, func: (...args: A) => R, args: A): Promise<Awaited<R>>;
  get(tabId: number): Promise<browser.tabs.Tab>;
  capture(windowId: number): Promise<string>;
  navigate(tabId: number, url: string): Promise<browser.tabs.Tab>;
  open(url: string, opener: number): Promise<browser.tabs.Tab>;
  sleep(ms: number): Promise<void>;
}

/** What a tool says on omp app's own pages: the page functions throw the same words (`page.ts`). */
export const OFF_LIMITS = "omp app's own pages are off limits to this panel.";

/** How much of a page's text `read_page` reads when not told, and at most. */
export const READ_DEFAULT_CHARS = 20_000;
export const READ_MAX_CHARS = 100_000;
const READ_LINKS = 100;
/** The longest a `wait_for_text` waits. */
export const WAIT_MAX_MS = 30_000;

const TAB_PARAMETER = {
  type: "integer",
  description:
    "A tab this panel opened with open_tab. Leave it out to act on the panel's own tab, the one the person sees.",
} as const;

const objectOf = (properties: Record<string, unknown>, required: readonly string[] = []) => ({
  type: "object",
  properties: { ...properties, tab: TAB_PARAMETER },
  required,
  additionalProperties: false,
});

/** The tab a call acts on: the panel's own, or one it opened; any other is refused. */
export function tabOf(scope: TabScope, args: Record<string, unknown>): number {
  const asked = args.tab;
  if (asked === undefined || asked === null || asked === scope.bound) return scope.bound;
  if (typeof asked === "number" && scope.owned.has(asked)) return asked;
  throw new Error(
    "This panel acts only on its own tab and the tabs it opened with open_tab; that tab is neither.",
  );
}

function textArg(args: Record<string, unknown>, name: string): string | null {
  const value = args[name];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error(`"${name}" is text.`);
  return value;
}

function requiredText(args: Record<string, unknown>, name: string): string {
  const value = textArg(args, name);
  if (value === null || value.trim() === "") throw new Error(`Say "${name}".`);
  return value;
}

function numberArg(args: Record<string, unknown>, name: string): number | null {
  const value = args[name];
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`"${name}" is a number.`);
  return value;
}

/** A web address the tools may go to: http or https only, never the browser's own pages or a script. */
export function webAddress(text: string): string {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    throw new Error(`"${text}" is not an address.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new Error("Only http and https addresses can be opened.");
  return url.href;
}

/** The origin of an address; null for one that has none. */
function originOf(address: string | undefined): string | null {
  try {
    return address === undefined ? null : new URL(address).origin;
  } catch {
    return null;
  }
}

/** A web address that is not omp app's own: the panel's chat never goes to the app's pages. */
export function awayFromApp(address: string, app: string): string {
  if (originOf(address) === app) throw new Error(OFF_LIMITS);
  return address;
}

function outcome(result: PageOutcome): string {
  if ("error" in result) throw new Error(result.error);
  return result.done;
}

function readingText(reading: PageReading): string {
  const parts = [`Title: ${reading.title || "(none)"}`, `Address: ${reading.url}`];
  if (reading.selection !== "") parts.push(`Selected: ${reading.selection}`);
  parts.push("", reading.text === "" ? "(The page has no text.)" : reading.text);
  if (reading.truncated) parts.push("", "(The page has more text; ask for more with max_chars.)");
  if (reading.links.length > 0) {
    parts.push("", "Links:");
    for (const link of reading.links) parts.push(`- ${link.text || "(no words)"}: ${link.href}`);
  }
  return parts.join("\n");
}

/** Waits until the tab has loaded, or for 30 seconds, whichever comes first. */
async function loaded(api: TabsApi, tabId: number): Promise<browser.tabs.Tab> {
  for (let waited = 0; waited < 30_000; waited += 250) {
    const tab = await api.get(tabId);
    if (tab.status === "complete") return tab;
    await api.sleep(250);
  }
  return api.get(tabId);
}

/**
 * The panel's tools: each acts on the panel's own tab, or on a tab it opened, and never on a page of omp app itself
 * (`app`, its origin): a chat there could answer its own approvals, a pairing request or the settings.
 */
export function pageTools(scope: TabScope, api: TabsApi, app: string): HostTool[] {
  return [
    {
      name: "read_page",
      description:
        "Reads the page in the person's tab: its title, address, what is selected, its text and its links.",
      parameters: objectOf({
        max_chars: {
          type: "integer",
          minimum: 1_000,
          maximum: READ_MAX_CHARS,
          description: `How much of the page's text to read; ${READ_DEFAULT_CHARS} if left out.`,
        },
      }),
      run: async (args) => {
        const asked = numberArg(args, "max_chars") ?? READ_DEFAULT_CHARS;
        const chars = Math.min(READ_MAX_CHARS, Math.max(1_000, Math.round(asked)));
        return readingText(await api.run(tabOf(scope, args), readPage, [app, chars, READ_LINKS]));
      },
    },
    {
      name: "screenshot",
      description: "A picture of what the person's tab shows now (its visible part).",
      parameters: objectOf({}),
      run: async (args): Promise<EmbedToolResult> => {
        const tab = await api.get(tabOf(scope, args));
        if (!tab.active) throw new Error("That tab is not in front, so it cannot be photographed.");
        if (originOf(tab.url) === app) throw new Error(OFF_LIMITS);
        const data = await api.capture(tab.windowId);
        return {
          content: [
            {
              type: "image",
              data: data.replace(/^data:image\/png;base64,/, ""),
              mimeType: "image/png",
            },
          ],
        };
      },
    },
    {
      name: "click",
      description:
        "Clicks an element of the page: the one a CSS selector matches, or the first visible link or button whose words are the given text.",
      parameters: objectOf({
        selector: { type: "string", description: "A CSS selector." },
        text: { type: "string", description: "The words on the link or button." },
      }),
      run: async (args) =>
        outcome(
          await api.run(tabOf(scope, args), clickTarget, [
            app,
            textArg(args, "selector"),
            textArg(args, "text"),
          ]),
        ),
    },
    {
      name: "type",
      description:
        "Types text into a field of the page (the one a CSS selector matches, or the one with the focus), in place of what it held; submit sends its form.",
      parameters: objectOf(
        {
          text: { type: "string" },
          selector: { type: "string", description: "A CSS selector for the field." },
          submit: { type: "boolean", description: "Send the field's form after typing." },
        },
        ["text"],
      ),
      run: async (args) => {
        const text = textArg(args, "text");
        if (text === null) throw new Error('Say "text".');
        return outcome(
          await api.run(tabOf(scope, args), typeInto, [
            app,
            textArg(args, "selector"),
            text,
            args.submit === true,
          ]),
        );
      },
    },
    {
      name: "scroll",
      description: "Scrolls the page: to the top or the bottom, by some pixels, or to an element.",
      parameters: objectOf({
        to: { type: "string", enum: ["top", "bottom"] },
        by: { type: "integer", description: "Pixels down; negative goes up." },
        selector: { type: "string", description: "A CSS selector to bring into view." },
      }),
      run: async (args) => {
        const to = textArg(args, "to");
        if (to !== null && to !== "top" && to !== "bottom")
          throw new Error('"to" is top or bottom.');
        return outcome(
          await api.run(tabOf(scope, args), scrollPage, [
            app,
            to as "top" | "bottom" | null,
            numberArg(args, "by"),
            textArg(args, "selector"),
          ]),
        );
      },
    },
    {
      name: "navigate",
      description:
        "Opens a web address in the tab, in place of the page it shows, and waits for it to load.",
      parameters: objectOf({ url: { type: "string" } }, ["url"]),
      run: async (args) => {
        const tabId = tabOf(scope, args);
        await api.navigate(tabId, awayFromApp(webAddress(requiredText(args, "url")), app));
        const tab = await loaded(api, tabId);
        return `Loaded “${tab.title ?? ""}” at ${tab.url ?? ""}.`;
      },
    },
    {
      name: "open_tab",
      description:
        'Opens a web address in a new tab in the background. The new tab is this panel\'s: pass its number as "tab" to the other tools.',
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
        additionalProperties: false,
      },
      run: async (args) => {
        const tab = await api.open(
          awayFromApp(webAddress(requiredText(args, "url")), app),
          scope.bound,
        );
        if (tab.id === undefined) throw new Error("The tab could not be opened.");
        scope.own(tab.id);
        return `Opened tab ${tab.id} in the background at ${tab.url ?? ""}. Pass "tab": ${tab.id} to act on it.`;
      },
    },
    {
      name: "wait_for_text",
      description: "Waits until the page shows some text, for up to 30 seconds.",
      parameters: objectOf(
        {
          text: { type: "string" },
          timeout_ms: { type: "integer", minimum: 100, maximum: WAIT_MAX_MS },
        },
        ["text"],
      ),
      run: async (args, signal) => {
        const tabId = tabOf(scope, args);
        const text = requiredText(args, "text");
        const limit = Math.min(WAIT_MAX_MS, Math.max(100, numberArg(args, "timeout_ms") ?? 10_000));
        for (let waited = 0; ; waited += 500) {
          if (await api.run(tabId, hasText, [app, text])) return `The page shows “${text}”.`;
          if (waited >= limit || signal.aborted) break;
          await api.sleep(500);
        }
        const seconds = Math.max(1, Math.round(limit / 1000));
        throw new Error(
          `The page did not show “${text}” within ${seconds} ${seconds === 1 ? "second" : "seconds"}.`,
        );
      },
    },
  ];
}

/**
 * Firefox's own pages and the add-ons site keep extensions out, and the page functions refuse omp app's own pages; other
 * failures say what failed. What a page script threw comes back as Firefox cloned it: an error, or an object with a message.
 */
export function scriptFailureText(error: unknown): string {
  const said = (error as { message?: unknown } | null)?.message;
  const message = typeof said === "string" ? said : String(error);
  if (message.includes(OFF_LIMITS)) return OFF_LIMITS;
  if (/missing host permission|cannot access|not allowed|restricted/i.test(message))
    return "Firefox does not let extensions into this page (its own pages and the add-ons site).";
  return `The page could not be reached: ${message}`;
}

/** The tools' browser: Firefox's own APIs. */
export const firefoxTabs: TabsApi = {
  async run(tabId, func, args) {
    let results: browser.scripting.InjectionResult<unknown>[];
    try {
      results = await browser.scripting.executeScript({ target: { tabId }, func, args });
    } catch (error) {
      throw new Error(scriptFailureText(error));
    }
    const first = results[0];
    if (first === undefined) throw new Error("The page gave no answer.");
    if (first.error !== undefined) throw new Error(scriptFailureText(first.error));
    return first.result as never;
  },
  get: (tabId) => browser.tabs.get(tabId),
  capture: (windowId) => browser.tabs.captureVisibleTab(windowId, { format: "png" }),
  navigate: (tabId, url) => browser.tabs.update(tabId, { url }),
  open: (url, opener) => browser.tabs.create({ url, active: false, openerTabId: opener }),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
