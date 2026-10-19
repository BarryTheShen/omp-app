import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Page } from "@playwright/test";
import { sessionBucketName } from "../../../packages/server/src/modules/A1/sessions/paths";
import { expect, realTest, sendPrompt, startChat } from "./real-omp";

const PREVIOUS = "previous session message 2057";
const FRESH = "fresh new chat message 2057";

async function sessionFiles(bucket: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const name of (await readdir(bucket)).filter((entry) => entry.endsWith(".jsonl"))) {
    files.set(name, await readFile(join(bucket, name), "utf8"));
  }
  return files;
}
async function exerciseNewChat(
  realApp: { readonly agentDir: string; readonly folder: string },
  page: Page,
): Promise<void> {
  const composer = await startChat(page);
  await sendPrompt(composer, PREVIOUS);
  await expect(page.getByText("Conversation settled", { exact: true })).toBeVisible({
    timeout: 120_000,
  });

  const bucket = join(
    realApp.agentDir,
    "sessions",
    sessionBucketName(realApp.folder, { home: join(dirname(realApp.agentDir), "home") }),
  );
  const before = await sessionFiles(bucket);
  expect(before.size).toBe(1);
  const [previousName, previousText] = [...before.entries()][0] ?? [];
  if (previousName === undefined || previousText === undefined)
    throw new Error("previous session file was not created");

  await page
    .locator('[aria-label="Sessions"]')
    .getByRole("button", { name: "New chat" })
    .first()
    .click();
  await expect(page.getByText("No messages yet.", { exact: true })).toBeVisible({
    timeout: 60_000,
  });
  expect((await sessionFiles(bucket)).get(previousName)).toBe(previousText);

  await sendPrompt(page.getByRole("textbox", { name: "Message input" }), FRESH);
  await expect(
    page.getByRole("region", { name: "Conversation transcript" }).getByText(FRESH, { exact: true }),
  ).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("Conversation settled", { exact: true })).toBeVisible({
    timeout: 120_000,
  });

  const after = await sessionFiles(bucket);
  expect(after.get(previousName)).toBe(previousText);
  expect([...after.keys()].filter((name) => name !== previousName)).toHaveLength(1);
}

realTest.setTimeout(420_000);

for (const autoResume of [true, false] as const) {
  realTest(
    `New chat is fresh and preserves the previous session with autoResume ${autoResume}`,
    async ({ realApp }) => {
      await writeFile(join(realApp.agentDir, "config.yml"), `autoResume: ${autoResume}\n`, "utf8");
      const page = await realApp.open();
      await exerciseNewChat(realApp, page);
      expect(realApp.problems).toEqual([]);
    },
  );
}
