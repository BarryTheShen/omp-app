/**
 * A new chat always ready (#2760), on real chat hosts through the chat session port: after a new chat opens in a folder,
 * the next one there is started ahead; the next "New chat" takes it without starting omp, and another is started behind
 * it. A spare is never a running chat of the folder, one that stopped is not taken, the two folders used last keep one
 * each, and the runtime's end stops them. Runs from source and compiled.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { FolderPath, type ThreadId } from "@omp-app/contracts";
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

/** The new chats started ahead: processes still under a provisional id, running. */
function spares(setup: PortSetup) {
  return setup.registry
    .list()
    .filter(
      (process) => process.threadId.startsWith("provisional-") && process.status === "running",
    );
}

function alive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A turn in the chat, to its end: the fake model answers `count_reply <word>` with `count-<n> <word>`. */
async function turn(setup: PortSetup, threadId: ThreadId, word: string): Promise<void> {
  const mark = streamOf(setup, threadId).length;
  await setup.runtime.request(
    { threadId, method: "prompt", params: { text: `count_reply ${word}` } },
    call(),
  );
  await until(
    () =>
      streamOf(setup, threadId)
        .slice(mark)
        .find((payload) => payload.kind === "event" && payload.event.type === "prompt_result"),
    60_000,
  );
}

describe("a new chat always ready", () => {
  for (const program of PROGRAMS) {
    const programTest = program.command === undefined ? test.skip : realTest;
    const command = program.command ?? [];

    programTest(
      `${program.name}: the next new chat in a folder takes the one started ahead, and another is started behind it`,
      async () => {
        const setup = await ports.start(command, { newChatsReady: true });
        const first = await setup.runtime.open({ folderPath: setup.folder, start: "new" }, call());
        const [ahead] = await until(() => (spares(setup).length === 1 ? spares(setup) : undefined));

        const second = await setup.runtime.open({ folderPath: setup.folder, start: "new" }, call());
        expect(second.threadId).not.toBe(first.threadId);
        // The second chat is the process started ahead, under its own id now.
        const taken = setup.registry.list().find((process) => process.threadId === second.threadId);
        expect(taken?.pid).toBe(ahead?.pid);
        // Another is started behind it; neither is a running chat of the folder.
        await until(() => spares(setup).some((spare) => spare.pid !== ahead?.pid) || undefined);
        expect(setup.registry.busyIn(setup.folder)).toEqual([]);
        // The chat taken works as any new chat.
        await turn(setup, second.threadId, "taken");
        expect(JSON.stringify(streamOf(setup, second.threadId))).toMatch(/count-\d+ taken/);
      },
      120_000,
    );

    programTest(
      `${program.name}: a new chat started ahead that stopped is not taken; the new chat starts its own`,
      async () => {
        const setup = await ports.start(command, { newChatsReady: true });
        await setup.runtime.open({ folderPath: setup.folder, start: "new" }, call());
        const [ahead] = await until(() => (spares(setup).length === 1 ? spares(setup) : undefined));
        process.kill(ahead?.pid ?? 0, "SIGKILL");
        await until(() => (alive(ahead?.pid) ? undefined : true));

        const opened = await setup.runtime.open({ folderPath: setup.folder, start: "new" }, call());
        const own = setup.registry.list().find((process) => process.threadId === opened.threadId);
        expect(own?.pid).not.toBe(ahead?.pid);
        await turn(setup, opened.threadId, "own");
      },
      120_000,
    );

    programTest(
      `${program.name}: the two folders used last keep one each, and the runtime's end stops them`,
      async () => {
        const setup = await ports.start(command, { newChatsReady: true });
        const folders = await Promise.all(
          ["a", "b", "c"].map(async (name) => {
            const path = join(setup.home, name);
            await mkdir(path, { recursive: true });
            return FolderPath.parse(path);
          }),
        );
        for (const folderPath of folders.slice(0, 2)) {
          await setup.runtime.open({ folderPath, start: "new" }, call());
        }
        const two = await until(() => (spares(setup).length === 2 ? spares(setup) : undefined));
        await setup.runtime.open({ folderPath: folders[2] as FolderPath, start: "new" }, call());
        // The first folder's lets go; the second's stays, and the third gets one.
        await until(() => (alive(two[0]?.pid) ? undefined : true));
        expect(alive(two[1]?.pid)).toBe(true);
        const kept = await until(() => (spares(setup).length === 2 ? spares(setup) : undefined));

        await setup.runtime.dispose();
        for (const spare of kept) expect(alive(spare.pid)).toBe(false);
      },
      120_000,
    );

    programTest(
      `${program.name}: a page's folder has a new chat ready before any was opened there, and the first takes it`,
      async () => {
        const setup = await ports.start(command, { newChatsReady: true });
        setup.runtime.prepareNew({ folderPath: setup.folder });
        const [ahead] = await until(() => (spares(setup).length === 1 ? spares(setup) : undefined));
        const opened = await setup.runtime.open({ folderPath: setup.folder, start: "new" }, call());
        const taken = setup.registry.list().find((process) => process.threadId === opened.threadId);
        expect(taken?.pid).toBe(ahead?.pid);
      },
      120_000,
    );

    programTest(
      `${program.name}: a server that keeps no new chat ready ignores a page's folder`,
      async () => {
        const setup = await ports.start(command);
        setup.runtime.prepareNew({ folderPath: setup.folder });
        await Bun.sleep(2_000);
        expect(setup.registry.list()).toEqual([]);
      },
      60_000,
    );
  }
});
