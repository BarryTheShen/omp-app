import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";
import {
  hostRequest,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

/**
 * Issue 2515 on the real app (real server, real omp, the fake model). A chat another omp holds, such as a terminal's, is
 * refused when its row is clicked: the refusal shows on that row at once, and no omp starts for the chat. A chat on
 * screen stays as it is. On a phone-width layout the sessions drawer closes on the click, so it opens again, with the
 * refused row focused. Once that omp has exited, the same click opens the chat.
 */
realTest.use({ seedSessions: 6 });

/** The seeded chat "Seeded chat 5" (its id is the seeded index, 4, padded). */
const HELD = "Seeded chat 5";
const SEEDED_FIVE = "01a00000-0000-7000-8000-000000000004";
const LINE =
  "This chat is open in another omp, for example in a terminal. Close it there, then open it here.";
const NARROW = { width: 390, height: 844 };

/** The sidebar row whose title starts with `title` (a title here never is a prefix of another). */
function rowFor(page: Page, title: string): Locator {
  return page
    .getByRole("listbox", { name: "Session list" })
    .getByRole("option", { name: new RegExp(title) });
}

/** The refusal under the session list, the line a refused delete shows too. */
function refusalOf(page: Page): Locator {
  return page.getByRole("alert").filter({ hasText: LINE });
}

/** The sidebar's styles are loaded (a token background, not the browser default) before a capture. */
async function expectStylesLoaded(page: Page): Promise<void> {
  await expect(page.locator('link[rel="stylesheet"]')).toHaveAttribute(
    "href",
    /\/assets\/.+\.css$/,
  );
  const background = await page
    .locator('aside[aria-label="Session list"]')
    .evaluate((element: HTMLElement) => getComputedStyle(element).backgroundColor);
  expect(background).not.toBe("rgba(0, 0, 0, 0)");
}

/** The narrow layout's drawer: open again after a refused pick, with the refused row focused and the line on it. */
async function expectDrawerReopenedWithRefusal(page: Page): Promise<void> {
  await expect(page.locator('[data-shell-sidebar="left"]')).toHaveAttribute("data-open", "true", {
    timeout: 5_000,
  });
  await expect(refusalOf(page)).toBeVisible({ timeout: 5_000 });
  await expect(rowFor(page, HELD)).toBeFocused({ timeout: 5_000 });
}

realTest(
  "a chat another omp holds is refused on its row at once when clicked, the chat on screen stays, the narrow drawer reopens with the row focused, and the same click opens it once that omp has exited",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(420_000);
    await mkdir(screenshots, { recursive: true });

    // Another omp, as a terminal runs one, takes the chat's lease by writing to it.
    const terminal = realApp.startOmp(["--resume", SEEDED_FIVE]);
    await hostRequest(terminal, "set_session_name", { name: HELD });

    // A chat on screen (desktop): the refusal shows on the row, and the chat on screen stays.
    const busy = await realApp.open();
    const busyComposer = await startChat(busy);
    await sendPrompt(busyComposer, "hello");
    await expect(busy.getByText("pong", { exact: true }).first()).toBeVisible({ timeout: 60_000 });
    const runningChat = realApp.ompProcesses();
    await rowFor(busy, HELD).click();
    await expect(refusalOf(busy)).toBeVisible({ timeout: 2_000 });
    await expect(
      busy
        .getByRole("region", { name: "Conversation transcript" })
        .getByText("hello", { exact: true }),
    ).toBeVisible();
    expect(realApp.ompProcesses()).toEqual(runningChat);

    // Empty screen, light: the refusal is on the row at once, and no omp starts for the held chat.
    const light = await realApp.open();
    await expect(rowFor(light, HELD)).toBeVisible({ timeout: 30_000 });
    const beforeClick = realApp.ompProcesses();
    await rowFor(light, HELD).click();
    await expect(refusalOf(light)).toBeVisible({ timeout: 2_000 });
    expect(realApp.ompProcesses()).toEqual(beforeClick);
    await expectStylesLoaded(light);
    await waitForFiniteAnimations(light);
    await light.screenshot({ path: join(screenshots, "fix-2515-held-light.png"), fullPage: true });

    // Empty screen, dark.
    const dark = await realApp.open({
      beforeLoad: (page) =>
        page.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
    });
    await expect(dark.locator("html")).toHaveClass(/dark/);
    await expect(rowFor(dark, HELD)).toBeVisible({ timeout: 30_000 });
    await rowFor(dark, HELD).click();
    await expect(refusalOf(dark)).toBeVisible({ timeout: 2_000 });
    await expectStylesLoaded(dark);
    await waitForFiniteAnimations(dark);
    await dark.screenshot({ path: join(screenshots, "fix-2515-held-dark.png"), fullPage: true });

    // 390 px, empty screen, light: the click closes the drawer, the refusal reopens it with the row focused.
    const narrow = await realApp.open();
    await narrow.setViewportSize(NARROW);
    await narrow.getByRole("button", { name: "Show sessions sidebar" }).click();
    await rowFor(narrow, HELD).click();
    await expectDrawerReopenedWithRefusal(narrow);
    await expectStylesLoaded(narrow);
    await waitForFiniteAnimations(narrow);
    await narrow.screenshot({
      path: join(screenshots, "fix-2515-held-390-light.png"),
      fullPage: true,
    });

    // 390 px, empty screen, dark.
    const narrowDark = await realApp.open({
      beforeLoad: (page) =>
        page.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
    });
    await narrowDark.setViewportSize(NARROW);
    await expect(narrowDark.locator("html")).toHaveClass(/dark/);
    await narrowDark.getByRole("button", { name: "Show sessions sidebar" }).click();
    await rowFor(narrowDark, HELD).click();
    await expectDrawerReopenedWithRefusal(narrowDark);
    await expectStylesLoaded(narrowDark);
    await waitForFiniteAnimations(narrowDark);
    await narrowDark.screenshot({
      path: join(screenshots, "fix-2515-held-390-dark.png"),
      fullPage: true,
    });

    // 390 px, a chat on screen behind the drawer: the transcript stays, and the refusal reopens the drawer.
    const narrowBusy = await realApp.open();
    await narrowBusy.setViewportSize(NARROW);
    await narrowBusy.getByRole("button", { name: "Show sessions sidebar" }).click();
    const narrowBusyComposer = await startChat(narrowBusy);
    await sendPrompt(narrowBusyComposer, "hello");
    await expect(narrowBusy.getByText("pong", { exact: true }).first()).toBeVisible({
      timeout: 60_000,
    });
    await narrowBusy.getByRole("button", { name: "Show sessions sidebar" }).click();
    await rowFor(narrowBusy, HELD).click();
    await expectDrawerReopenedWithRefusal(narrowBusy);
    await expect(
      narrowBusy
        .getByRole("region", { name: "Conversation transcript" })
        .getByText("hello", { exact: true }),
    ).toBeVisible();

    // The other omp exits. The same click on the same row now opens the chat, and the refusal is gone.
    const exited = Promise.withResolvers<void>();
    terminal.once("exit", () => exited.resolve());
    terminal.kill("SIGTERM");
    await exited.promise;
    await rowFor(light, HELD).click();
    await expect(light.getByRole("textbox", { name: "Message input" })).toBeVisible({
      timeout: 60_000,
    });
    await expect(refusalOf(light)).toHaveCount(0);
    expect(realApp.problems).toEqual([]);
  },
);
