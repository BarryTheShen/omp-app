import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import {
  expect,
  realTest,
  screenshots,
  sendPrompt,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";
import { sendTyped } from "./share-stub";

/**
 * Issue #657. Each overlay the app opens is checked at the four widths the issue names: no element inside it is wider
 * or taller than its box unless a scroll container between the element and the box has a scrollbar on that axis.
 * The sweep opens the overlays one after another in one chat. A trigger that fails is a finding, with a screenshot,
 * so it cannot hide an overlay.
 */

realTest.use({ seedWorkspace: { files: { "README.md": "# overlay sweep\n" }, gitRepo: true } });

const SIZES = [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
  { width: 834, height: 1112 },
  { width: 1280, height: 900 },
] as const;

/** The shell turns the sidebar and the panels into drawers at or below this width (`NARROW_QUERY` in the app shell). */
const NARROW_MAX_WIDTH = 768;

/** The right drawer is the aside; a tab list in the panel area carries the same label. */
const PANELS_DRAWER = 'aside[aria-label="Panels"]';

const ASK_PROMPT = "Please ask_user which database to use.";
const REFUSED_PROMPT = "auth_probe: answer with a refused key";

interface Checked {
  readonly overlay: string;
  readonly findings: readonly string[];
}

interface Sweep {
  readonly page: Page;
  readonly narrow: boolean;
  readonly checked: Checked[];
}

/**
 * Describes each element inside `root` that is wider or taller than `root`'s box with no scrollbar around it inside
 * `root`. It runs in the page, so it refers to nothing outside its own body.
 */
function overflowFindings(root: Element): string[] {
  const box = root.getBoundingClientRect();
  const scrollsOn = (element: Element, axis: "x" | "y"): boolean => {
    const style = getComputedStyle(element);
    if (axis === "x") {
      return /auto|scroll/.test(style.overflowX) && element.scrollWidth > element.clientWidth;
    }
    return /auto|scroll/.test(style.overflowY) && element.scrollHeight > element.clientHeight;
  };
  const scrolledInside = (element: Element, axis: "x" | "y"): boolean => {
    for (let parent = element.parentElement; parent !== null; parent = parent.parentElement) {
      if (scrollsOn(parent, axis)) return true;
      if (parent === root) break;
    }
    return false;
  };
  const findings: string[] = [];
  for (const element of root.querySelectorAll("*")) {
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") continue;
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    const wide = rect.width > box.width + 1 && !scrolledInside(element, "x");
    const tall = rect.height > box.height + 1 && !scrolledInside(element, "y");
    if (!wide && !tall) continue;
    const text = (element.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
    const label = `${element.tagName.toLowerCase()}${text === "" ? "" : ` "${text}"`}`;
    findings.push(
      `${label} is ${Math.round(rect.width)}×${Math.round(rect.height)} in a ${Math.round(box.width)}×${Math.round(box.height)} box${wide ? ", wider" : ""}${tall ? ", taller" : ""}`,
    );
  }
  return findings;
}

/**
 * The composer takes Ctrl+B for itself while it has focus, so the drawer shortcuts need focus somewhere else first.
 */
async function dropFocus(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

/** Below the narrow width the sidebar and the panels are drawers; Ctrl+B and Ctrl+Shift+B toggle them. */
async function openSessions({ page, narrow }: Sweep): Promise<void> {
  if (narrow && !(await page.getByRole("navigation", { name: "Sessions" }).isVisible())) {
    await dropFocus(page);
    await page.keyboard.press("Control+b");
  }
}

async function openPanels({ page, narrow }: Sweep): Promise<void> {
  if (narrow && !(await page.locator(PANELS_DRAWER).isVisible())) {
    await dropFocus(page);
    await page.keyboard.press("Control+Shift+b");
  }
}

/** Closes whatever is open, so the next overlay starts from the chat. Cleanup only: each overlay is checked before it. */
async function closeOverlays({ page, narrow }: Sweep): Promise<void> {
  const dialogs = page.locator(
    '[role="dialog"]:visible, [role="alertdialog"]:visible, [role="menu"]:visible',
  );
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if ((await dialogs.count()) === 0) break;
    await page.keyboard.press("Escape");
    await dialogs
      .first()
      .waitFor({ state: "hidden", timeout: 5_000 })
      .catch(() => undefined);
  }
  if (narrow && (await page.getByRole("navigation", { name: "Sessions" }).isVisible())) {
    await dropFocus(page);
    await page.keyboard.press("Control+b");
  }
  if (narrow && (await page.locator(PANELS_DRAWER).isVisible())) {
    await dropFocus(page);
    await page.keyboard.press("Control+Shift+b");
  }
}

/**
 * Opens one overlay with `open`, waits for it, and records what overflows its box. `after` may act on the open overlay
 * once it has been measured; the overlay is closed afterwards if it is still open.
 */
async function check(
  sweep: Sweep,
  overlay: string,
  open: () => Promise<Locator>,
  after?: (root: Locator) => Promise<void>,
): Promise<void> {
  try {
    const root = await open();
    await expect(root).toBeVisible({ timeout: 30_000 });
    await waitForFiniteAnimations(sweep.page);
    sweep.checked.push({ overlay, findings: await root.evaluate(overflowFindings) });
    if (after !== undefined) await after(root);
  } catch (error) {
    const reason =
      error instanceof Error ? error.message.split("\n").slice(0, 7).join(" | ") : String(error);
    const openNow = await sweep.page
      .locator(
        '[role="dialog"]:visible, [role="alertdialog"]:visible, [role="menu"]:visible, nav[aria-label="Sessions"]:visible, aside[aria-label="Panels"]:visible',
      )
      .evaluateAll((items) =>
        items.map(
          (item) => item.getAttribute("aria-label") ?? item.getAttribute("role") ?? item.tagName,
        ),
      );
    const shot = join(
      screenshots,
      `657-fail-${sweep.narrow ? "narrow" : "wide"}-${overlay.replaceAll(/\W+/g, "-").toLowerCase()}.png`,
    );
    await sweep.page.screenshot({ path: shot }).catch(() => undefined);
    sweep.checked.push({
      overlay,
      findings: [
        `could not open it: ${reason} (open then: ${openNow.join(", ") || "nothing"}; screenshot ${shot})`,
      ],
    });
  }
  await closeOverlays(sweep);
}

for (const { width, height } of SIZES) {
  realTest(
    `at ${width} px wide, every overlay fits its box without an unscrolled element outside it`,
    async ({ realApp }, testInfo) => {
      testInfo.setTimeout(600_000);
      const page = await realApp.open();
      page.setDefaultTimeout(20_000);
      await page.setViewportSize({ width, height });
      const sweep: Sweep = { page, narrow: width <= NARROW_MAX_WIDTH, checked: [] };
      // Ctrl+B means the drawer below the narrow width and the sidebar above it: wait until the shell has switched.
      const layout = sweep.narrow ? "narrow" : "wide";
      await expect(page.locator(`[data-shell-layout="${layout}"]`)).toHaveCount(1);
      await openSessions(sweep);
      const composer = await startChat(page);
      await sendPrompt(composer, "sweep chat");
      await expect(page.getByText("pong", { exact: true }).first()).toBeVisible({
        timeout: 60_000,
      });

      if (sweep.narrow) {
        await check(sweep, "Sessions drawer", async () => {
          await openSessions(sweep);
          return page.getByRole("navigation", { name: "Sessions" });
        });
        await check(sweep, "Panels drawer", async () => {
          await openPanels(sweep);
          return page.locator(PANELS_DRAWER);
        });
      }

      await check(
        sweep,
        "Settings",
        async () => {
          await page.getByRole("button", { name: "Settings", exact: true }).click();
          return page.getByRole("dialog", { name: "Settings", exact: true });
        },
        async (settings) => {
          // The detector must see a planted overflow, or a clean result on the overlays means nothing.
          await settings.evaluate((root) => {
            const planted = document.createElement("div");
            planted.dataset.sweepControl = "1";
            planted.style.width = "2400px";
            planted.style.height = "20px";
            root.appendChild(planted);
          });
          const found = await settings.evaluate(overflowFindings);
          await settings.evaluate((root) =>
            root.querySelector('[data-sweep-control="1"]')?.remove(),
          );
          sweep.checked.push({
            overlay: "detector control (a planted 2400 px element)",
            findings: found.some((finding) => finding.includes("2400×20"))
              ? []
              : [`not reported; the detector said: ${found.join(" ; ") || "nothing"}`],
          });
        },
      );

      await check(sweep, "Settings: Retry & Fallback", async () => {
        await page.getByRole("button", { name: "Settings", exact: true }).click();
        const settings = page.getByRole("dialog", { name: "Settings", exact: true });
        await settings.getByRole("button", { name: "Model", exact: true }).click();
        await settings.getByRole("option", { name: "Retry & Fallback", exact: true }).click();
        return settings;
      });

      await check(sweep, "Model and thinking", async () => {
        await page
          .locator('[data-layout-area="composerToolbar"] button[aria-label^="Model:"]')
          .click();
        return page.getByRole("dialog", { name: "Model and thinking" });
      });

      await check(sweep, "Command palette", async () => {
        await composer.click();
        await page.keyboard.press("Control+k");
        return page.getByRole("dialog", { name: "Command palette" });
      });

      await check(sweep, "Keyboard shortcuts", async () => {
        await composer.click();
        await page.keyboard.press("Control+k");
        await page.getByRole("option", { name: /^Keyboard shortcuts/ }).click();
        return page.getByRole("dialog", { name: "Keyboard shortcuts" });
      });

      await check(sweep, "Execution modes", async () => {
        await composer.click();
        await page.keyboard.press("Control+k");
        await page.getByRole("option", { name: /^Execution modes/ }).click();
        return page.getByRole("dialog", { name: "Execution modes" });
      });

      await check(sweep, "Open session", async () => {
        await composer.click();
        await page.keyboard.press("Control+k");
        await page.getByRole("option", { name: /^Open session/ }).click();
        return page.getByRole("dialog", { name: "Open session" });
      });

      await check(sweep, "Prompt history", async () => {
        await composer.click();
        await page.keyboard.press("Control+r");
        return page.getByRole("dialog").first();
      });

      // The popup's accessible name is its title, "Usage": its aria-label ("Session usage details") does not give that name.
      await check(sweep, "Usage details", async () => {
        await page.getByRole("button", { name: /Usage/ }).click();
        return page.getByRole("dialog", { name: "Usage", exact: true });
      });

      await check(sweep, "Session row menu", async () => {
        await openSessions(sweep);
        await page
          .getByRole("button", { name: /^More actions for / })
          .first()
          .click();
        return page.getByRole("menu");
      });

      await check(sweep, "Delete chat", async () => {
        await openSessions(sweep);
        await page
          .getByRole("button", { name: /^More actions for / })
          .first()
          .click();
        await page.getByRole("menuitem", { name: /^Delete / }).click();
        return page.getByRole("dialog", { name: "Delete chat" });
      });

      await check(
        sweep,
        "Answer questions",
        async () => {
          await sendPrompt(composer, ASK_PROMPT);
          return page.getByRole("dialog", { name: /^Answer questions$/ });
        },
        async (question) => {
          await question.getByText("Postgres", { exact: true }).click();
          await question.getByRole("button", { name: "Review", exact: true }).click();
          await question.getByRole("button", { name: "Submit", exact: true }).click();
          await expect(question).toBeHidden({ timeout: 30_000 });
        },
      );

      await check(sweep, "Move to worktree", async () => {
        await sendTyped(page, composer, "/wt feature");
        return page.getByRole("dialog", { name: "Move to worktree" });
      });

      await check(sweep, "Reset usage", async () => {
        await sendTyped(page, composer, "/usage reset codex/active");
        return page.getByRole("dialog", { name: "Reset usage" });
      });

      await check(sweep, "Choose another model", async () => {
        await sendPrompt(composer, REFUSED_PROMPT);
        await expect(page.getByText("The model could not sign in")).toBeVisible({
          timeout: 60_000,
        });
        await page.getByRole("button", { name: "Choose another model" }).click();
        return page.getByRole("dialog").first();
      });

      await check(sweep, "Provider login", async () => {
        await page.getByRole("button", { name: "Sign in…" }).click();
        return page.getByRole("dialog").first();
      });

      await check(sweep, "Remove SSH host confirm", async () => {
        await sendTyped(page, composer, "/ssh remove sweep-host");
        return page.getByRole("dialog").first();
      });

      await testInfo.attach(`overlays-${width}px.json`, {
        body: JSON.stringify(sweep.checked, null, 2),
        contentType: "application/json",
      });
      const failing = sweep.checked.filter((entry) => entry.findings.length > 0);
      expect(
        failing,
        `overlays at ${width} px with something outside their box or that did not open; checked: ${sweep.checked.map((entry) => entry.overlay).join(", ")}`,
      ).toEqual([]);
      expect(realApp.problems).toEqual([]);
    },
  );
}
