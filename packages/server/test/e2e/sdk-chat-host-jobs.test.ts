/**
 * The chat host's background jobs, for the Jobs tab, end to end on the fake model provider: the fake model sends bash
 * commands to the background (`run_background_job`, `run_quick_background`) and starts a subagent
 * (`spawn_long_subagent`); the test reads the list, a job's detail, and cancels one. Runs from source and compiled
 * (`sdk-chat-host-harness.ts`).
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { JobList, JobRow } from "@omp-app/contracts/chat-host";
import { chatHostChats, PROGRAMS, realTest, resultOf } from "./sdk-chat-host-harness";

const chats = chatHostChats();
afterEach(() => chats.stopAll(), 60_000);

type Chat = Awaited<ReturnType<typeof chats.start>>;

async function until<T>(read: () => Promise<T | undefined>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await read();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(100);
  }
}

async function jobs(chat: Chat): Promise<JobList> {
  const { jobs: list } = await chat.client.request("get_jobs", {});
  if (list === null) throw new Error("no job manager");
  return list;
}

const all = (list: JobList): JobRow[] => [...list.running, ...list.recent];

describe("the chat host's background jobs", () => {
  for (const program of PROGRAMS) {
    const programTest = program.command === undefined ? test.skip : realTest;
    const command = program.command ?? [];

    programTest(
      `${program.name}: a command sent to the background is listed running and the chat's own, its detail has its command and process, and a cancel ends it`,
      async () => {
        const chat = await chats.start(command);
        await chat.client.hello;
        expect(await jobs(chat)).toEqual({ running: [], recent: [] });
        await chat.client.request("prompt", { text: "run_background_job" });
        await chat.next(resultOf("2"));

        const running = await until(async () => (await jobs(chat)).running[0]);
        expect(running).toMatchObject({ type: "bash", status: "running", own: true });
        expect(running.label).toContain("sleep 120");
        const { job } = await chat.client.request("inspect_job", { jobId: running.id });
        expect(job).toMatchObject({
          id: running.id,
          command: "sleep 120; echo job-0",
          outputCut: false,
        });
        // omp runs the command in its own shell: the job knows where it runs, and has no process of its own to name.
        expect(job?.cwd).toBeDefined();

        expect(await chat.client.request("cancel_job", { jobId: running.id })).toEqual({
          cancelled: true,
        });
        // omp marks it cancelled at once, before its process is gone.
        expect(all(await jobs(chat)).find((row) => row.id === running.id)?.status).toBe(
          "cancelled",
        );
        expect(await chat.client.request("cancel_job", { jobId: running.id })).toEqual({
          cancelled: false,
        });
        expect((await chat.client.request("inspect_job", { jobId: "bg_none" })).job).toBeNull();
      },
      90_000,
    );

    programTest(
      `${program.name}: a job that ends is listed with the recent ones, with its exit code and its output`,
      async () => {
        const chat = await chats.start(command);
        await chat.client.hello;
        await chat.client.request("prompt", { text: "run_quick_background" });
        const done = await until(
          async () => (await jobs(chat)).recent.find((row) => row.status === "completed"),
          60_000,
        );
        expect(done).toMatchObject({ type: "bash", own: true });
        expect(done.endTime).toBeGreaterThanOrEqual(done.startTime);
        const { job } = await chat.client.request("inspect_job", { jobId: done.id });
        expect(job).toMatchObject({ exitCode: 0, pids: [] });
        expect(job?.output).toContain("quick-done");
      },
      90_000,
    );

    programTest(
      `${program.name}: a subagent run in the background is a task job with its agent`,
      async () => {
        const chat = await chats.start(command);
        await chat.client.hello;
        await chat.client.request("prompt", { text: "spawn_long_subagent" });
        const task = await until(async () =>
          (await jobs(chat)).running.find((row) => row.type === "task"),
        );
        expect(task.agentId).toBeDefined();
        expect(task.status).toBe("running");
      },
      90_000,
    );
  }
});
