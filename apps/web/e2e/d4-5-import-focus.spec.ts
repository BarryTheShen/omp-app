import { mkdir } from "node:fs/promises";
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

const IMPORT_TITLE = "Import a shared chat";
const LINK_PLACEHOLDER = "Paste the share link, which starts with https://";
const CONFIRM_TITLE = "Import this shared chat?";
const BAD_LINK = "That is not a share link. Share links start with https://.";
const SHARE_LINK = ["https://my.omp.sh/s", "focus-check"].join("/");
const IMPORT_CAPABILITIES = {
  "host.session-import": { state: "available", via: "host" },
  "upstream.session-import": { state: "available", via: "upstream" },
} as const;

type Frame = Record<string, unknown>;
interface ImportTarget {
  threadId: string | undefined;
}

/** Makes the typed import operation available and answers it with the id of an existing second real chat. */
async function routeImport(page: Page, target: ImportTarget, calls: Frame[]): Promise<void> {
  await page.routeWebSocket(/\/ws\?/, (socket) => {
    const server = socket.connectToServer();
    // The app's capability reads, answered with the server's map plus the import capabilities: a chat's capabilities
    // come from the same map, so a map of the import capabilities alone would leave the chat unable to send.
    const capabilityCalls = new Set<unknown>();
    const withImport = (value: unknown) => ({
      ...(typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}),
      ...IMPORT_CAPABILITIES,
    });
    server.onMessage((message) => {
      const frame = JSON.parse(
        typeof message === "string" ? message : message.toString("utf8"),
      ) as Frame;
      if (frame.type === "welcome") {
        socket.send(JSON.stringify({ ...frame, capabilities: withImport(frame.capabilities) }));
        return;
      }
      if (frame.type === "result" && capabilityCalls.delete(frame.id) && frame.ok === true) {
        socket.send(JSON.stringify({ ...frame, value: withImport(frame.value) }));
        return;
      }
      socket.send(message);
    });
    socket.onMessage((message) => {
      const frame = JSON.parse(
        typeof message === "string" ? message : message.toString("utf8"),
      ) as Frame;
      if (frame.type === "call" && frame.port === "A0.app" && frame.method === "capabilities") {
        capabilityCalls.add(frame.id);
        server.send(message);
        return;
      }
      if (frame.type === "call" && frame.port === "A1.sessionImport" && frame.method === "import") {
        calls.push(frame.args as Frame);
        const threadId = target.threadId;
        if (threadId === undefined) {
          server.send(message);
          return;
        }
        socket.send(
          JSON.stringify({
            type: "result",
            id: frame.id,
            ok: true,
            value: {
              threadId,
              sessionFile: "/workspace/.omp/sessions/imported.jsonl",
              title: "Second real chat",
              sourceKind: "omp-share",
              sourceShareUrl: SHARE_LINK,
              artifactStatus: "preserved",
              artifactWarnings: [],
            },
          }),
        );
        return;
      }
      server.send(message);
    });
  });
}

function answerTo(page: Page, tag: string) {
  return page.getByText(new RegExp(`^count-\\d+ ${tag}$`));
}

async function currentThreadId(page: Page): Promise<string | null> {
  return page.evaluate(() => window.localStorage.getItem("omp.app.root.thread"));
}

async function openImportDialog(page: Page) {
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Search commands" }).fill("import");
  await page.getByRole("option", { name: IMPORT_TITLE }).click();
  const dialog = page.getByRole("dialog", { name: IMPORT_TITLE });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function switchToChat(page: Page, promptTag: string, threadId: string): Promise<void> {
  await page
    .getByRole("listbox", { name: "Session list" })
    .getByRole("option")
    .filter({ hasText: `count_reply ${promptTag}` })
    .click();
  await expect(answerTo(page, promptTag)).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => currentThreadId(page)).toBe(threadId);
}

async function expectStylesLoaded(page: Page): Promise<void> {
  const background = await page
    .locator("[data-shell-layout]")
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(background).not.toBe("rgba(0, 0, 0, 0)");
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const widths = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(widths.scrollWidth).toBeLessThanOrEqual(widths.clientWidth);
}

realTest(
  "shared-chat import restores focus to the opened chat in light, dark, and narrow views",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    await mkdir(screenshots, { recursive: true });
    const target: ImportTarget = { threadId: undefined };
    const importCalls: Frame[] = [];
    const page = await realApp.open({
      beforeLoad: async (openedPage) => {
        await openedPage.addInitScript(() => window.localStorage.setItem("omp-app.theme", "light"));
        await routeImport(openedPage, target, importCalls);
      },
    });
    await page.setViewportSize({ width: 1280, height: 900 });

    const firstComposer = await startChat(page);
    await expect(page.getByText("No messages yet.")).toBeVisible({ timeout: 30_000 });
    await sendPrompt(firstComposer, "count_reply first");
    await expect(answerTo(page, "first")).toBeVisible({ timeout: 60_000 });
    const firstThreadId = await currentThreadId(page);
    if (firstThreadId === null) throw new Error("The first real chat had no thread id.");

    const secondComposer = await startChat(page);
    await expect(page.getByText("No messages yet.")).toBeVisible({ timeout: 30_000 });
    await sendPrompt(secondComposer, "count_reply second");
    await expect(answerTo(page, "second")).toBeVisible({ timeout: 60_000 });
    const secondThreadId = await currentThreadId(page);
    if (secondThreadId === null || secondThreadId === firstThreadId) {
      throw new Error("The second real chat did not get a distinct thread id.");
    }
    target.threadId = secondThreadId;
    await switchToChat(page, "first", firstThreadId);

    const lightDialog = await openImportDialog(page);
    await expectStylesLoaded(page);
    await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "d4-5-import-focus-dialog-light.png"),
      fullPage: true,
    });
    await lightDialog.getByPlaceholder(LINK_PLACEHOLDER).fill(SHARE_LINK);
    await lightDialog.getByRole("button", { name: "Continue", exact: true }).click();
    const lightConfirm = page.getByRole("dialog", { name: CONFIRM_TITLE });
    await expect(lightConfirm).toBeVisible();
    await lightConfirm.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(answerTo(page, "second")).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => currentThreadId(page)).toBe(secondThreadId);
    const composer = page.getByRole("textbox", { name: "Message input" });
    await expect(composer).toBeFocused();
    await expectStylesLoaded(page);
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "d4-5-import-focus-composer-light.png"),
      fullPage: true,
    });

    await page.getByRole("radio", { name: "Dark" }).click();
    await expect(page.locator("html")).toHaveClass(/\bdark\b/);
    await switchToChat(page, "first", firstThreadId);
    const darkDialog = await openImportDialog(page);
    await expectStylesLoaded(page);
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "d4-5-import-focus-dialog-dark.png"),
      fullPage: true,
    });
    await darkDialog.getByPlaceholder(LINK_PLACEHOLDER).fill(SHARE_LINK);
    await darkDialog.getByRole("button", { name: "Continue", exact: true }).click();
    const darkConfirm = page.getByRole("dialog", { name: CONFIRM_TITLE });
    await expect(darkConfirm).toBeVisible();
    await darkConfirm.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(answerTo(page, "second")).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => currentThreadId(page)).toBe(secondThreadId);
    await expect(composer).toBeFocused();
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "d4-5-import-focus-composer-dark.png"),
      fullPage: true,
    });

    await switchToChat(page, "first", firstThreadId);
    await page.setViewportSize({ width: 390, height: 844 });
    const narrowDialog = await openImportDialog(page);
    await expectStylesLoaded(page);
    await expectNoHorizontalOverflow(page);
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "d4-5-import-focus-dialog-390.png"),
      fullPage: true,
    });
    await narrowDialog.getByPlaceholder(LINK_PLACEHOLDER).fill(SHARE_LINK);
    await narrowDialog.getByRole("button", { name: "Continue", exact: true }).click();
    const narrowConfirm = page.getByRole("dialog", { name: CONFIRM_TITLE });
    await expect(narrowConfirm).toBeVisible();
    await narrowConfirm.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(answerTo(page, "second")).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => currentThreadId(page)).toBe(secondThreadId);
    await expect(composer).toBeFocused();
    await expectNoHorizontalOverflow(page);
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, "d4-5-import-focus-composer-390.png"),
      fullPage: true,
    });

    expect(importCalls).toEqual([
      { sourceKind: "omp-share", sourceRef: SHARE_LINK, folder: realApp.folder },
      { sourceKind: "omp-share", sourceRef: SHARE_LINK, folder: realApp.folder },
      { sourceKind: "omp-share", sourceRef: SHARE_LINK, folder: realApp.folder },
    ]);

    const escapeDialog = await openImportDialog(page);
    await page.keyboard.press("Escape");
    await expect(escapeDialog).toBeHidden();
    await expect(composer).toBeFocused();

    const invalidDialog = await openImportDialog(page);
    await invalidDialog.getByPlaceholder(LINK_PLACEHOLDER).fill("not a share link");
    await invalidDialog.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page.getByText(BAD_LINK, { exact: true })).toBeVisible();
    await expect(page.getByRole("dialog", { name: CONFIRM_TITLE })).toHaveCount(0);
    await expect(composer).toBeFocused();
    expect(importCalls).toHaveLength(3);
    expect(realApp.problems).toEqual([]);
  },
);
