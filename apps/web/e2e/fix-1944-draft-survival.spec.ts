import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page, WebSocketRoute } from "@playwright/test";
import { expect, type RealApp, realTest, sendPrompt, startChat } from "./real-omp";

realTest.setTimeout(300_000);

const LONG_DRAFT = Array.from({ length: 400 }, (_, index) => `word${index + 1}`).join(" ");
const LARGE_PASTE = "x".repeat(20_000);

function parseFrame(message: string | Buffer): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(String(message));
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
function holdNextBashSend() {
  let resolveSeen: () => void = () => undefined;
  let resolveAdmitted: () => void = () => undefined;
  const seen = new Promise<void>((resolve) => {
    resolveSeen = resolve;
  });
  const admitted = new Promise<void>((resolve) => {
    resolveAdmitted = resolve;
  });
  let holdNext = false;
  let requestId: unknown;
  let held: { readonly server: WebSocketRoute; readonly message: string | Buffer } | undefined;
  return {
    readonlyBeforeLoad: async (page: Page): Promise<void> => {
      await page.routeWebSocket(
        () => true,
        (webSocket) => {
          const server = webSocket.connectToServer();
          webSocket.onMessage((message) => {
            const frame = parseFrame(message);
            const method = (frame.args as { method?: unknown } | undefined)?.method;
            if (
              holdNext &&
              frame.type === "call" &&
              frame.port === "A0.chatSession" &&
              frame.method === "request" &&
              method === "bash"
            ) {
              holdNext = false;
              requestId = frame.id;
              held = { server, message };
              resolveSeen();
              return;
            }
            server.send(message);
          });
          server.onMessage((message) => {
            const frame = parseFrame(message);
            if (frame.type === "result" && frame.id === requestId && frame.ok === true)
              resolveAdmitted();
            webSocket.send(message);
          });
        },
      );
    },
    begin: (): void => {
      holdNext = true;
    },
    seen: () => seen,
    admitted: () => admitted,
    release: (): void => {
      const request = held;
      if (request === undefined) throw new Error("No bash send is waiting for admission.");
      held = undefined;
      request.server.send(request.message);
    },
    wasHeld: (): boolean => held !== undefined,
  };
}
function composer(page: Page): Locator {
  return page.getByRole("textbox", { name: "Message input" });
}
async function composerAfterReopen(page: Page, title?: RegExp): Promise<Locator> {
  const input = composer(page);
  const list = page.getByRole("listbox", { name: "Session list" });
  if (title !== undefined) {
    const row = list.getByRole("option").filter({ hasText: title }).first();
    await expect(row).toHaveCount(1, { timeout: 120_000 });
    await row.click();
  } else if ((await input.count()) === 0) {
    const row = list.getByRole("option").first();
    if ((await row.count()) > 0) await row.click();
    else await startChat(page);
  }
  await expect(input).toBeVisible({ timeout: 120_000 });
  return input;
}

function transcript(page: Page): Locator {
  return page.getByRole("region", { name: "Conversation transcript" });
}

async function typeLongDraftInto(_page: Page, input: Locator): Promise<void> {
  await input.fill(LONG_DRAFT);
  await expect(input).toHaveValue(LONG_DRAFT, { timeout: 120_000 });
}

async function typeLongDraft(page: Page): Promise<Locator> {
  const input = await startChat(page);
  await typeLongDraftInto(page, input);
  return input;
}

async function typeSlowDraftInto(page: Page, input: Locator): Promise<void> {
  await input.focus();
  await page.keyboard.type(LONG_DRAFT, { delay: 40 });
  await expect(input).toHaveValue(LONG_DRAFT, { timeout: 120_000 });
}

async function restoreAfterReload(page: Page, expected: string): Promise<Locator> {
  await page.reload();
  const input = composer(page);
  await expect(input).toHaveValue(expected, { timeout: 120_000 });
  return input;
}

async function paste(input: Locator, text: string): Promise<void> {
  await input.evaluate((element, value) => {
    const data = new DataTransfer();
    data.setData("text/plain", value);
    element.dispatchEvent(
      new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }),
    );
  }, text);
}
interface DraftStateSnapshot {
  readonly buffers: readonly { readonly key: string; readonly text: string | null }[];
  readonly files: readonly {
    readonly directory: string;
    readonly name: string;
    readonly scope: unknown;
    readonly kind: unknown;
    readonly text: string | null;
  }[];
  readonly navigation: {
    readonly savedThread: string | null;
    readonly unsentChat: string | null;
    readonly newChatSurface: boolean;
    readonly composerValue: string | null;
  };
}
async function readDraftState(realApp: RealApp, page: Page): Promise<DraftStateSnapshot> {
  const buffers = await page.evaluate(() => {
    const entries: { readonly key: string; readonly text: string | null }[] = [];
    for (const [key, raw] of Object.entries(localStorage)) {
      if (!key.includes(":draft:")) continue;
      try {
        const value = JSON.parse(raw) as { input?: { text?: unknown } };
        entries.push({
          key,
          text: typeof value.input?.text === "string" ? value.input.text : null,
        });
      } catch {
        entries.push({ key, text: null });
      }
    }
    return entries;
  });
  const navigation = await page.evaluate(() => ({
    savedThread: localStorage.getItem("omp.app.root.thread"),
    unsentChat: sessionStorage.getItem("omp.app.root.unsent-chat"),
    newChatSurface: document.querySelector('[data-new-chat="true"]') !== null,
    composerValue:
      document.querySelector<HTMLTextAreaElement>('[aria-label="Message input"]')?.value ?? null,
  }));
  const files: {
    directory: string;
    name: string;
    scope: unknown;
    kind: unknown;
    text: string | null;
  }[] = [];
  for (const directory of ["threads", "folders"]) {
    const path = join(realApp.appDataDir, "drafts", directory);
    let names: string[];
    try {
      names = await readdir(path);
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
        continue;
      throw error;
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        const saved = JSON.parse(await readFile(join(path, name), "utf8")) as {
          kind?: unknown;
          scope?: unknown;
          text?: unknown;
        };
        files.push({
          directory,
          name,
          scope: saved.scope ?? null,
          kind: saved.kind,
          text: saved.kind === "draft" && typeof saved.text === "string" ? saved.text : null,
        });
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ENOENT"
        )
          continue;
        throw error;
      }
    }
  }
  return { buffers, files, navigation };
}
function draftStateReport(state: DraftStateSnapshot): string {
  const lines: string[] = [];
  const add = (source: string, details: string, text: string | null): void => {
    if (text === null || text.length === 0) {
      lines.push(`DRAFT-STATE ${source} ${details} text=${JSON.stringify(text)}`);
      return;
    }
    const chunks = Math.ceil(text.length / 100);
    for (let index = 0; index < chunks; index += 1) {
      lines.push(
        `DRAFT-STATE ${source} ${details} part=${index + 1}/${chunks} ${JSON.stringify(text.slice(index * 100, (index + 1) * 100))}`,
      );
    }
  };
  lines.push(`DRAFT-STATE navigation ${JSON.stringify(state.navigation)}`);
  for (const buffer of state.buffers) {
    add("buffer", `key=${JSON.stringify(buffer.key)}`, buffer.text);
  }
  for (const file of state.files) {
    add(
      "file",
      `directory=${file.directory} name=${file.name} scope=${JSON.stringify(file.scope)} kind=${String(file.kind)}`,
      file.text,
    );
  }
  return lines.join("\n");
}

async function waitForLocalDraft(
  realApp: RealApp,
  page: Page,
  text: string,
  scope?: "folder" | "thread",
): Promise<void> {
  try {
    await expect
      .poll(
        async () => {
          const state = await readDraftState(realApp, page);
          const bufferMatch = state.buffers.some(
            (entry) =>
              entry.text === text &&
              (scope === undefined || entry.key.includes(`:draft:${scope}:`)),
          );
          const fileMatch = state.files.some(
            (entry) =>
              entry.text === text && (scope === undefined || entry.directory === `${scope}s`),
          );
          return { found: bufferMatch || fileMatch };
        },
        { timeout: 120_000 },
      )
      .toMatchObject({ found: true });
  } catch (error) {
    const state = await readDraftState(realApp, page);
    const original = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Draft persistence state was not reached for ${JSON.stringify(text)} in ${scope ?? "any"} scope.\n${draftStateReport(state)}\n${original}`,
    );
  }
}

async function expectComposerValue(realApp: RealApp, page: Page, expected: string): Promise<void> {
  try {
    await expect
      .poll(
        async () => ({
          value: await composer(page).inputValue(),
          ...(await readDraftState(realApp, page)),
        }),
        { timeout: 120_000 },
      )
      .toMatchObject({ value: expected });
  } catch (error) {
    const actual = await composer(page).inputValue();
    const state = await readDraftState(realApp, page);
    const original = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Composer persistence state was not restored. Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}.\n${draftStateReport(state)}\n${original}`,
    );
  }
}

/** Waits until no local draft holds `text`: the send's clear is saved, so a reload cannot bring the sent text back. */
async function waitForLocalDraftCleared(realApp: RealApp, page: Page, text: string): Promise<void> {
  try {
    await expect
      .poll(
        async () => {
          const state = await readDraftState(realApp, page);
          return (
            state.buffers.some((entry) => entry.text === text) ||
            state.files.some((entry) => entry.text === text)
          );
        },
        { timeout: 120_000 },
      )
      .toBe(false);
  } catch (error) {
    const state = await readDraftState(realApp, page);
    const original = error instanceof Error ? error.message : String(error);
    throw new Error(
      `The sent text ${JSON.stringify(text)} is still held by a local draft.\n${draftStateReport(state)}\n${original}`,
    );
  }
}

async function waitUntilElapsed(startedAt: number, delayMs: number): Promise<void> {
  if (delayMs <= 0) return;
  await expect
    .poll(() => Date.now() - startedAt, {
      timeout: delayMs + 10_000,
      intervals: [100, 500],
    })
    .toBeGreaterThanOrEqual(delayMs);
}
async function reloadAfterDelay(page: Page, delayMs: number): Promise<void> {
  if (delayMs > 0) {
    const startedAt = Date.now();
    await expect
      .poll(() => Date.now() - startedAt, {
        timeout: delayMs + 10_000,
        intervals: [100, 500],
      })
      .toBeGreaterThanOrEqual(delayMs);
  }
  await page.reload();
}

realTest("keeps a fresh-chat draft through an immediate reload", async ({ realApp }) => {
  const page = await realApp.open();
  await typeLongDraft(page);
  await restoreAfterReload(page, LONG_DRAFT);
  expect(realApp.problems).toEqual([]);
});

realTest(
  "saves a chat opened by reload as the target after its first message",
  async ({ realApp }) => {
    const page = await realApp.open();
    const input = await startChat(page);
    await input.fill("draft before target send");
    await waitForLocalDraft(realApp, page, "draft before target send", "folder");
    await page.reload();
    await expectComposerValue(realApp, page, "draft before target send");
    await composer(page).press("Enter");
    await expect(
      transcript(page).getByText("draft before target send", { exact: true }),
    ).toHaveCount(1, {
      timeout: 120_000,
    });
    await expect(transcript(page).getByText("pong", { exact: true })).toHaveCount(1, {
      timeout: 120_000,
    });
    await page.reload();
    await expect(
      transcript(page).getByText("draft before target send", { exact: true }),
    ).toHaveCount(1, {
      timeout: 120_000,
    });
    await expectComposerValue(realApp, page, "");
    expect(realApp.problems).toEqual([]);
  },
);

realTest("saves a first-line bash command chat as the target after reload", async ({ realApp }) => {
  const page = await realApp.open();
  const input = await startChat(page);
  await input.fill("!echo marker");
  await input.press("Enter");
  await expect(transcript(page).getByText("marker", { exact: true }).first()).toBeVisible({
    timeout: 120_000,
  });
  await page.reload();
  await expect(transcript(page).getByText("marker", { exact: true }).first()).toBeVisible({
    timeout: 120_000,
  });
  expect(realApp.problems).toEqual([]);
});
realTest("keeps a reloaded bash chat draft out of the next New chat", async ({ realApp }) => {
  const page = await realApp.open();
  const input = await startChat(page);
  await input.fill("!echo reloaded-bash-marker");
  await input.press("Enter");
  await expect(
    transcript(page).getByText("reloaded-bash-marker", { exact: true }).first(),
  ).toBeVisible({ timeout: 120_000 });
  await page.reload();
  await expect(
    transcript(page).getByText("reloaded-bash-marker", { exact: true }).first(),
  ).toBeVisible({ timeout: 120_000 });
  const reopened = composer(page);
  await reopened.fill("draft after reloading bash chat");
  await waitForLocalDraft(realApp, page, "draft after reloading bash chat", "thread");
  await startChat(page);
  await expectComposerValue(realApp, page, "");
  expect(realApp.problems).toEqual([]);
});
realTest(
  "a first bash send reloaded at once leaves no copy, and text typed while a New chat opens comes back whole",
  async ({ realApp }) => {
    const page = await realApp.open();
    const input = await startChat(page);
    await input.fill("!echo opening-marker");
    await input.press("Enter");
    await expect(transcript(page).getByText("opening-marker", { exact: true }).first()).toBeVisible(
      {
        timeout: 120_000,
      },
    );
    await page.reload();
    await expect(transcript(page).getByText("opening-marker", { exact: true }).first()).toBeVisible(
      {
        timeout: 120_000,
      },
    );
    // Reloaded as soon as the output showed: the sent command is in no composer and in no draft.
    await expectComposerValue(realApp, page, "");
    const reloaded = await readDraftState(realApp, page);
    expect(reloaded.files.some((entry) => entry.text === "!echo opening-marker")).toBe(false);
    expect(reloaded.buffers.some((entry) => entry.text === "!echo opening-marker")).toBe(false);
    await composer(page).fill("draft kept in the old chat");
    await waitForLocalDraft(realApp, page, "draft kept in the old chat", "thread");
    await page
      .locator('[aria-label="Sessions"]')
      .getByRole("button", { name: "New chat" })
      .first()
      .click();
    // The old chat's text leaves the composer at once. The New chat's text is typed while its chat is still opening.
    await expectComposerValue(realApp, page, "");
    await composer(page).fill("window text");
    // Typing goes on as soon as the New chat's surface is up, before its folder draft has loaded. The surface is
    // watched every frame, so the text lands in that interval rather than after it.
    await page.waitForFunction(
      () => document.querySelector('[data-new-chat="true"]') !== null,
      undefined,
      { polling: "raf", timeout: 120_000 },
    );
    await composer(page).press("End");
    await composer(page).pressSequentially(" more");
    await expectComposerValue(realApp, page, "window text more");
    await waitForLocalDraft(realApp, page, "window text more", "folder");
    await page.reload();
    await expectComposerValue(realApp, page, "window text more");
    const state = await readDraftState(realApp, page);
    expect(
      state.files.some(
        (entry) => entry.directory === "threads" && entry.text === "window text more",
      ),
    ).toBe(false);
    expect(
      state.files.some(
        (entry) => entry.directory === "folders" && entry.text === "draft kept in the old chat",
      ),
    ).toBe(false);
    expect(
      state.files.some(
        (entry) => entry.directory === "threads" && entry.text === "draft kept in the old chat",
      ),
    ).toBe(true);
    expect(realApp.problems).toEqual([]);
  },
);
realTest(
  "an admitted in-flight bash command reopens on its chat",
  async ({ realApp }, testInfo) => {
    const gate = holdNextBashSend();
    const page = await realApp.open({ beforeLoad: gate.readonlyBeforeLoad });
    const input = await startChat(page);
    await input.fill("!sleep 12; echo b1-late");
    const enteredAt = Date.now();
    gate.begin();
    await input.press("Enter");
    await expect.poll(() => gate.wasHeld(), { timeout: 120_000 }).toBe(true);
    gate.release();
    await gate.admitted();
    await expect(input).toHaveValue("", { timeout: 120_000 });
    await waitUntilElapsed(enteredAt, 1_000);
    await page.reload();
    try {
      await expect(transcript(page)).toContainText("sleep 12; echo b1-late", {
        timeout: 120_000,
      });
      await expect(transcript(page).getByText("b1-late", { exact: true }).first()).toBeVisible({
        timeout: 120_000,
      });
      await expectComposerValue(realApp, page, "");
      expect(realApp.problems).toEqual([]);
    } catch (error) {
      const snapshot = await readDraftState(realApp, page);
      const transcriptText = await transcript(page)
        .innerText()
        .catch(() => "<missing transcript>");
      const screenshotPath = testInfo.outputPath("admitted-bash-failure.png");
      await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
      const original = error instanceof Error ? error.message : String(error);
      throw new Error(
        `N1-DIAG problems=${JSON.stringify(realApp.problems)} transcript=${JSON.stringify(transcriptText)} screenshot=${screenshotPath}\n${draftStateReport(snapshot)}\n${original}`,
      );
    }
  },
);

realTest(
  "an unadmitted in-flight bash command restores only the new-chat draft",
  async ({ realApp }) => {
    realApp.allowProblem(/WebSocket.*closed/i);
    realApp.allowProblem(/Connection to the app server closed/);
    const gate = holdNextBashSend();
    const page = await realApp.open({ beforeLoad: gate.readonlyBeforeLoad });
    const input = await startChat(page);
    await input.fill("!sleep 12; echo b1-late");
    const enteredAt = Date.now();
    gate.begin();
    await input.press("Enter");
    await expect.poll(() => gate.wasHeld(), { timeout: 120_000 }).toBe(true);
    await waitUntilElapsed(enteredAt, 2_500);
    await page.reload();
    await expect(composer(page)).toHaveValue("!sleep 12; echo b1-late", { timeout: 120_000 });
    await expect(transcript(page).getByText("b1-late", { exact: true })).toHaveCount(0);
    await waitForLocalDraft(realApp, page, "!sleep 12; echo b1-late", "folder");
    const state = await readDraftState(realApp, page);
    expect(
      state.buffers.some(
        (entry) => entry.text === "!sleep 12; echo b1-late" && entry.key.includes(":draft:thread:"),
      ),
    ).toBe(false);
    expect(
      state.files.some(
        (entry) => entry.directory === "threads" && entry.text === "!sleep 12; echo b1-late",
      ),
    ).toBe(false);
    expect(realApp.problems).toEqual([]);
  },
);

for (const delayMs of [0, 300, 1_000]) {
  realTest(
    `saves a message sent immediately before reload after ${delayMs}ms`,
    async ({ realApp }) => {
      const page = await realApp.open();
      const input = await startChat(page);
      await expect(page.getByText("No messages yet.")).toBeVisible({ timeout: 30_000 });
      await input.fill("sent then reloaded");
      await input.press("Enter");
      await reloadAfterDelay(page, delayMs);
      await expect(transcript(page).getByText("sent then reloaded", { exact: true })).toHaveCount(
        1,
        {
          timeout: 120_000,
        },
      );
      await expectComposerValue(realApp, page, "");
      expect(realApp.problems).toEqual([]);
    },
  );
}
realTest(
  "refreshes the session row after a first send finishes without a reload",
  async ({ realApp }) => {
    const page = await realApp.open();
    const input = await startChat(page);
    await sendPrompt(input, "watched-row-marker");
    await expect(transcript(page).getByText("pong", { exact: true })).toHaveCount(1, {
      timeout: 120_000,
    });
    await expect(
      page.getByRole("listbox", { name: "Session list" }).getByRole("option").filter({
        hasText: "watched-row-marker",
      }),
    ).toHaveCount(1, { timeout: 120_000 });
    expect(realApp.problems).toEqual([]);
  },
);

realTest("clears the local sent draft before a delayed server clear", async ({ realApp }) => {
  let holdClear = false;
  let clearSeen = false;
  let heldClear: { readonly server: WebSocketRoute; readonly message: string | Buffer } | undefined;
  const releaseClear = (): void => {
    holdClear = false;
    heldClear?.server.send(heldClear.message);
    heldClear = undefined;
  };
  const page = await realApp.open({
    beforeLoad: async (openedPage) => {
      await openedPage.routeWebSocket(
        () => true,
        (webSocket) => {
          const server = webSocket.connectToServer();
          webSocket.onMessage((message) => {
            const frame = parseFrame(message);
            if (
              holdClear &&
              frame.type === "call" &&
              frame.port === "A1.draftStore" &&
              frame.method === "clear"
            ) {
              clearSeen = true;
              heldClear = { server, message };
              return;
            }
            server.send(message);
          });
          server.onMessage((message) => webSocket.send(message));
        },
      );
    },
  });
  const input = await startChat(page);
  await input.fill("sent draft clear race");
  holdClear = true;
  await input.press("Enter");
  await expect.poll(() => clearSeen, { timeout: 120_000 }).toBe(true);
  await expect
    .poll(
      () =>
        page.evaluate(
          (text) =>
            !Object.entries(localStorage).some(
              ([key, value]) => key.includes(":draft:") && value.includes(text),
            ),
          "sent draft clear race",
        ),
      { timeout: 120_000 },
    )
    .toBe(true);
  releaseClear();
  expect(realApp.problems).toEqual([]);
});

realTest(
  "keeps text typed in a chat whose first line was a bash command out of the next New chat",
  async ({ realApp }) => {
    const page = await realApp.open();
    const first = await startChat(page);
    await first.fill("!echo separate-marker");
    await first.press("Enter");
    await expect(
      transcript(page).getByText("separate-marker", { exact: true }).first(),
    ).toBeVisible({ timeout: 120_000 });
    // The chat has a message now (a bash one), so what is typed next is this chat's own draft, not the folder's.
    await first.fill("draft in the bash chat");
    await waitForLocalDraft(realApp, page, "draft in the bash chat", "thread");
    await startChat(page);
    await expectComposerValue(realApp, page, "");
    expect(realApp.problems).toEqual([]);
  },
);

realTest("keeps a fresh-chat draft through a delayed reload", async ({ realApp }) => {
  const page = await realApp.open();
  await typeSlowDraftInto(page, await startChat(page));
  await waitForLocalDraft(realApp, page, LONG_DRAFT, "folder");
  await restoreAfterReload(page, LONG_DRAFT);
  expect(realApp.problems).toEqual([]);
});

realTest("keeps a fresh-chat draft after closing and reopening the page", async ({ realApp }) => {
  const page = await realApp.open();
  await typeLongDraft(page);
  const profile = page.context();
  await page.close({ runBeforeUnload: false });
  // The same profile (browser context): a closed tab and a new page of the same browser share localStorage.
  // The composer wait below allows two minutes; the app root check of `open` allows five seconds, too short on a busy host.
  const reopened = await realApp.open({ context: profile, expectApp: false });
  await expect(await composerAfterReopen(reopened)).toHaveValue(LONG_DRAFT, { timeout: 120_000 });
  expect(realApp.problems).toEqual([]);
});

realTest("keeps an existing-chat draft through an immediate reload", async ({ realApp }) => {
  const page = await realApp.open();
  const input = await startChat(page);
  await sendPrompt(input, "seed existing immediate");
  await expect(transcript(page).getByText("pong", { exact: true })).toHaveCount(1, {
    timeout: 120_000,
  });
  await typeLongDraftInto(page, input);
  await waitForLocalDraft(realApp, page, LONG_DRAFT, "thread");
  await page.reload();
  await expectComposerValue(realApp, page, LONG_DRAFT);
  expect(realApp.problems).toEqual([]);
});

realTest("keeps an existing-chat draft through a delayed reload", async ({ realApp }) => {
  const page = await realApp.open();
  const input = await startChat(page);
  await sendPrompt(input, "seed existing delayed");
  await expect(transcript(page).getByText("pong", { exact: true })).toHaveCount(1, {
    timeout: 120_000,
  });
  await typeLongDraftInto(page, input);
  await waitForLocalDraft(realApp, page, LONG_DRAFT, "thread");
  await page.reload();
  await expectComposerValue(realApp, page, LONG_DRAFT);
  expect(realApp.problems).toEqual([]);
});

realTest(
  "keeps an existing-chat draft after closing and reopening the page",
  async ({ realApp }) => {
    const page = await realApp.open();
    const input = await startChat(page);
    await sendPrompt(input, "seed existing closed");
    await expect(transcript(page).getByText("pong", { exact: true })).toHaveCount(1, {
      timeout: 120_000,
    });
    await typeLongDraftInto(page, input);
    // The reopen restores the chat's own draft, so wait until that draft holds the text before the page closes. Typing
    // in the moments after the answer keeps the text in the New chat's draft until the send's call settles and the
    // chat's draft moves to it (see `ChatDraft.observe`), so closing at once could reopen with the text in the wrong draft.
    await waitForLocalDraft(realApp, page, LONG_DRAFT, "thread");
    const profile = page.context();
    await page.close({ runBeforeUnload: false });
    const reopened = await realApp.open({ context: profile, expectApp: false });
    await composerAfterReopen(reopened, /seed existing closed/);
    await expectComposerValue(realApp, reopened, LONG_DRAFT);
    expect(realApp.problems).toEqual([]);
  },
);
realTest(
  "reopens the saved chat after reload and keeps the new-chat draft separate",
  async ({ realApp }) => {
    const page = await realApp.open();
    const saved = await startChat(page);
    await sendPrompt(saved, "saved chat X");
    await expect(transcript(page).getByText("pong", { exact: true })).toHaveCount(1, {
      timeout: 120_000,
    });
    const fresh = await startChat(page);
    await fresh.fill("draft for New chat");
    const savedRow = page
      .getByRole("listbox", { name: "Session list" })
      .getByRole("option", { name: /saved chat X/ });
    await expect(savedRow).toBeVisible({ timeout: 120_000 });
    await savedRow.click();
    await expect(transcript(page).getByText("saved chat X", { exact: true })).toHaveCount(1, {
      timeout: 120_000,
    });
    await expectComposerValue(realApp, page, "");
    await page.reload();
    await expect(transcript(page).getByText("saved chat X", { exact: true })).toHaveCount(1, {
      timeout: 120_000,
    });
    await expectComposerValue(realApp, page, "");
    await startChat(page);
    await expectComposerValue(realApp, page, "draft for New chat");
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "keeps offline typing through reload and catches up after reconnect",
  async ({ realApp }) => {
    const page = await realApp.open();
    const input = await startChat(page);
    await page.context().setOffline(true);
    await input.focus();
    await page.keyboard.type(LONG_DRAFT, { delay: 40 });
    await expect(input).toHaveValue(LONG_DRAFT);
    await page.reload().catch(() => undefined);
    await page.context().setOffline(false);
    await page.reload();
    await expect(composer(page)).toHaveValue(LONG_DRAFT, { timeout: 120_000 });
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "keeps a draft while the app server restarts and saves it afterward",
  async ({ realApp }) => {
    // What an intentional restart makes the page log: its connection is refused while the server is down, a read in
    // flight fails with "Connection to the app server closed", and letting go of the chat on the old link fails
    // because that launch link has expired. Anything else the page logs still fails the test at its end.
    realApp.allowProblem(/WebSocket connection to .* failed/);
    realApp.allowProblem(/WebSocket.*closed/i);
    realApp.allowProblem(/Connection to the app server closed/);
    realApp.allowProblem(/Launch link has expired/);
    const page = await realApp.open();
    await typeLongDraft(page);
    const launch = await realApp.restartServer();
    await page.goto(launch);
    await expect(composer(page)).toHaveValue(LONG_DRAFT, { timeout: 120_000 });
  },
);

realTest(
  "keeps a failed offline send and delivers it once after reconnect",
  async ({ realApp }) => {
    let refuseNextPrompt = true;
    const page = await realApp.open({
      beforeLoad: async (openedPage) => {
        await openedPage.routeWebSocket(
          () => true,
          (webSocket) => {
            const server = webSocket.connectToServer();
            webSocket.onMessage((message) => {
              const frame = parseFrame(message);
              const method = (frame.args as { method?: unknown } | undefined)?.method;
              if (
                refuseNextPrompt &&
                frame.type === "call" &&
                frame.port === "A0.chatSession" &&
                frame.method === "request" &&
                method === "prompt"
              ) {
                refuseNextPrompt = false;
                void webSocket.send(
                  JSON.stringify({
                    type: "result",
                    id: frame.id,
                    ok: false,
                    error: {
                      code: "unavailable",
                      message: "The prompt was refused before omp took it.",
                      retryable: true,
                    },
                  }),
                );
                return;
              }
              server.send(message);
            });
            server.onMessage((message) => webSocket.send(message));
          },
        );
      },
    });
    const input = await startChat(page);
    await input.fill("offline send must survive");
    await waitForLocalDraft(realApp, page, "offline send must survive", "folder");
    await input.press("Enter");
    await expect(page.locator('[data-composer-error="true"]')).toBeVisible({ timeout: 120_000 });
    await expectComposerValue(realApp, page, "offline send must survive");
    await page.reload();
    const restored = composer(page);
    await expectComposerValue(realApp, page, "offline send must survive");
    await restored.press("Enter");
    await expect(
      transcript(page).getByText("offline send must survive", { exact: true }),
    ).toHaveCount(1, {
      timeout: 120_000,
    });
    await expect(transcript(page).getByText("pong", { exact: true })).toHaveCount(1, {
      timeout: 120_000,
    });
    await page.reload();
    await expect(
      transcript(page).getByText("offline send must survive", { exact: true }),
    ).toHaveCount(1, {
      timeout: 120_000,
    });
    await expectComposerValue(realApp, page, "");
  },
);

realTest(
  "keeps a message delivered before going offline in exactly one chat",
  async ({ realApp }) => {
    const page = await realApp.open();
    const input = await startChat(page);
    await input.fill("offline delivered once");
    await input.press("Enter");
    await expect(transcript(page).getByText("offline delivered once", { exact: true })).toHaveCount(
      1,
      {
        timeout: 120_000,
      },
    );
    // The pending row shows before omp admits the send, so the transcript does not yet say the send went out. The draft
    // is cleared at admission (drafts.ts admitAndClear), and that clear must be saved before the page goes offline.
    await waitForLocalDraftCleared(realApp, page, "offline delivered once");
    await page.context().setOffline(true);
    await page.reload().catch(() => undefined);
    await page.context().setOffline(false);
    await page.reload();
    await expect(transcript(page).getByText("offline delivered once", { exact: true })).toHaveCount(
      1,
      {
        timeout: 120_000,
      },
    );
    await expectComposerValue(realApp, page, "");
    await expect(
      page.getByRole("listbox", { name: "Session list" }).getByRole("option").filter({
        hasText: "offline delivered once",
      }),
    ).toHaveCount(1, { timeout: 120_000 });
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "keeps separate chat drafts and restores a 20,000-character pasted draft",
  async ({ realApp }) => {
    const page = await realApp.open();
    const first = await startChat(page);
    await sendPrompt(first, "first saved chat");
    await expect(transcript(page).getByText("pong", { exact: true })).toHaveCount(1, {
      timeout: 120_000,
    });

    const second = await startChat(page);
    await second.fill("second chat draft");
    await expect(composer(page)).toHaveValue("second chat draft", { timeout: 120_000 });
    await page
      .getByRole("listbox", { name: "Session list" })
      .getByRole("option", { name: /first saved chat/ })
      .click();
    await expectComposerValue(realApp, page, "");

    const latest = await startChat(page);
    // The earlier fresh-chat draft is restored into the new fresh chat once its load finishes. Text typed before that
    // is kept after it (both are kept by design), so wait for it before the composer is cleared and typed into.
    await expect(latest).toHaveValue("second chat draft", { timeout: 120_000 });
    await latest.fill("");
    await latest.focus();
    await latest.press("Control+a");
    await latest.press("Backspace");
    await expect(latest).toHaveValue("");
    await paste(latest, LARGE_PASTE);
    // Playwright's synthetic clipboard event does not perform Chromium's default insertion; fill the exact pasted
    // payload after the event so this case focuses on durable storage, not the separate paste-menu interaction.
    await latest.fill(LARGE_PASTE);
    await expectComposerValue(realApp, page, LARGE_PASTE);
    await page.reload();
    await expectComposerValue(realApp, page, LARGE_PASTE);
  },
);
