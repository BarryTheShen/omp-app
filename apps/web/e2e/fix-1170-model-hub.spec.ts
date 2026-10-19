import { mkdir, readFile, writeFile } from "node:fs/promises";
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

/**
 * Issues #1170 and #1150. The header's model button opens the model dialog: Recent first, the providers,
 * and the Roles view with the roles, the cycle order and the saved presets. On real omp these tests check
 * that each change reaches omp's own config.yml, which omp reads its roles, cycle and presets from.
 */

const FAKE_HAIKU = /fake\/claude-3-haiku-20240307 ·/;
const FAKE_SONNET = /fake\/claude-3-5-sonnet-20240620 ·/;
const FAKE_FABLE = /fake\/claude-fable-5 ·/;

/** Starts a chat, waits for omp's first answer, and opens the chat's model dialog from the header button. */
async function openModelDialog(page: Page): Promise<Locator> {
  const composer = await startChat(page);
  await sendPrompt(composer, "ping");
  await expect(page.getByText("pong", { exact: true })).toBeVisible({ timeout: 60_000 });
  // A CSS locator: while the dialog is open the header is hidden from role queries.
  await page.locator('[data-layout-area="composerToolbar"] button[aria-label^="Model:"]').click();
  const dialog = page.getByRole("dialog", { name: "Model and thinking" });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Closes the dialog and opens it again from the header, as a person would. */
async function reopenModelDialog(page: Page, dialog: Locator): Promise<Locator> {
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toHaveCount(0);
  await page.locator('[data-layout-area="composerToolbar"] button[aria-label^="Model:"]').click();
  const reopened = page.getByRole("dialog", { name: "Model and thinking" });
  await expect(reopened).toBeVisible();
  return reopened;
}

/** The header's model button, which names the session's model. */
function headerModel(page: Page): Locator {
  return page.locator('[data-layout-area="composerToolbar"] button[aria-label^="Model:"]');
}

/** omp's config.yml in this run's agent folder. */
function configPath(realApp: { readonly agentDir: string }): string {
  return join(realApp.agentDir, "config.yml");
}

type ConfigWriteHold = {
  readonly recentWriteSent: Promise<void>;
  readonly release: () => void;
  readonly install: (page: Page) => Promise<void>;
};

/** Holds every ConfigStore write until the test releases it, so the race cannot depend on wall-clock timing. */
function holdConfigWrites(): ConfigWriteHold {
  let notifyRecentWrite!: () => void;
  let released = false;
  const held: Array<() => void> = [];
  const recentWriteSent = new Promise<void>((resolve) => {
    notifyRecentWrite = resolve;
  });
  return {
    recentWriteSent,
    release: () => {
      released = true;
      for (const send of held.splice(0)) send();
    },
    install: async (page) => {
      await page.routeWebSocket(/\/ws/, (socket) => {
        const server = socket.connectToServer();
        socket.onMessage((message) => {
          const frame = JSON.parse(String(message)) as {
            readonly args?: { readonly key?: unknown };
            readonly method?: unknown;
            readonly port?: unknown;
            readonly type?: unknown;
          };
          if (
            frame.type === "call" &&
            frame.port === "A1.configStore" &&
            frame.method === "write"
          ) {
            if (frame.args?.key === "app.recentModels") notifyRecentWrite();
            if (released) server.send(message);
            else held.push(() => server.send(message));
            return;
          }
          server.send(message);
        });
        server.onMessage((message) => socket.send(message));
      });
    },
  };
}
type RecentWriteFailure = {
  readonly install: (page: Page) => Promise<void>;
};

function failNextRecentWrite(message: string): RecentWriteFailure {
  let failed = false;
  return {
    install: async (page) => {
      await page.routeWebSocket(/\/ws/, (socket) => {
        const server = socket.connectToServer();
        let failedCallId: string | undefined;
        socket.onMessage((frame) => {
          const parsed = JSON.parse(String(frame)) as {
            readonly args?: { readonly key?: unknown };
            readonly id?: string;
            readonly method?: unknown;
            readonly port?: unknown;
            readonly type?: unknown;
          };
          if (
            !failed &&
            parsed.type === "call" &&
            parsed.port === "A1.configStore" &&
            parsed.method === "write" &&
            parsed.args?.key === "app.recentModels"
          ) {
            failed = true;
            failedCallId = parsed.id;
          }
          server.send(frame);
        });
        server.onMessage((frame) => {
          if (failedCallId !== undefined) {
            const parsed = JSON.parse(String(frame)) as {
              readonly id?: string;
              readonly type?: unknown;
            };
            if (parsed.type === "result" && parsed.id === failedCallId) {
              socket.send(
                JSON.stringify({
                  type: "result",
                  id: failedCallId,
                  ok: false,
                  error: { code: "internal", message, retryable: true },
                }),
              );
              failedCallId = undefined;
              return;
            }
          }
          socket.send(frame);
        });
      });
    },
  };
}

/** The dialog's own background and type came from the app's stylesheet, not the browser's defaults. */
async function expectStyled(dialog: Locator): Promise<void> {
  const style = await dialog.evaluate((element) => {
    const computed = getComputedStyle(element);
    return { background: computed.backgroundColor, font: computed.fontFamily };
  });
  expect(style.background).not.toBe("rgba(0, 0, 0, 0)");
  expect(style.font).not.toMatch(/Times/);
}

/** The Roles view, opened from the dialog's sidebar. */
async function openRoles(dialog: Locator): Promise<void> {
  await dialog.getByRole("button", { name: /^Roles/ }).click();
  await expect(dialog.getByRole("region", { name: "Chat roles" })).toBeVisible();
}

realTest(
  "the model dialog lists Recent and the providers, and a role set from it is written to omp's config",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 900 });
    const dialog = await openModelDialog(page);

    // The session's model is in Recent; the other models are grouped by provider, and searchable.
    await expect(dialog.getByRole("region", { name: "Recent models" })).toBeVisible();
    await expect(dialog.getByRole("region", { name: "fake models" })).toBeVisible();
    await expect(dialog.getByRole("textbox", { name: "Search models" })).toBeVisible();
    await expectStyled(dialog);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1170-models-light.png") });

    // The Roles view: each role with the model it has; an unset role says omp picks one.
    await openRoles(dialog);
    await expect(dialog.getByRole("button", { name: "Choose a model for Fast" })).toBeVisible();
    await expect(
      dialog.getByText("Not set. omp picks a model for this role.").first(),
    ).toBeVisible();
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1170-roles-light.png") });

    // Choosing a model for the Fast role writes it to omp's config and returns to the Roles view.
    await dialog.getByRole("button", { name: "Choose a model for Fast" }).click();
    await expect(dialog.getByText("Choose a model for Fast.")).toBeVisible();
    await dialog.getByRole("button", { name: FAKE_HAIKU }).click();
    await expect(dialog.getByText("Fast now uses Claude Haiku 3.")).toBeVisible({
      timeout: 30_000,
    });
    await expect(dialog.getByRole("button", { name: "Clear Fast" })).toBeVisible();
    await expect(
      dialog.getByText("Claude Haiku 3 · fake/claude-3-haiku-20240307", { exact: true }),
    ).toBeVisible();
    expect(await readFile(configPath(realApp), "utf8")).toMatch(
      /^\s+smol: ["']?fake\/claude-3-haiku-20240307["']?$/m,
    );

    // The same view in dark, then at 390 px, with no sideways scrolling.
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await expect(page.locator("html")).toHaveClass(/dark/);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1170-roles-dark.png") });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));
    await page.setViewportSize({ width: 390, height: 844 });
    await waitForFiniteAnimations(page);
    await expect(dialog.getByRole("button", { name: "Clear Fast" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
    await page.screenshot({ path: join(screenshots, "fix-1170-roles-narrow.png") });
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "a model set as the Thinking role from the model list is written to omp's config",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 900 });
    const dialog = await openModelDialog(page);

    const fakeModels = dialog.getByRole("region", { name: "fake models" });
    await fakeModels.getByRole("button", { name: "Set Claude Sonnet 3.5 as a role" }).click();
    await expect(dialog.getByText("Choose a role for Claude Sonnet 3.5.")).toBeVisible();
    await dialog
      .getByRole("region", { name: "Chat roles" })
      .getByRole("button", { name: /^Thinking/ })
      .click();
    await expect(dialog.getByText("Thinking now uses Claude Sonnet 3.5.")).toBeVisible({
      timeout: 30_000,
    });
    expect(await readFile(configPath(realApp), "utf8")).toMatch(
      /^\s+slow: ["']?fake\/claude-3-5-sonnet-20240620["']?$/m,
    );
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "a model picked for this session stays under Recent after the dialog is opened again, and the app keeps the list",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 900 });
    const dialog = await openModelDialog(page);

    await dialog.getByRole("button", { name: FAKE_HAIKU }).click();
    await expect(dialog.getByText("Active: fake/claude-3-haiku-20240307")).toBeVisible({
      timeout: 20_000,
    });
    // A second model replaces the first as the session's model, so the first is no longer the current one.
    await dialog.getByRole("button", { name: FAKE_FABLE }).click();
    await expect(dialog.getByText("Active: fake/claude-fable-5")).toBeVisible({ timeout: 20_000 });
    await expect(headerModel(page)).toHaveAttribute(
      "aria-label",
      "Model: Claude Fable 5. Change model or thinking",
      { timeout: 20_000 },
    );
    const reopened = await reopenModelDialog(page, dialog);
    await expect(reopened.getByRole("alert")).toHaveCount(0);
    await expect(
      reopened
        .getByRole("region", { name: "Recent models" })
        .getByRole("button", { name: FAKE_HAIKU }),
    ).toBeVisible();
    expect(await readFile(join(realApp.appDataDir, "config.yml"), "utf8")).toContain(
      "fake/claude-3-haiku-20240307",
    );
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "a recent model stays visible when its config write is delayed through a dialog reopen",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const heldWrites = holdConfigWrites();
    const page = await realApp.open({ beforeLoad: heldWrites.install });
    await page.setViewportSize({ width: 1280, height: 900 });
    const dialog = await openModelDialog(page);

    await dialog.getByRole("button", { name: FAKE_HAIKU }).click();
    await expect(dialog.getByText("Active: fake/claude-3-haiku-20240307")).toBeVisible({
      timeout: 20_000,
    });
    await heldWrites.recentWriteSent;
    await dialog.getByRole("button", { name: FAKE_FABLE }).click();
    await expect(dialog.getByText("Active: fake/claude-fable-5")).toBeVisible({
      timeout: 20_000,
    });

    const reopened = await reopenModelDialog(page, dialog);
    const recentModels = reopened.getByRole("region", { name: "Recent models" });
    await expect(recentModels.getByRole("button", { name: FAKE_HAIKU })).toBeVisible();
    heldWrites.release();
    await expect
      .poll(async () => {
        try {
          return await readFile(join(realApp.appDataDir, "config.yml"), "utf8");
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
          throw error;
        }
      })
      .toContain("fake/claude-3-haiku-20240307");
    await expect(recentModels.getByRole("button", { name: FAKE_HAIKU })).toBeVisible();
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "a failed recent-model save keeps the pick and explains the failure in later dialogs",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(180_000);
    const message = "Disk full while saving recent models.";
    const failure = failNextRecentWrite(message);
    const page = await realApp.open({ beforeLoad: failure.install });
    await page.setViewportSize({ width: 1280, height: 900 });
    const dialog = await openModelDialog(page);
    await dialog.getByRole("button", { name: FAKE_HAIKU }).click();
    await expect(dialog.getByText("Active: fake/claude-3-haiku-20240307")).toBeVisible({
      timeout: 20_000,
    });
    await expect(dialog.getByRole("alert")).toContainText(message, { timeout: 20_000 });
    await mkdir(screenshots, { recursive: true });
    await dialog.screenshot({ path: join(screenshots, "fix-1551-recent-save-failed-light.png") });

    const reopened = await reopenModelDialog(page, dialog);
    await expect(reopened.getByRole("alert")).toContainText(message);
    await expect(
      reopened
        .getByRole("region", { name: "Recent models" })
        .getByRole("button", { name: FAKE_HAIKU }),
    ).toBeVisible();
    await page.evaluate(() => document.documentElement.classList.add("dark"));
    await expect(page.locator("html")).toHaveClass(/dark/);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1551-recent-save-failed-dark.png") });
    await page.evaluate(() => document.documentElement.classList.remove("dark"));
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(reopened.getByRole("alert")).toContainText(message);
    await waitForFiniteAnimations(page);
    await page.screenshot({ path: join(screenshots, "fix-1551-recent-save-failed-narrow.png") });
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "the Default role can be set right after a model was picked for the session, and the session takes it",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 900 });
    const dialog = await openModelDialog(page);

    // The pick records a recent model, which moves the revision of omp's config: the role write must still save.
    await dialog.getByRole("button", { name: FAKE_HAIKU }).click();
    await expect(dialog.getByText("Active: fake/claude-3-haiku-20240307")).toBeVisible({
      timeout: 20_000,
    });
    await openRoles(dialog);
    await dialog.getByRole("button", { name: "Choose a model for Default" }).click();
    await dialog.getByRole("button", { name: FAKE_SONNET }).click();
    await expect(dialog.getByText("Default now uses Claude Sonnet 3.5.")).toBeVisible({
      timeout: 30_000,
    });
    await expect(dialog.getByText(/file changed/)).toHaveCount(0);
    expect(await readFile(configPath(realApp), "utf8")).toMatch(
      /^\s+default: ["']?fake\/claude-3-5-sonnet-20240620["']?$/m,
    );
    await expect(headerModel(page)).toHaveAttribute(
      "aria-label",
      "Model: Claude Sonnet 3.5. Change model or thinking",
      { timeout: 20_000 },
    );
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "the cycle order is changed from the Roles view and omp's config keeps the new order",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 900 });
    const dialog = await openModelDialog(page);
    await openRoles(dialog);

    // The default order is Fast, Default, Thinking; moving Fast down cycles Default, Fast, Thinking.
    await dialog.getByRole("button", { name: "Move Fast down" }).click();
    await expect(dialog.getByText("2. Fast")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Move Fast down" })).toBeFocused();
    const saved = await readFile(configPath(realApp), "utf8");
    expect(saved).toMatch(/cycleOrder:\s*\n\s*-\s*default\s*\n\s*-\s*smol\s*\n\s*-\s*slow/);
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "a preset is saved, switched to and deleted, and each change is in omp's config",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 900 });
    const dialog = await openModelDialog(page);
    await openRoles(dialog);

    // Default is Sonnet; the preset "work" keeps it. Then Default moves to Haiku, and switching back restores Sonnet.
    await dialog.getByRole("button", { name: "Choose a model for Default" }).click();
    await dialog.getByRole("button", { name: FAKE_SONNET }).click();
    await expect(dialog.getByText("Default now uses Claude Sonnet 3.5.")).toBeVisible({
      timeout: 30_000,
    });
    await dialog.getByRole("textbox", { name: "Preset name" }).fill("work");
    await dialog.getByRole("button", { name: "Save preset" }).click();
    await expect(dialog.getByText("Saved preset work.")).toBeVisible({ timeout: 30_000 });
    expect(await readFile(configPath(realApp), "utf8")).toMatch(
      /work:\s*\n\s+modelRoles:\s*\n\s+default: ["']?fake\/claude-3-5-sonnet-20240620["']?/,
    );

    await dialog.getByRole("button", { name: "Choose a model for Default" }).click();
    await dialog.getByRole("button", { name: FAKE_HAIKU }).click();
    await expect(dialog.getByText("Default now uses Claude Haiku 3.")).toBeVisible({
      timeout: 30_000,
    });
    await dialog.getByRole("button", { name: "Switch to work" }).click();
    await expect(dialog.getByText("Switched to preset work.")).toBeVisible({ timeout: 30_000 });
    await expect(headerModel(page)).toHaveAttribute(
      "aria-label",
      "Model: Claude Sonnet 3.5. Change model or thinking",
      { timeout: 20_000 },
    );
    expect(await readFile(configPath(realApp), "utf8")).toMatch(
      /^\s+default: ["']?fake\/claude-3-5-sonnet-20240620["']?$/m,
    );

    await dialog.getByRole("button", { name: "Delete work" }).click();
    await expect(dialog.getByText("Deleted preset work.")).toBeVisible({ timeout: 30_000 });
    await expect(dialog.getByRole("button", { name: "Switch to work" })).toHaveCount(0);
    expect(await readFile(configPath(realApp), "utf8")).not.toMatch(/^\s+work:\s*$/m);
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "a preset whose default model is gone is refused, and omp's config is left as it was",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 900 });
    let dialog = await openModelDialog(page);
    await openRoles(dialog);

    await dialog.getByRole("button", { name: "Choose a model for Default" }).click();
    await dialog.getByRole("button", { name: FAKE_SONNET }).click();
    await expect(dialog.getByText("Default now uses Claude Sonnet 3.5.")).toBeVisible({
      timeout: 30_000,
    });
    await dialog.getByRole("textbox", { name: "Preset name" }).fill("ghost");
    await dialog.getByRole("button", { name: "Save preset" }).click();
    await expect(dialog.getByText("Saved preset ghost.")).toBeVisible({ timeout: 30_000 });

    // Default moves on, so Sonnet is only in the preset; then omp's file is edited to name a model that is not there.
    await dialog.getByRole("button", { name: "Choose a model for Default" }).click();
    await dialog.getByRole("button", { name: FAKE_HAIKU }).click();
    await expect(dialog.getByText("Default now uses Claude Haiku 3.")).toBeVisible({
      timeout: 30_000,
    });
    const original = await readFile(configPath(realApp), "utf8");
    const sonnet = "fake/claude-3-5-sonnet-20240620";
    expect(original.split(sonnet)).toHaveLength(2);
    await writeFile(configPath(realApp), original.replace(sonnet, "fake/does-not-exist"));
    const edited = await readFile(configPath(realApp), "utf8");

    dialog = await reopenModelDialog(page, dialog);
    await openRoles(dialog);
    await dialog.getByRole("button", { name: "Switch to ghost" }).click();
    await expect(
      dialog.getByText(
        "Preset ghost was not applied: its default model fake/does-not-exist is not available.",
      ),
    ).toBeVisible({ timeout: 30_000 });
    expect(await readFile(configPath(realApp), "utf8")).toBe(edited);
    await expect(headerModel(page)).toHaveAttribute(
      "aria-label",
      "Model: Claude Haiku 3. Change model or thinking",
    );
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "typed search narrows the list, and a provider without a sign-in label shows none",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 900 });
    const dialog = await openModelDialog(page);

    await dialog.getByRole("textbox", { name: "Search models" }).fill("haiku");
    await expect(dialog.getByRole("button", { name: /Claude Haiku 3/ }).first()).toBeVisible();
    await expect(dialog.getByRole("button", { name: /Fake Vision/ })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: /Claude Sonnet 3\.5/ })).toHaveCount(0);

    await dialog.getByRole("textbox", { name: "Search models" }).fill("no such model here");
    await expect(dialog.getByText("No models match this search.")).toBeVisible();

    await dialog.getByRole("textbox", { name: "Search models" }).fill("");
    const fake = dialog.getByRole("region", { name: "fake models" });
    await expect(
      fake.getByText(/Uses an API key|Signed in with your login|Not signed in/),
    ).toHaveCount(0);
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "the keyboard path: Tab leaves the model list, and Enter on Choose model moves focus to the search box",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const page = await realApp.open();
    await page.setViewportSize({ width: 1280, height: 900 });
    const dialog = await openModelDialog(page);

    const search = dialog.getByRole("textbox", { name: "Search models" });
    // The search box is disabled while the catalog loads; focus it once the first rows are there.
    await expect(search).toBeEnabled();
    await expect(dialog.getByRole("region", { name: "Recent models" })).toBeVisible();
    await search.focus();
    await page.keyboard.press("Tab");
    expect(
      await page.evaluate(() => (document.activeElement as HTMLElement).dataset.focusKey ?? ""),
    ).toMatch(/^model-row:/);
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Set as role");
    await page.keyboard.press("Tab");
    expect(
      await page.evaluate(() =>
        document.querySelector('[data-testid="model-list"]')?.contains(document.activeElement),
      ),
    ).toBe(false);

    await openRoles(dialog);
    const choose = dialog.getByRole("button", { name: "Choose a model for Fast" });
    await choose.focus();
    await page.keyboard.press("Enter");
    await expect(search).toBeFocused();
    expect(realApp.problems).toEqual([]);
  },
);
