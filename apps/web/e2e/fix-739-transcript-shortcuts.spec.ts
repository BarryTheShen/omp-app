import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, openToolCard, realTest, screenshots, sendPrompt, startChat } from "./real-omp";

const AT = Date.UTC(2026, 8, 1, 12, 0, 0);
const USAGE = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** One assistant message, as omp writes it. */
function assistant(content: readonly unknown[], at: number, stopReason = "stop") {
  return {
    type: "message",
    message: {
      role: "assistant",
      content,
      api: "openai-completions",
      provider: "fake",
      model: "fake-model",
      usage: USAGE,
      stopReason,
      timestamp: at,
    },
  };
}

// Filler above, so the transcript scrolls; then one turn with a thinking block, a bash call whose output runs past its
// preview (20 lines, 12 shown), and a closing sentence that Alt+L must bring into view.
const filler = Array.from({ length: 24 }, (_, index) => [
  {
    type: "message",
    message: {
      role: "user",
      content: [{ type: "text", text: `Question ${index + 1}.` }],
      timestamp: AT + index * 60_000,
    },
  },
  assistant(
    [{ type: "text", text: `Answer ${index + 1}, with a little more text so the page is long.` }],
    AT + index * 60_000 + 1_000,
  ),
]).flat();
const listing = Array.from({ length: 20 }, (_, index) => String(index + 1)).join("\n");
const turnAt = AT + 30 * 60_000;
const turn = [
  {
    type: "message",
    message: {
      role: "user",
      content: [{ type: "text", text: "Show me the numbers." }],
      timestamp: turnAt,
    },
  },
  assistant(
    [
      { type: "thinking", thinking: "Considering the options." },
      { type: "toolCall", id: "call_numbers", name: "bash", arguments: { command: "seq 1 20" } },
    ],
    turnAt + 1_000,
    "toolUse",
  ),
  {
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: "call_numbers",
      toolName: "bash",
      content: [{ type: "text", text: listing }],
      isError: false,
      timestamp: turnAt + 2_000,
    },
  },
  assistant([{ type: "text", text: "Done listing." }], turnAt + 3_000),
];

realTest.use({ seedEntries: { entries: [...filler, ...turn] } });

/** Sets the theme class the app reads, and waits until no finite animation is still running (a paused one never ends). */
async function setTheme(page: Page, dark: boolean): Promise<void> {
  await page.evaluate((isDark) => document.documentElement.classList.toggle("dark", isDark), dark);
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every(
        (animation) =>
          animation.playState !== "running" ||
          animation.effect?.getComputedTiming().iterations === Infinity,
      ),
  );
}

realTest(
  "#739: each transcript chord changes what the transcript shows, and the message box keeps its keys",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    await mkdir(screenshots, { recursive: true });
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    await page.getByRole("listbox", { name: "Session list" }).getByRole("option").first().click();
    await expect(page.getByText("Done listing.")).toBeVisible({ timeout: 60_000 });

    // The reasoning disclosure's trigger reads "Thought" or "Thought for Ns"; the policy removes it while thinking is hidden.
    const thinking = page.getByRole("button", { name: /^Thought/ });
    const showAll = page.getByRole("button", { name: "Show all 20 lines" });
    const card = page.getByTestId("tool-card-call_numbers");
    await expect(thinking).toBeVisible();

    const reasoningMarker = thinking.locator(":scope > span").first();
    const reasoningLabel = thinking.locator(":scope > span").nth(1);
    await expect(thinking).toHaveCSS("font-family", /JetBrains Mono/);
    await expect(thinking).toHaveCSS("font-size", "12px");
    await expect(reasoningMarker).toHaveText(">");
    await expect(reasoningMarker).toHaveCSS("rotate", "none");
    await expect(reasoningMarker).toHaveCSS("transform", "none");
    await thinking.click();
    await expect(reasoningMarker).toHaveCSS("rotate", "90deg");
    await expect(reasoningMarker).toHaveCSS("transform", "none");
    await thinking.click();
    await expect(reasoningMarker).toHaveCSS("rotate", "none");
    await thinking.click();
    await expect(reasoningMarker).toHaveCSS("rotate", "90deg");
    const mutedColor = await page.evaluate(() => {
      const probe = document.createElement("span");
      probe.className = "text-muted-foreground";
      document.body.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    });
    await expect(reasoningLabel).toHaveCSS("color", mutedColor);
    const reasoningBody = page.locator("[data-u1-reasoning-body]").first();
    await expect(reasoningBody).toHaveCSS("border-left-width", "1px");
    await expect(reasoningBody).toHaveCSS("padding-left", "16px");
    const railColor = await page.evaluate(() => {
      const probe = document.createElement("span");
      probe.className = "border border-foreground/10";
      document.body.append(probe);
      const color = getComputedStyle(probe).borderLeftColor;
      probe.remove();
      return color;
    });
    await expect(reasoningBody).toHaveCSS("border-left-color", railColor);
    await page.screenshot({ path: join(screenshots, "fix-739-light.png") });

    // Alt+T shows or hides the thinking block; the chord reads the same on every platform.
    // The composer takes focus when a chat opens, and transcript chords stand down while it has it: click the transcript first.
    await page.getByText("Done listing.").click();
    await expect(page.getByRole("textbox", { name: "Message input" })).not.toBeFocused();
    await page.keyboard.press("Alt+t");
    await expect(thinking).toBeHidden();
    await page.keyboard.press("Alt+t");
    await expect(thinking).toBeVisible();

    // A finished card starts as one line; open it to reach its output.
    await openToolCard(card);

    // Mod+O (Ctrl+O on Linux) expands the bash output in full, and collapses it again.
    await expect(showAll).toBeVisible();
    await page.keyboard.press("Control+o");
    await expect(showAll).toBeHidden();
    await setTheme(page, true);
    await page.screenshot({ path: join(screenshots, "fix-739-dark-output-expanded.png") });
    await setTheme(page, false);
    await page.keyboard.press("Control+o");
    // Mod+O folds every call again, so the card's output folds with its line.
    await expect(card.locator('[data-slot="u3-tool-card-trigger"]').first()).toHaveAttribute(
      "aria-expanded",
      "false",
    );

    // Mod+Shift+O hides the tool activity and shows it again; the assistant's own text stays.
    await page.keyboard.press("Control+Shift+O");
    await expect(card).toHaveCount(0);
    await expect(page.getByText("Done listing.")).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: join(screenshots, "fix-739-narrow-tools-hidden.png") });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.keyboard.press("Control+Shift+O");
    await expect(card).toBeVisible();

    // Alt+L jumps to the latest message: a reader scrolls up with the wheel and the jump button appears; the chord then
    // brings the closing sentence back into view and the button goes.
    const viewport = page.getByRole("region", { name: "Messages" });
    const jump = page.getByRole("button", { name: "Jump to latest message" });
    await viewport.hover();
    await page.mouse.wheel(0, -1_500);
    await expect(jump).toBeVisible();
    await expect(page.getByText("Done listing.")).not.toBeInViewport();
    await page.keyboard.press("Alt+l");
    await expect(page.getByText("Done listing.")).toBeInViewport();
    await expect(jump).toBeHidden();

    // Typed in the message box, the same chords do nothing: thinking stays, and the box keeps its text.
    const composer = page.getByRole("textbox", { name: "Message input" });
    await composer.click();
    await composer.fill("kept");
    await composer.press("Alt+t");
    await expect(thinking).toBeVisible();
    await expect(composer).toHaveValue("kept");
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "a streaming reasoning disclosure keeps its marker rotated only while open",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const page = await realApp.open({
      beforeLoad: (target) =>
        target.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light")),
    });
    const composer = await startChat(page);
    await sendPrompt(composer, "Please stream_reasoning and answer.");
    const thinking = page.getByRole("button", { name: /^Thought/ });
    await expect(thinking).toBeVisible({ timeout: 45_000 });
    await expect(thinking).toHaveCSS("animation-name", "pulse");
    const marker = thinking.locator(":scope > span").first();
    await expect(thinking).toHaveAttribute("aria-expanded", "true");
    await expect(marker).toHaveCSS("rotate", "90deg");
    await expect(marker).toHaveCSS("transform", "none");
    await thinking.click();
    await expect(thinking).toHaveAttribute("aria-expanded", "false");
    await expect(marker).toHaveCSS("rotate", "none");
    await expect(marker).toHaveCSS("transform", "none");
    expect(realApp.problems).toEqual([]);
  },
);
