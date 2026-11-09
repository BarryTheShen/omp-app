import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";

/**
 * A real Firefox for the checks of the app's Firefox and Zen extension (`apps/zen`): Playwright's own Firefox build
 * cannot load extensions, so these drive Mozilla's Firefox through geckodriver over WebDriver. The build server's test
 * image has both (`OMP_APP_FIREFOX` names Firefox; geckodriver is on the path); elsewhere `FIREFOX` is null and the
 * checks skip.
 */
export const FIREFOX = process.env.OMP_APP_FIREFOX || null;

/** The key WebDriver names an element by in its answers. */
const ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";

export interface WebElement {
  readonly [ELEMENT_KEY]: string;
}

/** The keys WebDriver types for Enter. */
export const ENTER = "\uE007";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

export class FirefoxDriver {
  readonly #base: string;
  readonly #driver: ChildProcess;

  private constructor(base: string, driver: ChildProcess) {
    this.#base = base;
    this.#driver = driver;
  }

  /** geckodriver on a free port, and a headless Firefox session with these preferences. */
  static async start(
    prefs: Readonly<Record<string, string | number | boolean>> = {},
  ): Promise<FirefoxDriver> {
    if (FIREFOX === null) throw new Error("No Firefox here: OMP_APP_FIREFOX is not set.");
    const port = await freePort();
    // System access (chrome context) lets a test open the extension's own pages (`openExtensionPage`): WebDriver may
    // not navigate a tab to them. geckodriver passes it to Firefox itself; capabilities may not.
    const driver = spawn(
      "geckodriver",
      ["--host", "127.0.0.1", "--port", String(port), "--log", "error", "--allow-system-access"],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    const root = `http://127.0.0.1:${port}`;
    for (let waited = 0; ; waited += 100) {
      try {
        const status = await fetch(`${root}/status`);
        if (status.ok) break;
      } catch {
        // Not listening yet.
      }
      if (waited > 15_000) {
        driver.kill();
        throw new Error("geckodriver did not start within 15 s.");
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const created = await fetch(`${root}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        capabilities: {
          alwaysMatch: {
            browserName: "firefox",
            "moz:firefoxOptions": { binary: FIREFOX, args: ["-headless"], prefs },
          },
        },
      }),
    });
    const answer = (await created.json()) as { value: { sessionId?: string; message?: string } };
    if (!created.ok || answer.value.sessionId === undefined) {
      driver.kill();
      throw new Error(`Firefox did not start: ${answer.value.message ?? created.status}`);
    }
    return new FirefoxDriver(`${root}/session/${answer.value.sessionId}`, driver);
  }

  /** One WebDriver command; its answer's value, or an error with WebDriver's message. */
  async command<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.#base}${path}`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    });
    const answer = (await response.json()) as { value: T & { error?: string; message?: string } };
    if (!response.ok) {
      const value = answer.value as { error?: string; message?: string };
      throw new Error(
        `WebDriver ${method} ${path}: ${value.error ?? response.status}: ${value.message ?? ""}`,
      );
    }
    return answer.value;
  }

  /** Installs an extension for this session only (unsigned, as about:debugging does); returns its id. */
  installTemporaryAddon(path: string): Promise<string> {
    return this.command("POST", "/moz/addon/install", { path, temporary: true });
  }

  goto(url: string): Promise<void> {
    return this.command("POST", "/url", { url });
  }

  /**
   * Opens one of an extension's own pages (`moz-extension://…`) in the current tab. WebDriver refuses to navigate there,
   * so the browser's window does it, as a link the person opened; then the page is the current one again.
   */
  async openExtensionPage(url: string): Promise<void> {
    await this.command("POST", "/moz/context", { context: "chrome" });
    try {
      await this.run(
        'Services.wm.getMostRecentWindow("navigator:browser").openTrustedLinkIn(arguments[0], "current");',
        [url],
      );
    } finally {
      await this.command("POST", "/moz/context", { context: "content" });
    }
    await this.waitFor(`the page ${url}`, async () => (await this.url()) === url, 15_000);
  }

  url(): Promise<string> {
    return this.command("GET", "/url");
  }

  /** A new tab, in front; its handle. */
  async newTab(): Promise<string> {
    const made = await this.command<{ handle: string }>("POST", "/window/new", { type: "tab" });
    await this.switchToWindow(made.handle);
    return made.handle;
  }

  windowHandle(): Promise<string> {
    return this.command("GET", "/window");
  }

  switchToWindow(handle: string): Promise<void> {
    return this.command("POST", "/window", { handle });
  }

  /** Runs a script in the current page; its return value. */
  run<T>(script: string, args: readonly unknown[] = []): Promise<T> {
    return this.command("POST", "/execute/sync", { script, args });
  }

  /** Runs a script that calls its last argument with the answer. */
  runAsync<T>(script: string, args: readonly unknown[] = []): Promise<T> {
    return this.command("POST", "/execute/async", { script, args });
  }

  async find(css: string): Promise<WebElement | null> {
    const found = await this.command<WebElement[]>("POST", "/elements", {
      using: "css selector",
      value: css,
    });
    return found[0] ?? null;
  }

  /** The first button whose words are exactly `words`. */
  async button(words: string): Promise<WebElement | null> {
    const found = await this.command<WebElement[]>("POST", "/elements", {
      using: "xpath",
      value: `//button[normalize-space()=${JSON.stringify(words)}]`,
    });
    return found[0] ?? null;
  }

  click(element: WebElement): Promise<void> {
    return this.command("POST", `/element/${element[ELEMENT_KEY]}/click`, {});
  }

  type(element: WebElement, text: string): Promise<void> {
    return this.command("POST", `/element/${element[ELEMENT_KEY]}/value`, { text });
  }

  /** Into a frame of the current page; `null` back to the top of the page. */
  frame(element: WebElement | null): Promise<void> {
    return this.command("POST", "/frame", { id: element });
  }

  /** The current frame's visible text. */
  async bodyText(): Promise<string> {
    return this.run<string>("return document.body ? document.body.innerText : '';");
  }

  /** Waits until `check` gives something, for up to `timeoutMs`; its value, or an error naming `what`. */
  async waitFor<T>(
    what: string,
    check: () => Promise<T | null | undefined | false>,
    timeoutMs = 30_000,
  ): Promise<T> {
    const until = Date.now() + timeoutMs;
    let last: unknown = null;
    for (;;) {
      try {
        const value = await check();
        if (value !== null && value !== undefined && value !== false) return value;
      } catch (error) {
        last = error;
      }
      if (Date.now() > until)
        throw new Error(
          `Waited ${timeoutMs} ms for ${what}${last === null ? "" : `: ${String(last)}`}`,
        );
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  /** Waits until the current frame's text holds `text`. */
  waitForText(text: string, timeoutMs = 60_000): Promise<string> {
    return this.waitFor(
      `the text "${text}"`,
      async () => {
        const shown = await this.bodyText();
        return shown.includes(text) ? shown : null;
      },
      timeoutMs,
    );
  }

  async close(): Promise<void> {
    try {
      await this.command("DELETE", "");
    } catch {
      // Firefox may have gone already.
    }
    this.#driver.kill();
  }
}
