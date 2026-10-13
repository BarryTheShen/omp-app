import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { expect, realTest, sendPrompt, startChat } from "./real-omp";

/*
 * Issue 1370. Opening a long finished worker read its whole transcript in one reply, with no size limit. A reply now
 * carries at most one page of 4 MiB, and the web asks for the next page until it has the rest. This spec restarts the
 * app so the finished worker is read from disk (omp no longer knows it), makes the worker's file longer than a page,
 * and checks what arrives over the socket: no reply is larger than a page, the transcript comes in more than one reply,
 * and the messages after the long part are on screen. On origin/main one reply carries the whole file.
 */

const PAGE_BYTES = 4 * 1024 * 1024;
/** A reply is its page's entries inside a JSON envelope, so it may be a little larger than the page's bytes. */
const REPLY_SLACK_BYTES = 64 * 1024;
/** Filler records the transcript does not show: about 9 MiB, so the worker's file takes three pages. */
const FILLER_LINES = 2_300;
const FILLER_TEXT = "x".repeat(4_000);
const TRANSCRIPT = '[data-slot="p1-agent-transcript"]';
/** The worker's task, which omp writes after the header: it is on screen only once the page that holds it is read. */
const TASK_TEXT = "nested_probe_child";
const COULD_NOT_READ = "The transcript could not be read";

/** The path under `folder` of the one file named `name`, found by walking the folder. */
async function findFile(folder: string, name: string): Promise<string> {
  const found = (await readdir(folder, { recursive: true })).find(
    (entry) => basename(entry) === name,
  );
  if (found === undefined) throw new Error(`no ${name} under ${folder}`);
  return join(folder, found);
}

/** Puts filler records right after the file's header line, so the worker's own records come after the long part. */
async function lengthenTranscript(file: string): Promise<void> {
  const text = await readFile(file, "utf8");
  const headerEnd = text.indexOf("\n") + 1;
  const filler = Array.from({ length: FILLER_LINES }, (_, index) =>
    JSON.stringify({
      type: "custom",
      id: `filler-${index}`,
      parentId: null,
      timestamp: "2026-10-05T00:00:00.000Z",
      customType: "filler",
      data: { text: FILLER_TEXT },
    }),
  ).join("\n");
  await writeFile(file, `${text.slice(0, headerEnd)}${filler}\n${text.slice(headerEnd)}`, "utf8");
}

realTest.setTimeout(420_000);

realTest(
  "real omp: a long finished worker's transcript arrives in replies of at most one 4 MiB page, and its messages open after the app restarts",
  async ({ realApp }) => {
    const page = await realApp.open();
    const composer = await startChat(page);
    await sendPrompt(composer, "spawn_subagent");
    await expect(page.getByText("Background job NestedProbe has completed")).toBeVisible({
      timeout: 240_000,
    });

    // The first page is closed before the restart, so it does not keep retrying its socket against the new server.
    await page.close();
    await realApp.restartServer();
    await lengthenTranscript(await findFile(realApp.agentDir, "NestedProbe.jsonl"));

    // The length of every reply that carries transcript entries, as the socket delivers it.
    const replies: number[] = [];
    const reopened = await realApp.open({
      beforeLoad: async (opened) => {
        opened.on("websocket", (socket) => {
          socket.on("framereceived", ({ payload }) => {
            if (typeof payload === "string" && payload.includes('"nextByte"'))
              replies.push(payload.length);
          });
        });
      },
    });
    await reopened
      .getByRole("listbox", { name: "Session list" })
      .getByRole("option", { name: /spawn_subagent/ })
      .click();
    await reopened.getByRole("tab", { name: "Agents" }).click();
    const hub = reopened.getByRole("region", { name: "Agent Hub" });
    await expect(hub.getByRole("option", { name: /NestedProbe/ })).toHaveCount(1, {
      timeout: 120_000,
    });
    await hub.getByRole("option", { name: /NestedProbe/ }).click();
    await hub.getByRole("button", { name: "Open transcript" }).click();
    const region = reopened.getByRole("region", { name: /^Transcript of NestedProbe/ });
    await expect(region.locator(TRANSCRIPT)).toContainText(TASK_TEXT, { timeout: 120_000 });
    await expect(region.getByText(COULD_NOT_READ)).toHaveCount(0);

    expect(Math.max(...replies)).toBeLessThanOrEqual(PAGE_BYTES + REPLY_SLACK_BYTES);
    expect(replies.length).toBeGreaterThan(1);
    expect(realApp.problems).toEqual([]);
  },
);
