/**
 * Rename, the reopen after a refused delete, and requests to a chat another omp holds, on the server's chat session port
 * (SDK plan H5.3d), end to end through the port's runtime on real chat hosts. Runs from source and compiled
 * (`sdk-chat-session-harness.ts`).
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { ThreadId } from "@omp-app/contracts";
import { PROGRAMS, realTest } from "./sdk-chat-host-harness";
import {
  call,
  chatSessionPorts,
  type PortSetup,
  streamOf,
  until,
} from "./sdk-chat-session-harness";

const ports = chatSessionPorts();
afterEach(() => ports.stopAll(), 60_000);

/** Sends a prompt and waits for its result on the chat's stream. */
async function turn(setup: PortSetup, threadId: ThreadId, text: string): Promise<void> {
  const mark = streamOf(setup, threadId).length;
  await setup.runtime.request({ threadId, method: "prompt", params: { text } }, call());
  await until(() =>
    streamOf(setup, threadId)
      .slice(mark)
      .find((payload) => payload.kind === "event" && payload.event.type === "prompt_result"),
  );
}

/** The chat's name, as its host reads it from the session. */
async function nameOf(setup: PortSetup, threadId: ThreadId): Promise<string | undefined> {
  const state = (await setup.runtime.request(
    { threadId, method: "get_state", params: {} },
    call(),
  )) as { sessionName?: string };
  return state.sessionName;
}

/** Opens a new chat with one turn, so its file is written, and records the file for `resolveThread`. */
async function writtenChat(setup: PortSetup): Promise<ThreadId> {
  const opened = await setup.runtime.open({ folderPath: setup.folder, start: "new" }, call());
  await turn(setup, opened.threadId, "hello");
  setup.files.set(opened.threadId, opened.sessionFile);
  return opened.threadId;
}

/** Closes a chat's only view and stops its host. */
async function closed(setup: PortSetup, threadId: ThreadId): Promise<void> {
  await setup.runtime.close({ threadId }, call());
  await setup.registry.stopIfUnwatched(threadId, "renamed");
}

describe("rename and the reopen after a refused delete on the chat session port", () => {
  for (const program of PROGRAMS) {
    const programTest = program.command === undefined ? test.skip : realTest;
    const command = program.command ?? [];

    programTest(
      `${program.name}: an open chat is renamed by its own host, which stays up`,
      async () => {
        const setup = await ports.start(command);
        const threadId = await writtenChat(setup);
        const pid = setup.registry.get(threadId)?.pid;

        expect(await setup.runtime.rename({ threadId, name: "Renamed open" }, call())).toBeNull();
        expect(await nameOf(setup, threadId)).toBe("Renamed open");
        expect(setup.registry.get(threadId)?.pid).toBe(pid);
      },
      90_000,
    );

    programTest(
      `${program.name}: a closed chat is renamed by a short-lived host, which stops again`,
      async () => {
        const setup = await ports.start(command);
        const threadId = await writtenChat(setup);
        await closed(setup, threadId);

        expect(await setup.runtime.rename({ threadId, name: "Renamed closed" }, call())).toBeNull();
        expect(setup.registry.has(threadId)).toBe(false);

        await setup.runtime.open({ threadId }, call());
        expect(await nameOf(setup, threadId)).toBe("Renamed closed");
      },
      90_000,
    );

    programTest(
      `${program.name}: while another omp holds a closed chat, a rename is refused and a request is refused in words, and nothing is written`,
      async () => {
        let held = false;
        const setup = await ports.start(command, {
          externalOmp: async () => (held ? "running" : "none"),
        });
        const threadId = await writtenChat(setup);
        await closed(setup, threadId);
        held = true;

        await expect(
          setup.runtime.rename({ threadId, name: "Not while held" }, call()),
        ).rejects.toMatchObject({ appError: { code: "conflict", retryable: true } });
        expect(setup.registry.has(threadId)).toBe(false);
        await expect(
          setup.runtime.request({ threadId, method: "get_state", params: {} }, call()),
        ).rejects.toMatchObject({
          appError: {
            code: "conflict",
            message: expect.stringContaining("Another omp has this chat open"),
          },
        });
        expect(setup.registry.has(threadId)).toBe(false);

        held = false;
        await setup.runtime.open({ threadId }, call());
        expect(await nameOf(setup, threadId)).toBeUndefined();
      },
      90_000,
    );

    programTest(
      `${program.name}: a delete refused past the stop limit opens the chat again for the tab, which answers its next prompt`,
      async () => {
        const setup = await ports.start(command, { stopLimitAtOnce: true });
        const threadId = await writtenChat(setup);
        const firstPid = setup.registry.get(threadId)?.pid;

        // The tab's delete waits on the stop past its limit: the delete is refused, and the host's stop goes on.
        await expect(setup.registry.stopIfUnwatched(threadId, "deleted", 1)).rejects.toMatchObject({
          appError: { code: "conflict" },
        });

        // Once the old host has exited, a new one serves the chat for the tab.
        await until(() => {
          const pid = setup.registry.get(threadId)?.pid;
          return pid !== undefined &&
            pid !== firstPid &&
            setup.runtime.viewsOf(threadId, "connection-1") === 1
            ? pid
            : undefined;
        });
        await turn(setup, threadId, "after the refusal");
      },
      90_000,
    );

    programTest(
      `${program.name}: a refused delete's chat is not opened again while another omp holds it`,
      async () => {
        let held = false;
        const leaseReads: ThreadId[] = [];
        const setup = await ports.start(command, {
          stopLimitAtOnce: true,
          externalOmp: async (threadId) => {
            leaseReads.push(threadId);
            return held ? "running" : "none";
          },
        });
        const threadId = await writtenChat(setup);
        held = true;

        await expect(setup.registry.stopIfUnwatched(threadId, "deleted", 1)).rejects.toMatchObject({
          appError: { code: "conflict" },
        });
        // The reopen reads the lease once the old host has exited, and then starts nothing.
        await until(() => (leaseReads.includes(threadId) ? true : undefined));
        await Bun.sleep(200);
        expect(setup.registry.has(threadId)).toBe(false);
        expect(setup.runtime.viewsOf(threadId, "connection-1")).toBe(0);
      },
      90_000,
    );
  }
});
