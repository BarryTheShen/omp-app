import { appAddressOf, type EmbedToolResult, type HostTool } from "@omp-app/embed";
import { describe, expect, test } from "vitest";
import {
  appOrigins,
  OFF_LIMITS,
  pageTools,
  READ_MAX_CHARS,
  scriptFailureText,
  type TabScope,
  type TabsApi,
  tabOf,
  webAddress,
} from "./tools";

const BOUND = 7;
/** omp app's own origin, as the panel passes it. */
const APP = "https://omp.example.com";

function scopeOf(owned: number[] = []): TabScope {
  const set = new Set(owned);
  return { bound: BOUND, owned: set, own: (id) => set.add(id) };
}

interface Call {
  readonly tabId: number;
  readonly name: string;
  readonly args: unknown[];
}

/** A stand-in browser: it records what ran where, and answers as told. */
function standIn(answer: (call: Call) => unknown = () => ({ done: "ok" })) {
  const calls: Call[] = [];
  const opened: { url: string; opener: number }[] = [];
  const captured: number[] = [];
  const tabs = new Map<number, browser.tabs.Tab>([
    [
      BOUND,
      {
        id: BOUND,
        windowId: 1,
        active: true,
        status: "complete",
        title: "Docs",
        url: "https://example.com/docs",
      },
    ],
  ]);
  const api: TabsApi = {
    run: async (tabId, func, args) => {
      const call = { tabId, name: func.name, args };
      calls.push(call);
      return answer(call) as never;
    },
    get: async (tabId) => {
      const tab = tabs.get(tabId);
      if (tab === undefined) throw new Error("no such tab");
      return tab;
    },
    capture: async (tabId) => {
      captured.push(tabId);
      return "data:image/png;base64,AAAA";
    },
    navigate: async (tabId, url) => {
      const tab = {
        ...(tabs.get(tabId) as browser.tabs.Tab),
        url,
        title: "Next",
        status: "complete",
      };
      tabs.set(tabId, tab);
      return tab;
    },
    open: async (url, opener) => {
      opened.push({ url, opener });
      const tab = { id: 42, windowId: 1, active: false, url, status: "loading" };
      tabs.set(42, tab);
      return tab;
    },
    sleep: async () => undefined,
  };
  return { api, calls, opened, tabs, captured };
}

const toolOf = (tools: HostTool[], name: string): HostTool => {
  const tool = tools.find((each) => each.name === name);
  if (tool === undefined) throw new Error(`no tool ${name}`);
  return tool;
};
const never = new AbortController().signal;

describe("the tab a call acts on", () => {
  test("the panel's own tab, or one it opened; any other is refused", () => {
    const scope = scopeOf([42]);
    expect(tabOf(scope, {})).toBe(BOUND);
    expect(tabOf(scope, { tab: BOUND })).toBe(BOUND);
    expect(tabOf(scope, { tab: 42 })).toBe(42);
    expect(() => tabOf(scope, { tab: 8 })).toThrow("only on its own tab and the tabs it opened");
    expect(() => tabOf(scope, { tab: "42" })).toThrow("only on its own tab");
  });

  test("a tab opened with open_tab becomes the panel's; other tools then act on it", async () => {
    const scope = scopeOf();
    const { api, calls, opened } = standIn();
    const tools = pageTools(scope, api, APP);
    const said = await toolOf(tools, "open_tab").run({ url: "https://example.com/next" }, never);
    expect(opened).toEqual([{ url: "https://example.com/next", opener: BOUND }]);
    expect(said).toContain('Pass "tab": 42');
    await toolOf(tools, "click").run({ tab: 42, text: "Next" }, never);
    expect(calls.at(-1)).toMatchObject({
      tabId: 42,
      name: "clickTarget",
      args: [[APP], null, "Next"],
    });
    await expect(toolOf(tools, "click").run({ tab: 43, text: "Next" }, never)).rejects.toThrow(
      "only on its own tab",
    );
  });
});

describe("addresses", () => {
  test("the tools go to web addresses only", () => {
    expect(webAddress(" https://example.com/a b ")).toBe("https://example.com/a%20b");
    expect(webAddress("http://127.0.0.1:8080/")).toBe("http://127.0.0.1:8080/");
    for (const refused of [
      "javascript:alert(1)",
      "about:config",
      "file:///etc/passwd",
      "moz-extension://x/panel.html",
    ])
      expect(() => webAddress(refused)).toThrow("Only http and https");
    expect(() => webAddress("not an address")).toThrow("is not an address");
  });

  test("omp app's address: https, or a loopback address with its port; only its origin is kept", () => {
    expect(appAddressOf("https://computer.tailnet.ts.net/lite?x=1")).toEqual({
      address: "https://computer.tailnet.ts.net",
    });
    expect(appAddressOf("http://127.0.0.1:4317")).toEqual({ address: "http://127.0.0.1:4317" });
    expect(appAddressOf("http://computer.lan:4317")).toHaveProperty("problem");
    expect(appAddressOf("http://127.0.0.1")).toHaveProperty("problem");
    expect(appAddressOf("tailnet")).toHaveProperty("problem");
    expect(appAddressOf("  ")).toEqual({ problem: "Type omp app's address." });
  });
});

describe("the tools", () => {
  test("read_page reads the panel's tab within the limits, and says what it read", async () => {
    const reading = {
      title: "Docs",
      url: "https://example.com/docs",
      selection: "the words",
      text: "Hello",
      truncated: true,
      links: [{ text: "Next", href: "https://example.com/next" }],
    };
    const { api, calls } = standIn(() => reading);
    const read = toolOf(pageTools(scopeOf(), api, APP), "read_page");
    const said = await read.run({ max_chars: 5 }, never);
    expect(calls[0]).toMatchObject({
      tabId: BOUND,
      name: "readPage",
      args: [[APP], 1_000, 100],
    });
    expect(said).toContain("Title: Docs");
    expect(said).toContain("Selected: the words");
    expect(said).toContain("- Next: https://example.com/next");
    expect(said).toContain("The page has more text");
    await read.run({ max_chars: 10_000_000 }, never);
    expect(calls[1]?.args[1]).toBe(READ_MAX_CHARS);
  });

  test("what the page refuses comes back as the call's error", async () => {
    const { api } = standIn(() => ({ error: 'Nothing on the page matches "#go".' }));
    await expect(
      toolOf(pageTools(scopeOf(), api, APP), "click").run({ selector: "#go" }, never),
    ).rejects.toThrow('Nothing on the page matches "#go".');
  });

  test("screenshot photographs the tab itself, by its id, when it is in front, and refuses one that is not", async () => {
    const { api, tabs, captured } = standIn();
    const shot = (await toolOf(pageTools(scopeOf([42]), api, APP), "screenshot").run(
      {},
      never,
    )) as EmbedToolResult;
    expect(shot.content).toEqual([{ type: "image", data: "AAAA", mimeType: "image/png" }]);
    expect(captured).toEqual([BOUND]);
    tabs.set(42, { id: 42, windowId: 1, active: false });
    await expect(
      toolOf(pageTools(scopeOf([42]), api, APP), "screenshot").run({ tab: 42 }, never),
    ).rejects.toThrow("not in front");
    expect(captured).toEqual([BOUND]);
  });

  test("navigate goes to web addresses only, and says what loaded", async () => {
    const { api } = standIn();
    const navigate = toolOf(pageTools(scopeOf(), api, APP), "navigate");
    await expect(navigate.run({ url: "javascript:alert(1)" }, never)).rejects.toThrow(
      "Only http and https",
    );
    expect(await navigate.run({ url: "https://example.com/next" }, never)).toBe(
      "Loaded “Next” at https://example.com/next.",
    );
  });

  test("wait_for_text waits until the page shows the text, and gives up at its limit", async () => {
    let checks = 0;
    const shows = standIn(() => ++checks >= 3);
    expect(
      await toolOf(pageTools(scopeOf(), shows.api, APP), "wait_for_text").run(
        { text: "Done" },
        never,
      ),
    ).toBe("The page shows “Done”.");
    expect(checks).toBe(3);
    const never_shows = standIn(() => false);
    await expect(
      toolOf(pageTools(scopeOf(), never_shows.api, APP), "wait_for_text").run(
        { text: "Done", timeout_ms: 1_000 },
        never,
      ),
    ).rejects.toThrow("did not show “Done” within 1 second.");
  });

  test("omp app's own pages: the tools neither go there nor photograph a tab showing one", async () => {
    const { api, opened, tabs } = standIn();
    const tools = pageTools(scopeOf(), api, APP);
    await expect(
      toolOf(tools, "navigate").run({ url: `${APP}/chat/1?approve=1` }, never),
    ).rejects.toThrow(OFF_LIMITS);
    await expect(toolOf(tools, "open_tab").run({ url: `${APP}/` }, never)).rejects.toThrow(
      OFF_LIMITS,
    );
    expect(opened).toEqual([]);
    // Another port is another site.
    expect(
      await toolOf(tools, "navigate").run({ url: "https://omp.example.com:8443/" }, never),
    ).toBe("Loaded “Next” at https://omp.example.com:8443/.");
    tabs.set(BOUND, {
      id: BOUND,
      windowId: 1,
      active: true,
      status: "complete",
      url: `${APP}/settings`,
    });
    await expect(toolOf(tools, "screenshot").run({}, never)).rejects.toThrow(OFF_LIMITS);
  });

  test("an app on this computer is off limits at each of its loopback names; another port is another site", async () => {
    const local = "http://127.0.0.1:4317";
    expect(appOrigins(local)).toEqual([
      "http://localhost:4317",
      "http://127.0.0.1:4317",
      "http://[::1]:4317",
    ]);
    expect(appOrigins(`${APP}/settings`)).toEqual([APP]);
    const { api, opened, calls, tabs } = standIn();
    const tools = pageTools(scopeOf(), api, local);
    for (const url of ["http://localhost:4317/", "http://[::1]:4317/chat/1"])
      await expect(toolOf(tools, "open_tab").run({ url }, never)).rejects.toThrow(OFF_LIMITS);
    expect(opened).toEqual([]);
    expect(await toolOf(tools, "navigate").run({ url: "http://localhost:5173/" }, never)).toBe(
      "Loaded “Next” at http://localhost:5173/.",
    );
    // The page itself refuses at each name, a tab that went there a moment before too.
    await toolOf(tools, "scroll").run({ to: "top" }, never);
    expect(calls.at(-1)?.args[0]).toEqual(appOrigins(local));
    tabs.set(BOUND, {
      id: BOUND,
      windowId: 1,
      active: true,
      status: "complete",
      url: "http://localhost:4317/settings",
    });
    await expect(toolOf(tools, "screenshot").run({}, never)).rejects.toThrow(OFF_LIMITS);
  });

  test("a page's refusal comes back in its own words, as Firefox clones it", () => {
    expect(scriptFailureText(new Error(OFF_LIMITS))).toBe(OFF_LIMITS);
    expect(scriptFailureText({ message: `Error: ${OFF_LIMITS}` })).toBe(OFF_LIMITS);
    expect(scriptFailureText(new Error("Missing host permission for the tab"))).toContain(
      "Firefox does not let extensions into this page",
    );
    expect(scriptFailureText({ message: "the tab closed" })).toBe(
      "The page could not be reached: the tab closed",
    );
  });
});
