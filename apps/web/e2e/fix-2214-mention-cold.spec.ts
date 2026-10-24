import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { type HeldFileSearch, holdFileSearch, newHeldFileSearch } from "./hold-file-search";
import { expect, realTest, screenshots, startChat, waitForFiniteAnimations } from "./real-omp";

/*
 * Issue 2214: the first `@` in a page said "No matches" for about 0.2 s before its files. The list now says
 * "Searching files…" until the file search has answered, and the composer asks for the folder's files a second after the
 * chat's first paint (issue 2537), so an `@` typed after that opens with its files. The held specs keep the file search's
 * answer back to show the line; the cold spec types `@` right after the first focus and checks that "No matches" never
 * comes before a file.
 */

const SEARCHING = "Searching files…";
const NO_MATCH = "No matches";
const WAIT_MS = 15_000;

/** What the page keeps from before the first `@`: when the searching line and the first file showed, and how often "No matches" showed before a file. */
interface ListWatch {
  searchingAt: number | null;
  optionAt: number | null;
  noMatchBeforeOptions: number;
}

/** The `@` list above the composer (`trigger-slot.tsx`). */
function fileList(page: Page): Locator {
  return page.getByRole("listbox", { name: "File suggestions" });
}

async function seedFiles(folder: string): Promise<void> {
  await writeFile(join(folder, "notes.txt"), "first line\n");
  await mkdir(join(folder, "src"), { recursive: true });
  await writeFile(join(folder, "src", "app.ts"), "export const app = 1;\n");
}

/** Keeps a record in the page, from before the first `@`, of the list's lines and files. */
async function watchFileList(page: Page): Promise<void> {
  await page.evaluate(
    ({ searching, noMatch }) => {
      const watch: ListWatch = { searchingAt: null, optionAt: null, noMatchBeforeOptions: 0 };
      Object.assign(window, { __fileListWatch: watch });
      const check = () => {
        const list = document.querySelector('[aria-label="File suggestions"]');
        if (list === null) return;
        if (watch.optionAt === null && list.querySelector('[role="option"]') !== null) {
          watch.optionAt = Date.now();
        }
        if (
          watch.searchingAt === null &&
          list.querySelector('[role="status"]')?.textContent === searching
        ) {
          watch.searchingAt = Date.now();
        }
        if (watch.optionAt === null && (list.textContent ?? "").includes(noMatch)) {
          watch.noMatchBeforeOptions += 1;
        }
      };
      new MutationObserver(check).observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    },
    { searching: SEARCHING, noMatch: NO_MATCH },
  );
}

/** Copies the record out of the page. */
async function readWatch(page: Page): Promise<ListWatch> {
  return page.evaluate(() =>
    Object.assign({}, (window as Window & { __fileListWatch?: ListWatch }).__fileListWatch),
  );
}

/** Forgets whether the searching line showed, so a later `@` can be judged on its own. */
async function forgetSearchingLine(page: Page): Promise<void> {
  await page.evaluate(() => {
    const watch = (window as Window & { __fileListWatch?: ListWatch }).__fileListWatch;
    if (watch) watch.searchingAt = null;
  });
}

/**
 * The box and its line take their colours from the design tokens, so a capture cannot show browser defaults: the box's
 * background is the popover token and the line's text is the muted token.
 */
async function expectStyledFileList(page: Page): Promise<void> {
  const tokens = await page.evaluate(() => {
    const token = (className: string, property: "color" | "backgroundColor") => {
      const probe = document.createElement("div");
      probe.className = className;
      document.body.append(probe);
      const value = getComputedStyle(probe)[property];
      probe.remove();
      return value;
    };
    const list = document.querySelector('[aria-label="File suggestions"]');
    const line = list?.querySelector('[role="status"]');
    const box = list?.querySelector("div.bg-popover");
    return {
      boxBackground: box ? getComputedStyle(box).backgroundColor : "",
      boxToken: token("bg-popover", "backgroundColor"),
      lineColor: line ? getComputedStyle(line).color : "",
      lineToken: token("text-muted-foreground", "color"),
    };
  });
  expect(tokens.boxToken).not.toBe("rgba(0, 0, 0, 0)");
  expect(tokens.boxBackground).toBe(tokens.boxToken);
  expect(tokens.lineToken).not.toBe("rgba(0, 0, 0, 0)");
  expect(tokens.lineColor).toBe(tokens.lineToken);
}

/**
 * Clicks into the composer, its first focus in the page, and types `@` while the file search is held: the line shows,
 * with no file and no "No matches". It is captured, then the answer is released and the files replace the line.
 */
async function firstAtWhileHeld(
  page: Page,
  composer: Locator,
  hold: HeldFileSearch,
  variant: "light" | "dark" | "narrow",
): Promise<void> {
  await watchFileList(page);
  await composer.click();
  await composer.pressSequentially("@");
  await expect(fileList(page).getByRole("status")).toHaveText(SEARCHING, { timeout: WAIT_MS });
  await expect(fileList(page).getByRole("option")).toHaveCount(0);
  await expectStyledFileList(page);
  if (variant === "narrow") {
    const box = await fileList(page).locator("div.bg-popover").first().boundingBox();
    expect(box?.x ?? Number.NaN).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? Number.NaN) + (box?.width ?? Number.NaN)).toBeLessThanOrEqual(390);
  }
  await waitForFiniteAnimations(page);
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({
    path: join(screenshots, `fix-2214-searching-${variant}.png`),
    fullPage: true,
  });

  // The answer is released only now, after the line has been seen and captured.
  hold.release();
  await expect(fileList(page).getByRole("option", { name: /notes\.txt/ })).toBeVisible({
    timeout: WAIT_MS,
  });
  await expect(fileList(page).getByRole("status")).toHaveCount(0);
  const watch = await readWatch(page);
  expect(watch.searchingAt).not.toBeNull();
  expect(watch.noMatchBeforeOptions).toBe(0);
}

realTest(
  "the first `@` shows 'Searching files…' while the file search has not answered, and the files replace it (light)",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    await seedFiles(realApp.folder);
    const hold = newHeldFileSearch();
    const page = await realApp.open({ beforeLoad: (target) => holdFileSearch(target, hold) });
    const composer = await startChat(page);
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    await firstAtWhileHeld(page, composer, hold, "light");
  },
);

realTest(
  "the searching line reads in dark mode, and the files replace it",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    await seedFiles(realApp.folder);
    const hold = newHeldFileSearch();
    const page = await realApp.open({
      beforeLoad: async (target) => {
        await holdFileSearch(target, hold);
        await target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark"));
      },
    });
    const composer = await startChat(page);
    await expect(page.locator("html")).toHaveClass(/dark/);
    await firstAtWhileHeld(page, composer, hold, "dark");
  },
);

realTest(
  "the searching line stays inside a 390 px screen, and the files replace it",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    await seedFiles(realApp.folder);
    const hold = newHeldFileSearch();
    const page = await realApp.open({ beforeLoad: (target) => holdFileSearch(target, hold) });
    const composer = await startChat(page);
    await page.setViewportSize({ width: 390, height: 844 });
    // Both sidebars close as drawers: wait until each reports closed, then for the fade to end.
    await expect(page.locator('[data-shell-sidebar="left"]')).toHaveAttribute("data-open", "false");
    await expect(page.locator('[data-shell-sidebar="right"]')).toHaveAttribute(
      "data-open",
      "false",
    );
    await waitForFiniteAnimations(page);
    await firstAtWhileHeld(page, composer, hold, "narrow");
  },
);

realTest(
  "a cold `@` on a fresh page never says 'No matches' before its first file; a later `@` opens with its files (issue 2214)",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    await seedFiles(realApp.folder);
    const page = await realApp.open();
    const composer = await startChat(page);
    await watchFileList(page);
    await composer.click();
    // Typed straight after the first focus: the cold case.
    await composer.pressSequentially("@");
    await expect(fileList(page).getByRole("option", { name: /notes\.txt/ })).toBeVisible({
      timeout: WAIT_MS,
    });
    const cold = await readWatch(page);
    expect(cold.optionAt).not.toBeNull();
    expect(cold.noMatchBeforeOptions).toBe(0);

    // The file list is already in the page, so a second `@` opens with its files and no searching line.
    await composer.fill("");
    await expect(fileList(page)).toHaveCount(0);
    await forgetSearchingLine(page);
    await composer.pressSequentially("@");
    await expect(fileList(page).getByRole("option", { name: /notes\.txt/ })).toBeVisible({
      timeout: WAIT_MS,
    });
    const later = await readWatch(page);
    expect(later.searchingAt).toBeNull();
  },
);

/** The frames of a message that is a JSON object; a message that is not one has no fields. */
function frameOf(message: string | Buffer): Record<string, unknown> {
  const value: unknown = JSON.parse(String(message));
  return typeof value === "object" && value !== null
    ? Object.fromEntries(Object.entries(value))
    : {};
}

/** The query in a file search call's arguments. */
function queryOf(args: unknown): string {
  return typeof args === "object" &&
    args !== null &&
    "query" in args &&
    typeof args.query === "string"
    ? args.query
    : "";
}

/** The file search answers the page has had, and the answer for `holdQuery` held until `release()`. */
interface FileSearchGate {
  /** The queries whose answers have reached the page, in order. */
  readonly answered: string[];
  readonly holdQuery: string | undefined;
  readonly held: Promise<void>;
  readonly release: () => void;
}

function newFileSearchGate(holdQuery: string | undefined): FileSearchGate {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { answered: [], holdQuery, held: promise, release: resolve };
}

/** Routes the page's socket so the file search answers pass through `gate`; every other frame passes unchanged. */
async function routeFileSearch(page: Page, gate: FileSearchGate): Promise<void> {
  await page.routeWebSocket(/\/ws/, (socket) => {
    const server = socket.connectToServer();
    const queries = new Map<unknown, string>();
    socket.onMessage((message) => {
      const frame = frameOf(message);
      if (frame.type === "call" && frame.port === "A1.fileSearch")
        queries.set(frame.id, queryOf(frame.args));
      server.send(message);
    });
    server.onMessage((message) => {
      const frame = frameOf(message);
      const query = queries.get(frame.id);
      if (frame.type !== "result" || query === undefined) {
        socket.send(message);
        return;
      }
      queries.delete(frame.id);
      const send = () => {
        socket.send(message);
        gate.answered.push(query);
      };
      if (query === gate.holdQuery) void gate.held.then(send);
      else send();
    });
  });
}

/** Records the text of the `@` list at each change of the page, from now on (the tour's recorder works the same way). */
async function startStatusLog(page: Page): Promise<void> {
  await page.evaluate(() => {
    const log: string[] = [];
    Object.assign(window, { __statusLog: log });
    new MutationObserver(() => {
      const text = (
        document.querySelector('[aria-label="File suggestions"]')?.textContent ?? ""
      ).trim();
      if (text !== "" && log.at(-1) !== text) log.push(text);
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  });
}

async function statusLog(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as Window & { __statusLog?: string[] }).__statusLog ?? []);
}

realTest(
  "a cold `@` typed after the warm-up's answer has come shows its files, never 'No matches' (issue 2214)",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    await seedFiles(realApp.folder);
    const gate = newFileSearchGate(undefined);
    const page = await realApp.open({ beforeLoad: (target) => routeFileSearch(target, gate) });
    const composer = await startChat(page);
    await watchFileList(page);
    await composer.click();
    // The file list's first answer is asked for a second after the first paint. The `@` is typed once that answer has
    // reached the page; if it has not come within 1.5 s, the `@` is typed then.
    const focusedAt = Date.now();
    while (!gate.answered.includes("") && Date.now() - focusedAt < 1_500) {
      await page.waitForTimeout(50);
    }
    await composer.pressSequentially("@");
    await expect(fileList(page).getByRole("option", { name: /notes\.txt/ })).toBeVisible({
      timeout: WAIT_MS,
    });
    const watch = await readWatch(page);
    expect(watch.optionAt).not.toBeNull();
    expect(watch.noMatchBeforeOptions).toBe(0);
  },
);

realTest(
  "a second `@` whose answer is still on its way does not say 'No matches' for the answer on screen (issue 2214)",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    await seedFiles(realApp.folder);
    const gate = newFileSearchGate("@@");
    const page = await realApp.open({ beforeLoad: (target) => routeFileSearch(target, gate) });
    const composer = await startChat(page);
    await composer.click();
    const focusedAt = Date.now();
    while (!gate.answered.includes("") && Date.now() - focusedAt < 1_500) {
      await page.waitForTimeout(50);
    }
    await composer.pressSequentially("@");
    await expect(fileList(page).getByRole("option", { name: /notes\.txt/ })).toBeVisible({
      timeout: WAIT_MS,
    });
    // "@@" asks for "@": no file has one, so the list answers "No matches" (the answer on screen).
    await composer.pressSequentially("@");
    await expect(fileList(page).getByText("No matches", { exact: true })).toBeVisible({
      timeout: WAIT_MS,
    });
    // "@@@" asks for "@@", whose answer is held: the list must search, not say "No matches" for the answer on screen.
    await startStatusLog(page);
    await composer.pressSequentially("@");
    // The answer for "@@" is held: for 800 ms the list must not say "No matches" (the answer on screen is for "@"), and
    // the list searches until its own answer comes.
    await page.waitForTimeout(800);
    expect(await statusLog(page)).not.toContain("No matches");
    gate.release();
    await expect(fileList(page).getByText("No matches", { exact: true })).toBeVisible({
      timeout: WAIT_MS,
    });
  },
);
