/// <reference types="node" />
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

/** The note a rewind leaves in the chat the person picked when the view did not switch (no-switch-notice.ts). */
const NOTE = "The rewind finished. The chat you picked stays open.";

/** A `count_reply <tag>` answer reads `count-<n> <tag>` (packages/server/test/fake-provider/fake-openai-server.ts). */
function answerTo(page: Page, tag: string) {
  return page.getByText(new RegExp(`^count-\\d+ ${tag}$`));
}

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function deferred(): Deferred {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = () => done();
  });
  return { promise, resolve };
}

/**
 * The rewind's `branch` answer is held back on the wire. The rewind stays in flight until the spec releases it, so the
 * person can pick another chat before the app decides whether to switch the view.
 */
interface HeldBranch {
  branchCallId: string | undefined;
  /** Resolves once the `branch` command has left the page. */
  readonly sent: Deferred;
  released: boolean;
  /** `open` calls the page sent after the held answer was released. */
  opensAfterRelease: number;
  /** Delivers the held answer to the page, now or when it arrives. */
  release: () => void;
}

function newHeldBranch(): HeldBranch {
  return {
    branchCallId: undefined,
    sent: deferred(),
    released: false,
    opensAfterRelease: 0,
    release: () => undefined,
  };
}

function isBranchCommand(args: unknown): boolean {
  return (args as { method?: unknown } | null | undefined)?.method === "branch";
}

async function holdBranchAnswer(page: Page, hold: HeldBranch): Promise<void> {
  await page.routeWebSocket(/\/ws/, (ws) => {
    const server = ws.connectToServer();
    let heldResult: string | Buffer | undefined;
    hold.release = () => {
      hold.released = true;
      if (heldResult !== undefined) ws.send(heldResult);
      heldResult = undefined;
    };
    ws.onMessage((message) => {
      const frame = JSON.parse(String(message)) as Record<string, unknown>;
      if (
        frame.type === "call" &&
        frame.port === "A0.chatSession" &&
        frame.method === "request" &&
        isBranchCommand(frame.args)
      ) {
        hold.branchCallId = String(frame.id);
        hold.sent.resolve();
      }
      if (frame.type === "call" && frame.method === "open" && hold.released) {
        hold.opensAfterRelease += 1;
      }
      server.send(message);
    });
    server.onMessage((message) => {
      const frame = JSON.parse(String(message)) as Record<string, unknown>;
      if (
        frame.type === "result" &&
        hold.branchCallId !== undefined &&
        String(frame.id) === hold.branchCallId &&
        !hold.released
      ) {
        heldResult = message;
        return;
      }
      ws.send(message);
    });
  });
}

/** Opens the rewind tree from the palette, chooses the first message, and presses Rewind here. */
async function rewindToFirstMessage(page: Page): Promise<void> {
  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.getByRole("combobox", { name: "Search commands" }).fill("conversation tree");
  await palette.getByRole("option", { name: /Conversation tree/ }).click();
  const opener = page.getByRole("button", { name: "Choose a message" });
  await expect(opener).toBeVisible({ timeout: 30_000 });
  await opener.click();
  const picker = page.getByRole("dialog");
  const message = picker.getByRole("treeitem", { name: /count_reply first/ });
  await message.focus();
  await page.keyboard.press("Enter");
  await expect(message).toHaveAttribute("aria-selected", "true");
  await picker.getByRole("button", { name: "Rewind here", exact: true }).click();
}

realTest(
  "a rewind that finishes after the person picked another chat says so in that chat, and the chat stays open",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(420_000);
    const hold = newHeldBranch();
    const page = await realApp.open({ beforeLoad: (page) => holdBranchAnswer(page, hold) });
    await page.setViewportSize({ width: 1280, height: 900 });

    // Chat "first" is the one the rewind starts in; chat "second" is the one picked while the answer is held.
    const firstComposer = await startChat(page);
    await sendPrompt(firstComposer, "count_reply first");
    await expect(answerTo(page, "first")).toBeVisible({ timeout: 60_000 });
    const secondComposer = await startChat(page);
    await sendPrompt(secondComposer, "count_reply second");
    await expect(answerTo(page, "second")).toBeVisible({ timeout: 60_000 });
    await page.getByRole("option", { name: /count_reply first/ }).click();
    await expect(answerTo(page, "first")).toBeVisible({ timeout: 60_000 });

    await rewindToFirstMessage(page);
    await hold.sent.promise;
    await expect(
      page.getByRole("status").filter({ hasText: "Rewinding the conversation…" }),
    ).toBeVisible();

    // The person picks chat "second" while the rewind's answer is still held.
    await page.getByRole("option", { name: /count_reply second/ }).click();
    await expect(answerTo(page, "second")).toBeVisible({ timeout: 60_000 });

    hold.release();
    // The note appears only after the app has decided not to switch the view, so it is the signal to wait for.
    await expect(page.getByText(NOTE)).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("option", { name: /count_reply second/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(answerTo(page, "second")).toBeVisible();
    expect(hold.opensAfterRelease).toBe(0);

    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-1619-no-switch-light.png"),
      fullPage: true,
    });

    await page.getByRole("radio", { name: "Dark" }).click();
    await expect(page.locator("html")).toHaveClass(/\bdark\b/);
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-1619-no-switch-dark.png"),
      fullPage: true,
    });

    await page.setViewportSize({ width: 390, height: 844 });
    // The shell switches to its narrow layout after the resize, and its columns animate into place: wait for the switch.
    await expect(page.locator('[data-shell-layout="narrow"]')).toBeVisible();
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "fix-1619-no-switch-390.png"),
      fullPage: true,
    });
  },
);
