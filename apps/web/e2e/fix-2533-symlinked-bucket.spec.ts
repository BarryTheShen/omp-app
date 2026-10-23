import { mkdir, readdir, rename, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, realTest } from "./real-omp";

/**
 * #2533: a chat whose folder's session bucket is a symlink to a directory outside the sessions root. The folder's listing
 * shows the chat, and opening it must work. The bucket is set up as the issue sets it up: the seeded chat moves outside the
 * sessions root, and a symlink takes its place.
 */

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const at = Date.UTC(2026, 9, 22, 12, 0, 0);

const entries = [
  {
    type: "message",
    message: {
      role: "user",
      content: [{ type: "text", text: "Question in the linked folder" }],
      timestamp: at,
    },
  },
  {
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Answer from the linked folder." }],
      api: "openai-completions",
      provider: "fake",
      model: "fake-model",
      usage,
      stopReason: "stop",
      timestamp: at + 60_000,
    },
  },
];

realTest.describe("a chat whose folder's session bucket is a symlink", () => {
  realTest.use({ seedEntries: { entries } });

  realTest("opens from the list", async ({ realApp }, testInfo) => {
    testInfo.setTimeout(240_000);
    const sessions = join(realApp.agentDir, "sessions");
    const [bucket] = await readdir(sessions);
    if (bucket === undefined) throw new Error("the seeded chat has no session bucket");
    const elsewhere = join(realApp.agentDir, "..", "elsewhere", bucket);
    await mkdir(dirname(elsewhere), { recursive: true });
    await rename(join(sessions, bucket), elsewhere);
    await symlink(elsewhere, join(sessions, bucket));
    const page = await realApp.open();
    await page.getByRole("listbox", { name: "Session list" }).getByRole("option").first().click();
    await expect(page.getByText("Answer from the linked folder.")).toBeVisible({ timeout: 60_000 });
  });
});
