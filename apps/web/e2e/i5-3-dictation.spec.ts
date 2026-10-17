/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import {
  expect,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

const WEB_ROOT = process.cwd();
const DIST_ROOT = join(WEB_ROOT, "dist");
const NARROW = { width: 390, height: 844 } as const;

function buildPlayground(): void {
  const css = readdirSync(join(DIST_ROOT, "assets")).find((file) => file.endsWith(".css"));
  if (!css) throw new Error("The production build did not emit a stylesheet for dictation.");
  execFileSync(
    "bun",
    [
      "build",
      "src/modules/I5/dictation/playground.tsx",
      "--outdir",
      "dist/i5-3-dictation",
      "--target=browser",
    ],
    { cwd: WEB_ROOT, stdio: "inherit" },
  );
  writeFileSync(
    join(DIST_ROOT, "i5-3-dictation.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="/assets/${css}" />
    <link rel="icon" href="data:," />
    <script type="module" src="/i5-3-dictation/playground.js"></script>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
`,
  );
}

async function expectTokenBackground(page: Page): Promise<void> {
  const colors = await page.locator("main").evaluate((main) => {
    const context = document.createElement("canvas").getContext("2d");
    if (context === null) throw new Error("Canvas is unavailable.");
    const normalize = (color: string): string => {
      context.fillStyle = "#000000";
      context.fillStyle = color;
      return context.fillStyle;
    };
    const background = getComputedStyle(main).backgroundColor;
    const token = getComputedStyle(document.documentElement)
      .getPropertyValue("--background")
      .trim();
    return { background: normalize(background), token: normalize(token), rawToken: token };
  });
  expect(colors.rawToken).not.toBe("");
  expect(colors.background).toBe(colors.token);
}

async function emitWords(page: Page, text: string): Promise<void> {
  await page.evaluate((words) => {
    const host = window as Window & {
      __i5Recognition?: { emitFinal: (value: string) => void };
    };
    host.__i5Recognition?.emitFinal(words);
  }, text);
}

realTest(
  "real omp opens a chat before the local dictation adapter showcase",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    buildPlayground();
    mkdirSync(screenshots, { recursive: true });

    const app = await realApp.open();
    const composer = await startChat(app);
    await sendPrompt(composer, "pong");
    await expect(app.getByText("pong", { exact: true })).toBeVisible({ timeout: 60_000 });

    const browser = app.context().browser();
    if (browser === null) throw new Error("The browser is unavailable for dictation.");
    const context = await browser.newContext();
    const page = await context.newPage();
    const problems: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") problems.push(message.text());
    });
    page.on("pageerror", (error) => problems.push(error.message));
    await page.addInitScript(() => {
      const host = window as unknown as {
        SpeechRecognition?: unknown;
        __i5Recognition?: {
          emitFinal: (text: string) => void;
          emitError: (error: string) => void;
        };
      };
      class FakeSpeechRecognition {
        onstart: ((event: Event) => void) | null = null;
        onresult:
          | ((event: {
              resultIndex: number;
              results: readonly (readonly [{ transcript: string }] & { isFinal: boolean })[];
            }) => void)
          | null = null;
        onerror: ((event: Event & { error: string }) => void) | null = null;
        onend: ((event: Event) => void) | null = null;
        lang = "";
        continuous = false;
        interimResults = false;

        start(): void {
          host.__i5Recognition = this;
          this.onstart?.(new Event("start"));
        }

        stop(): void {
          this.onend?.(new Event("end"));
        }

        abort(): void {
          this.onend?.(new Event("end"));
        }

        emitFinal(text: string): void {
          const result = Object.assign([{ transcript: text }], { isFinal: true });
          const event = Object.assign(new Event("result"), { resultIndex: 0, results: [result] });
          this.onresult?.(event as unknown as Parameters<NonNullable<typeof this.onresult>>[0]);
        }
        emitError(error: string): void {
          this.onerror?.(Object.assign(new Event("error"), { error }) as Event & { error: string });
        }
      }
      host.SpeechRecognition = FakeSpeechRecognition;
    });

    const origin = new URL(app.url()).origin;
    await page.goto(`${origin}/i5-3-dictation.html#token=${encodeURIComponent(realApp.token)}`);
    const input = page.getByRole("textbox", { name: "Message input" });
    const hold = page.getByRole("button", { name: "Hold to dictate" });
    await expect(page.getByTestId("i5-3-dictation-playground")).toBeVisible();
    await expect(hold).toBeVisible();
    await expectTokenBackground(page);

    await hold.dispatchEvent("pointerdown", { button: 0, isPrimary: true, pointerId: 1 });
    await expect
      .poll(() =>
        page.evaluate(() =>
          Boolean((window as Window & { __i5Recognition?: unknown }).__i5Recognition),
        ),
      )
      .toBe(true);
    await emitWords(page, "Captured words");
    await expect(input).toHaveValue("Captured words");
    await expect(page.getByTestId("i5-3-send-count")).toHaveText("Messages sent: 0");
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "i5.3-dictation-light-listening.png"),
      fullPage: true,
    });
    await page.evaluate(() => {
      const recognition = (
        window as Window & { __i5Recognition?: { emitError: (value: string) => void } }
      ).__i5Recognition;
      recognition?.emitError("not-allowed");
    });
    await expect(page.getByRole("alert").first()).toHaveText("Microphone access was denied.");
    await page.screenshot({
      path: join(screenshots, "i5.3-dictation-light-denied.png"),
      fullPage: true,
    });
    await expect(hold).toHaveAttribute("aria-pressed", "false");

    await page.addInitScript(() => {
      if (document.documentElement) document.documentElement.classList.add("dark");
      else
        document.addEventListener(
          "DOMContentLoaded",
          () => document.documentElement.classList.add("dark"),
          { once: true },
        );
    });
    await page.reload();
    const darkInput = page.getByRole("textbox", { name: "Message input" });
    const toggle = page.getByRole("button", { name: "Start dictation" });
    await expect(toggle).toBeVisible();
    await toggle.click();
    await expect
      .poll(() =>
        page.evaluate(() =>
          Boolean((window as Window & { __i5Recognition?: unknown }).__i5Recognition),
        ),
      )
      .toBe(true);
    await emitWords(page, "Toggle dictation words");
    await expect(darkInput).toHaveValue("Toggle dictation words");
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "i5.3-dictation-dark-listening.png"),
      fullPage: true,
    });
    await page.evaluate(() => {
      const recognition = (
        window as Window & { __i5Recognition?: { emitError: (value: string) => void } }
      ).__i5Recognition;
      recognition?.emitError("not-allowed");
    });
    await expect(page.getByRole("alert").first()).toHaveText("Microphone access was denied.");
    await page.screenshot({
      path: join(screenshots, "i5.3-dictation-dark-denied.png"),
      fullPage: true,
    });

    await page.setViewportSize(NARROW);
    await expect(page.getByRole("button", { name: "Hold to dictate" })).toBeVisible();
    await expectTokenBackground(page);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "i5.3-dictation-narrow.png"), fullPage: true });
    const widths = await page.evaluate(() => ({
      client: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    expect(widths.scroll).toBeLessThanOrEqual(widths.client);

    await context.close();
    expect(problems).toEqual([]);
    expect(realApp.problems).toEqual([]);
  },
);
