import { spawnSync } from "node:child_process";
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { BrowserContext, Page } from "@playwright/test";
import { APP_ROOT, expect, type RealApp, realTest, startNewChat } from "./real-omp";

/**
 * An omp update on real omp: the switch (a server on the new omp takes over chats running on the old one) and the way
 * back (chats the new omp wrote open and go on on the old one), with `omp-app maintenance` doing what the automatic
 * update does. They need the other build of the chat host, the one of the release the app runs now, which the update's
 * gate gives as `OMP_APP_OTHER_CHAT_HOST` (a path, relative to the repository's root); without it they are skipped.
 */
const OTHER = process.env.OMP_APP_OTHER_CHAT_HOST ?? "";
const OTHER_HOST = OTHER === "" ? undefined : resolve(APP_ROOT, OTHER);
const CLI = resolve(APP_ROOT, "packages/server/scripts/omp-app.ts");
const SKIP_WHY =
  "runs in the omp update's gate, which gives the chat host of the release the app runs now";

interface Status {
  readonly server: { readonly omp: string | null };
  readonly hold: { readonly held: boolean };
  readonly chats: readonly {
    readonly threadId: string;
    readonly ompVersion: string | null;
    readonly settled: boolean | null;
    readonly paused: boolean;
  }[];
}

/** `omp-app maintenance` as the update runs it, for the test's server: an instance record in a HOME of its own. */
class Maintenance {
  readonly #home = mkdtempSync(join(tmpdir(), "omp-update-home-"));

  /** Names the running server by its launch link (`…/#token=…`), as the launcher's record does. */
  point(link: string): void {
    const dir = join(this.#home, ".local", "state", "omp-app");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "instance.json"),
      JSON.stringify({ pid: process.pid, url: link, version: "test" }),
      { mode: 0o600 },
    );
  }

  run(...args: string[]): unknown {
    const run = spawnSync("bun", [CLI, "maintenance", ...args], {
      env: { ...process.env, HOME: this.#home, XDG_STATE_HOME: "" },
      encoding: "utf8",
      timeout: 90_000,
    });
    if (run.status !== 0) throw new Error(`maintenance ${args.join(" ")} failed: ${run.stderr}`);
    return JSON.parse(run.stdout);
  }

  status(): Status {
    return this.run("status") as Status;
  }

  close(): void {
    rmSync(this.#home, { recursive: true, force: true });
  }
}

const box = (page: Page) => page.getByRole("textbox", { name: "Message" });
const transcript = (page: Page) => page.getByRole("region", { name: "Transcript" });
const pongs = (page: Page) => transcript(page).getByText("pong", { exact: true });

/** A new chat in a page of its own; `first` is sent and answered when given. */
async function newChat(
  realApp: RealApp,
  first: string | null,
): Promise<{ readonly page: Page; readonly context: BrowserContext }> {
  const page = await realApp.open({ path: "/" });
  await startNewChat(page);
  await expect(box(page)).toHaveAttribute("placeholder", "Message omp", { timeout: 120_000 });
  if (first !== null) {
    await box(page).fill(first);
    await box(page).press("Enter");
    await expect(pongs(page)).toHaveCount(1, { timeout: 90_000 });
  }
  return { page, context: page.context() };
}

realTest.describe("an omp update: the switch", () => {
  realTest.skip(OTHER_HOST === undefined, SKIP_WHY);
  // The chats start on the other (older) build, in hosts that outlive the server, as on the computer the app runs on.
  realTest.use({
    serverEnv: {
      OMP_APP_DETACHED_HOSTS: "1",
      ...(OTHER_HOST === undefined ? {} : { OMP_APP_CHAT_HOST_BIN: OTHER_HOST }),
    },
  });
  realTest.setTimeout(600_000);

  realTest(
    "the chats move to the new omp paused; a reply under way ends first; one paused before stays paused; a queued task waits for the end",
    async ({ realApp }) => {
      const update = new Maintenance();
      try {
        const idle = await newChat(realApp, "say hello");
        const pausedBefore = await newChat(realApp, "say hello");
        await box(pausedBefore.page).fill("/pause");
        await box(pausedBefore.page).press("Enter");
        await expect(box(pausedBefore.page)).toHaveValue(/^\/pause\s*$/);
        await box(pausedBefore.page).press("Enter");
        await expect(pausedBefore.page.locator('[data-tour="paused"]')).toContainText("Paused");
        const working = await newChat(realApp, null);
        await box(working.page).fill("stream_steady");
        await box(working.page).press("Enter");
        await expect(transcript(working.page)).toContainText("Steady line 10:", {
          timeout: 60_000,
        });

        update.point(`${new URL(idle.page.url()).origin}/#token=${realApp.token}`);
        expect(update.run("hold", "60", "e2e switch")).toMatchObject({ held: true });

        // Queued while the update holds: it waits, though the chat is free.
        await box(idle.page).fill("queued during the update");
        await idle.page.getByRole("button", { name: "Queue for later" }).click();
        const later = idle.page.getByRole("dialog", { name: "Queue for later" });
        await later.getByRole("radio", { name: "When this chat is free" }).click();
        await later.getByRole("button", { name: "Queue it" }).click();
        await expect(later).toHaveCount(0);
        await idle.page.waitForTimeout(3_000);
        await expect(transcript(idle.page).getByText("queued during the update")).toHaveCount(0);

        // The reply under way ends on the old omp before anything is paused.
        await expect(transcript(working.page)).toContainText("Steady line 239:", {
          timeout: 180_000,
        });
        const before = update.status();
        console.log(`UPDATE_SWITCH before ${JSON.stringify(before)}`);
        expect(before.chats).toHaveLength(3);
        // They run the other build, the omp this server runs chats on (its `omp` is the chat host's it probed).
        const oldOmp = before.server.omp;
        expect(before.chats.every((chat) => chat.ompVersion === oldOmp)).toBe(true);
        const keptPaused = before.chats.filter((chat) => chat.paused).map((chat) => chat.threadId);
        expect(keptPaused).toHaveLength(1);
        update.run("pause");

        for (const chat of [idle, pausedBefore, working]) await chat.page.close();
        const link = await realApp.restartServer({
          OMP_APP_CHAT_HOST_BIN: process.env.OMP_APP_CHAT_HOST_BIN ?? "",
        });
        update.point(link);

        // Each chat restarts on the new omp, still paused; the hold outlived the restart.
        let after = update.status();
        await expect
          .poll(
            () => {
              after = update.status();
              return (
                after.chats.length === 3 &&
                after.chats.every((chat) => chat.ompVersion === after.server.omp && chat.paused)
              );
            },
            { timeout: 120_000, intervals: [2_000] },
          )
          .toBe(true);
        console.log(`UPDATE_SWITCH after ${JSON.stringify(after)}`);
        // Another omp than before: otherwise nothing moved.
        expect(after.server.omp).not.toBe(oldOmp);
        expect(after.hold.held).toBe(true);

        const toResume = after.chats
          .map((chat) => chat.threadId)
          .filter((threadId) => !keptPaused.includes(threadId));
        expect(update.run("resume", ...toResume)).toEqual({ resumed: 2 });
        expect(update.run("release")).toMatchObject({ held: false });

        // The task goes once the hold ends, answered by the new omp.
        const idleAgain = await realApp.open({ path: "/", context: idle.context });
        await expect(transcript(idleAgain).getByText("queued during the update")).toBeVisible({
          timeout: 90_000,
        });
        await expect(pongs(idleAgain)).toHaveCount(2, { timeout: 90_000 });
        // The reply that ran through the update shows whole, once, and the chat goes on.
        const workingAgain = await realApp.open({ path: "/", context: working.context });
        await expect(transcript(workingAgain).getByText("Steady line 239:")).toHaveCount(1, {
          timeout: 60_000,
        });
        await box(workingAgain).fill("say hello");
        await box(workingAgain).press("Enter");
        await expect(pongs(workingAgain)).toHaveCount(1, { timeout: 90_000 });
        // The chat paused before the update is still paused.
        const end = update.status();
        expect(end.chats.find((chat) => chat.threadId === keptPaused[0])?.paused).toBe(true);
        console.log("UPDATE_SWITCH all checks passed");
        expect(realApp.problems).toEqual([]);
      } finally {
        update.close();
      }
    },
  );
});

realTest.describe("an omp update: the way back", () => {
  realTest.skip(OTHER_HOST === undefined, SKIP_WHY);
  realTest.setTimeout(420_000);

  realTest(
    "a chat the new omp wrote opens on the old omp, whole, and goes on",
    async ({ realApp }) => {
      const update = new Maintenance();
      try {
        const chat = await newChat(realApp, "say hello");
        await box(chat.page).fill("say hello again");
        await box(chat.page).press("Enter");
        await expect(pongs(chat.page)).toHaveCount(2, { timeout: 90_000 });
        update.point(`${new URL(chat.page.url()).origin}/#token=${realApp.token}`);
        const before = update.status();
        expect(before.chats[0]?.ompVersion).toBe(before.server.omp);

        // The chats' hosts end with this server; the next starts each chat from its file on the other build.
        await chat.page.close();
        const link = await realApp.restartServer({ OMP_APP_CHAT_HOST_BIN: OTHER_HOST ?? "" });
        update.point(link);
        const again = await realApp.open({ path: "/", context: chat.context });
        await expect(pongs(again)).toHaveCount(2, { timeout: 90_000 });
        await expect(transcript(again).getByText("say hello again")).toBeVisible();
        // The page draws the transcript from the file before the chat's omp has loaded it, and the status lists a chat
        // once its host runs: under load that comes seconds later (the gate, 2026-11-12).
        let after = update.status();
        await expect
          .poll(
            () => {
              after = update.status();
              // On the other build now (the omp the restarted server probed), not the one that wrote it.
              return after.chats.length === 1 && after.chats[0]?.ompVersion === after.server.omp;
            },
            { timeout: 120_000, intervals: [2_000] },
          )
          .toBe(true);
        expect(after.chats[0]?.ompVersion).not.toBe(before.chats[0]?.ompVersion);

        await box(again).fill("on the old omp");
        await box(again).press("Enter");
        await expect(pongs(again)).toHaveCount(3, { timeout: 90_000 });
        console.log(
          `UPDATE_WAYBACK written on omp ${before.chats[0]?.ompVersion}, opened and answered on omp ${after.chats[0]?.ompVersion}`,
        );
        expect(realApp.problems).toEqual([]);
      } finally {
        update.close();
      }
    },
  );
});

/** The size of the chat the big-chat test writes: about that of the largest real chat seen (643 MB, 161,536 lines). */
const BIG_CHAT_MB = Number(process.env.OMP_APP_BIG_CHAT_MB ?? "640");
const BIG_FIRST = "Big chat for the omp update";
const BIG_LAST = "Big chat end.";

/**
 * Writes a chat of about `megabytes` into the folder's session bucket, shaped as the largest real chat (lines of about
 * 4 KB: bash calls and their long results); its id.
 */
function writeBigChat(bucket: string, folder: string, megabytes: number): string {
  const id = "01a33333-0000-7000-8000-000000000003";
  const when = new Date(Date.UTC(2026, 9, 3));
  const stamp = when.toISOString();
  const usage = {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const fd = openSync(join(bucket, `${stamp.replace(/[:.]/g, "-")}_${id}.jsonl`), "w");
  let parent: string | null = null;
  let count = 0;
  let written = 0;
  let lines: string[] = [];
  const add = (message: Record<string, unknown>) => {
    const entryId = `e${String(count++).padStart(7, "0")}`;
    const line = JSON.stringify({
      type: "message",
      id: entryId,
      parentId: parent,
      timestamp: stamp,
      message,
    });
    parent = entryId;
    written += line.length + 1;
    lines.push(line);
    if (lines.length >= 2_000) {
      writeSync(fd, `${lines.join("\n")}\n`);
      lines = [];
    }
  };
  writeSync(
    fd,
    `${JSON.stringify({ type: "session", version: 3, id, timestamp: stamp, cwd: folder })}\n`,
  );
  add({ role: "user", content: [{ type: "text", text: BIG_FIRST }], timestamp: when.getTime() });
  const output = "output line of a long command, as a big chat holds many\n".repeat(130);
  for (let step = 0; written < megabytes * 1024 * 1024; step += 1) {
    add({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: `call_${step}`,
          name: "bash",
          arguments: { command: `run step ${step}` },
        },
      ],
      api: "openai-completions",
      provider: "fake",
      model: "fake-model",
      usage,
      stopReason: "toolUse",
      timestamp: when.getTime(),
    });
    add({
      role: "toolResult",
      toolCallId: `call_${step}`,
      toolName: "bash",
      content: [{ type: "text", text: `${step}\n${output}` }],
      isError: false,
      timestamp: when.getTime(),
    });
  }
  add({
    role: "assistant",
    content: [{ type: "text", text: BIG_LAST }],
    api: "openai-completions",
    provider: "fake",
    model: "fake-model",
    usage,
    stopReason: "stop",
    timestamp: when.getTime(),
  });
  writeSync(fd, `${lines.join("\n")}\n`);
  closeSync(fd);
  console.log(`UPDATE_BIGCHAT wrote ${count + 1} lines, ${Math.round(written / 1048576)} MB`);
  return id;
}

/** The highest memory a process has used (kB in /proc → MB). */
function peakMb(pid: number): number {
  const kb = Number(
    /^VmHWM:\s+(\d+) kB$/m.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1] ?? "0",
  );
  return Math.round(kb / 1024);
}

realTest.describe("an omp update: a big chat", () => {
  realTest.skip(OTHER_HOST === undefined, SKIP_WHY);
  realTest.setTimeout(1_500_000);

  realTest(
    "a chat the size of the largest real one opens on the new omp within the old one's time and memory",
    async ({ realApp }) => {
      // A first chat makes the folder's session bucket, where omp keeps its chats.
      const first = await newChat(realApp, "say hello");
      await first.page.close();
      const sessions = join(realApp.agentDir, "sessions");
      const bucket = readdirSync(sessions)
        .map((name) => join(sessions, name))
        .find((dir) => readdirSync(dir).some((file) => file.endsWith(".jsonl")));
      if (bucket === undefined) throw new Error("no session bucket");
      const id = writeBigChat(bucket, realApp.folder, BIG_CHAT_MB);

      /**
       * Restarts the server on `host` and opens the big chat: how long until it can take a message (its omp has loaded the
       * chat and answered; the last line alone shows before that, read from the file by the server), and the host's peak
       * memory a moment later.
       */
      const openOn = async (
        host: string,
      ): Promise<{ readonly ms: number; readonly mb: number }> => {
        await realApp.restartServer({ OMP_APP_CHAT_HOST_BIN: host });
        const page = await realApp.open({ path: "/" });
        const start = Date.now();
        await page
          .getByRole("navigation", { name: "Chats" })
          .getByRole("button", { name: BIG_FIRST })
          .click();
        await expect(
          page.getByRole("region", { name: "Transcript" }).getByText(BIG_LAST),
        ).toBeVisible({
          timeout: 600_000,
        });
        await expect(box(page)).toHaveAttribute("placeholder", "Message omp", { timeout: 600_000 });
        const ms = Date.now() - start;
        await page.waitForTimeout(3_000);
        const started = [
          ...realApp
            .log()
            .matchAll(new RegExp(`omp\\.process thread=${id} status=running pid=(\\d+)`, "g")),
        ].at(-1);
        const mb = peakMb(Number(started?.[1] ?? "0"));
        await page.close();
        return { ms, mb };
      };
      const newHost = process.env.OMP_APP_CHAT_HOST_BIN ?? "";
      const oldCold = await openOn(OTHER_HOST ?? "");
      const fresh = await openOn(newHost);
      const oldWarm = await openOn(OTHER_HOST ?? "");
      console.log(
        `UPDATE_BIGCHAT old ${oldCold.ms} ms ${oldCold.mb} MB, new ${fresh.ms} ms ${fresh.mb} MB, old again ${oldWarm.ms} ms ${oldWarm.mb} MB`,
      );
      const old = { ms: Math.max(oldCold.ms, oldWarm.ms), mb: Math.max(oldCold.mb, oldWarm.mb) };
      expect(fresh.mb).toBeGreaterThan(0);
      expect(fresh.ms).toBeLessThanOrEqual(old.ms * 1.5 + 5_000);
      expect(fresh.mb).toBeLessThanOrEqual(old.mb * 1.3 + 200);
      expect(realApp.problems).toEqual([]);
    },
  );
});
