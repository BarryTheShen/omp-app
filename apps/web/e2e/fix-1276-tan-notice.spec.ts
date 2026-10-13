import { join } from "node:path";
import type { Page } from "@playwright/test";
import { U1_REAL_ENTRIES } from "../src/modules/U1/fixtures/real-entries";
import { expect, realTest, screenshots, waitForFiniteAnimations } from "./real-omp";

/**
 * A /tan dispatch in a chat. omp writes a notice for the model; the chat shows one line that names the
 * job and the work, and omp's full text stays behind a "Full message" control. Opened in the real app on
 * real omp from a real entry (`modules/U1/fixtures/real-entries.ts`): the line is on the page once, the
 * full text is not visible until the control opens, and the same holds after a reload. Light, a 390 px
 * phone, and dark.
 */

const LINE = "Tangent sent to background job bg_1: Check the login flow";
const FULL_TEXT = "Tangential user task: running in a separate background agent";
const LAST_REPLY = "The tangent is running; I will carry on here.";
const DESKTOP = { width: 1280, height: 900 } as const;
const PHONE = { width: 390, height: 844 } as const;

const tangent = U1_REAL_ENTRIES.find((sample) =>
  sample.name.startsWith("custom_message background-tan-dispatch"),
);
if (tangent === undefined) throw new Error("no tangent fixture");

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const assistant = (text: string, timestamp: number) => ({
  type: "message",
  message: {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "fake",
    model: "fake-model",
    usage,
    stopReason: "stop",
    timestamp,
  },
});

const at = Date.UTC(2026, 9, 12, 22, 48, 0);
realTest.use({
  seedEntries: {
    entries: [
      {
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: "Check the login flow in a tangent." }],
          timestamp: at,
        },
      },
      assistant("I dispatched a tangent for that.", at + 1_000),
      tangent.entry,
      assistant(LAST_REPLY, at + 2_000),
    ],
  },
});

/** Opens the app in one theme, applied before the first paint. */
function themed(name: "light" | "dark") {
  return {
    beforeLoad: (target: Page) =>
      target.addInitScript(
        (value: string) => window.localStorage.setItem("omp-app.theme", value),
        name,
      ),
  };
}

/** Opens the seeded chat and waits until its last reply is on the page. */
async function openChat(page: Page): Promise<void> {
  await page.getByRole("listbox", { name: "Session list" }).getByRole("option").first().click();
  await expect(page.getByText(LAST_REPLY)).toBeVisible({ timeout: 60_000 });
}

/** The app's styles are loaded: the shell's background is the theme's background token, not the browser default. */
async function expectStyledShell(page: Page): Promise<void> {
  const colors = await page.locator("[data-shell-layout]").evaluate((element) => {
    const probe = document.createElement("div");
    probe.style.backgroundColor = "var(--background)";
    document.body.append(probe);
    const token = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return { actual: getComputedStyle(element).backgroundColor, token };
  });
  expect(colors.token).not.toBe("");
  expect(colors.actual).toBe(colors.token);
}

realTest(
  "a /tan dispatch is one line in the chat, and omp's full text is behind a control",
  async ({ realApp }) => {
    const page = await realApp.open(themed("light"));
    await page.setViewportSize(DESKTOP);
    await openChat(page);
    await expectStyledShell(page);

    const transcript = page.getByRole("region", { name: "Conversation transcript" });
    const line = page.getByText(LINE, { exact: true });
    const control = page.getByText("Full message", { exact: true });
    const fullText = page.getByText(FULL_TEXT, { exact: false });

    await expect(line, "the dispatch is one line, once").toHaveCount(1);
    await expect(line, "the line is note text, not browser default").toHaveCSS("font-size", "12px");
    await expect(control, "the control is shown").toBeVisible();
    await expect(control, "the control has Tailwind's pointer").toHaveCSS("cursor", "pointer");
    await expect(fullText, "omp's full text waits behind the control").not.toBeVisible();
    await waitForFiniteAnimations(page);
    await transcript.screenshot({ path: join(screenshots, "fix-1276-tan-line-light.png") });

    await control.click();
    await expect(fullText, "the control shows omp's full text").toBeVisible();
    await waitForFiniteAnimations(page);
    await transcript.screenshot({ path: join(screenshots, "fix-1276-tan-full-light.png") });

    await page.setViewportSize(PHONE);
    await expect(fullText).toBeVisible();
    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflows, "no sideways scroll at 390 px").toBe(false);
    await waitForFiniteAnimations(page);
    await transcript.screenshot({ path: join(screenshots, "fix-1276-tan-full-phone.png") });

    await control.click();
    await expect(fullText).not.toBeVisible();
    const cut = await line.evaluate((element) => element.scrollWidth > element.clientWidth);
    expect(cut, "the whole line shows at 390 px: it wraps, it is not cut").toBe(false);
    await expect(line).toHaveText(LINE);
    await waitForFiniteAnimations(page);
    await transcript.screenshot({ path: join(screenshots, "fix-1276-tan-line-phone.png") });

    // 200% zoom is a 195 CSS-pixel window: the line wraps inside its note and does not spill out of it.
    await page.setViewportSize({ width: 195, height: 422 });
    await expect(line).toBeVisible();
    const noteOverflows = await page
      .locator('[data-slot="u1-custom-note"]')
      .evaluate((element) => element.scrollWidth > element.clientWidth);
    expect(noteOverflows, "the note does not spill out at 200% zoom").toBe(false);

    // The session list is hidden at 390 px, so the chat is reopened at the desktop width.
    await page.setViewportSize(DESKTOP);
    await page.reload();
    await openChat(page);
    await expect(line, "the dispatch is one line after a reload").toHaveCount(1);
    await expect(fullText).not.toBeVisible();

    expect(realApp.problems).toEqual([]);
  },
);

realTest("a /tan dispatch's line is the same in the dark theme", async ({ realApp }) => {
  const page = await realApp.open(themed("dark"));
  await page.setViewportSize(DESKTOP);
  await openChat(page);
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expectStyledShell(page);
  await expect(page.getByText(LINE, { exact: true }), "the dispatch is one line, once").toHaveCount(
    1,
  );
  await expect(page.getByText("Full message", { exact: true })).toBeVisible();
  await waitForFiniteAnimations(page);
  await page
    .getByRole("region", { name: "Conversation transcript" })
    .screenshot({ path: join(screenshots, "fix-1276-tan-line-dark.png") });

  expect(realApp.problems).toEqual([]);
});
