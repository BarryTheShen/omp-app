/// <reference types="node" />
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Page } from "@playwright/test";
import { expect, realTest } from "./real-omp";

const PROBE = readFileSync(resolve(process.cwd(), "e2e/overlay-recorder.js"), "utf8");
const BACKDROP = '[data-slot="dialog-overlay"]';
const MAX_RENDERED_FIBERS = 200;

type CensusCommit = { readonly n: number };
type Surface = {
  readonly name: string;
  readonly open: (page: Page) => Promise<void>;
  readonly ready: (page: Page) => Promise<void>;
  readonly close: (page: Page) => Promise<void>;
};

function seededEntries(count: number): Array<Record<string, unknown>> {
  const entries: Array<Record<string, unknown>> = [];
  for (let index = 0; index < count; index += 1) {
    const timestamp = Date.UTC(2026, 9, 3) + index * 1000;
    entries.push({
      type: "message",
      message: {
        role: index % 2 === 0 ? "user" : "assistant",
        content: [{ type: "text", text: `Census message ${index + 1}` }],
        ...(index % 2 === 1
          ? { api: "openai-completions", provider: "fake", model: "fake-model", stopReason: "stop" }
          : {}),
        timestamp,
      },
    });
  }
  return entries;
}

async function closeByBackdrop(page: Page): Promise<void> {
  await page.mouse.click(2, 2);
  await page.waitForFunction((selector) => document.querySelector(selector) === null, BACKDROP, {
    timeout: 20_000,
  });
}

const surfaces: readonly Surface[] = [
  {
    name: "settings",
    open: async (page) =>
      page.getByRole("button", { name: "Settings", exact: true }).first().click(),
    ready: async (page) => expect(page.getByTestId("settings-screen")).toBeVisible(),
    close: closeByBackdrop,
  },
  {
    name: "palette",
    open: async (page) => {
      await page.getByRole("textbox", { name: "Message input" }).focus();
      await page.keyboard.press("Control+k");
    },
    ready: async (page) =>
      expect(page.locator('[role="dialog"][aria-label="Command palette"]')).toBeVisible(),
    close: async (page) => {
      await page.keyboard.press("Escape");
      await page.waitForFunction(
        (selector) => document.querySelector(selector) === null,
        BACKDROP,
        {
          timeout: 20_000,
        },
      );
    },
  },
  {
    name: "model",
    open: async (page) => page.getByRole("button", { name: /^(Choose a model|Model:)/ }).click(),
    ready: async (page) =>
      expect(page.getByRole("dialog", { name: "Model and thinking" })).toBeVisible(),
    close: closeByBackdrop,
  },
];

async function openSeededChat(realApp: {
  open: (options?: { beforeLoad?: (page: Page) => Promise<unknown> }) => Promise<Page>;
}): Promise<Page> {
  const page = await realApp.open({
    beforeLoad: async (target) => {
      await target.addInitScript({
        content: `window.__omCensus = true;\n${PROBE}\nwindow.__om.census.on = true;`,
      });
    },
  });
  const rows = page.locator('[data-slot="u1-message-row"]');
  if ((await rows.count()) === 0) {
    await page.getByRole("listbox", { name: "Session list" }).getByRole("option").first().click();
  }
  await expect(rows.first()).toBeVisible({ timeout: 45_000 });
  await expect(page.getByRole("textbox", { name: "Message input" })).toBeVisible({
    timeout: 45_000,
  });
  await expect(page.getByRole("button", { name: /^(Choose a model|Model:)/ })).toBeVisible({
    timeout: 45_000,
  });
  // The open's late commits (capabilities, status, the model list) must not land in the first measurement: wait until no
  // React commit has happened for one second.
  const commitCount = () =>
    page.evaluate(() => {
      const om: unknown = Reflect.get(window, "__om");
      const census = typeof om === "object" && om !== null && "census" in om ? om.census : null;
      const commits =
        typeof census === "object" && census !== null && "commits" in census
          ? census.commits
          : null;
      if (!Array.isArray(commits)) throw new Error("the census probe is not installed");
      return commits.length;
    });
  await expect
    .poll(
      async () => {
        const before = await commitCount();
        await page.waitForTimeout(1000);
        return (await commitCount()) === before;
      },
      { timeout: 45_000, intervals: [0] },
    )
    .toBe(true);
  return page;
}

async function measure(
  page: Page,
  surface: Surface,
  action: "open" | "close",
  run: () => Promise<void>,
): Promise<readonly number[]> {
  await page.evaluate(() => {
    const om = (window as unknown as { __om: { census: { commits: CensusCommit[] } } }).__om;
    om.census.commits.length = 0;
  });
  await run();
  if (action === "open") await surface.ready(page);
  await page.waitForTimeout(300);
  const commits = await page.evaluate(() =>
    (
      window as unknown as { __om: { census: { commits: CensusCommit[] } } }
    ).__om.census.commits.map((commit) => commit.n),
  );
  expect(commits.length, `${surface.name} ${action} census commits`).toBeGreaterThan(0);
  const max = Math.max(...commits);
  console.log(
    `OVERLAY CENSUS size=500 surface=${surface.name} action=${action} count=${commits.length} max=${max} totals=${JSON.stringify(commits)}`,
  );
  return commits;
}

realTest.use({
  seedEntries: { entries: seededEntries(500) },
});
realTest.setTimeout(1_200_000);
realTest(
  "keeps every overlay open/close commit below 200 fibers at 500 messages",
  async ({ realApp }) => {
    const page = await openSeededChat(realApp);
    for (const surface of surfaces) {
      const opened = await measure(page, surface, "open", () => surface.open(page));
      const closed = await measure(page, surface, "close", () => surface.close(page));
      expect(
        Math.max(...opened),
        `${surface.name} open max fibers per overlay commit at 500 messages`,
      ).toBeLessThanOrEqual(MAX_RENDERED_FIBERS);
      expect(
        Math.max(...closed),
        `${surface.name} close max fibers per overlay commit at 500 messages`,
      ).toBeLessThanOrEqual(MAX_RENDERED_FIBERS);
    }
  },
);
