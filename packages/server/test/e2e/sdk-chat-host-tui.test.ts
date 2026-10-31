/**
 * The terminal fallback (SDK plan H5.7, #2752) end to end: `omp-app tui` opens omp's own terminal app in tmux, on the
 * app's chats. The app's side is the server's chat session port on real chat hosts (`sdk-chat-session-harness.ts`),
 * reading omp's leases as the app does; the terminal's side is the command itself (`scripts/omp-app.ts`), run in a
 * pseudo-terminal (`script`) against a tmux server of the test's own (`TMUX_TMPDIR`), typed into with `send-keys` and
 * read with `capture-pane`. Both run on the fake model. Runs with OMP_APP_REAL_OMP=1 where tmux and `script` are
 * installed, from source and compiled.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { SessionFilePath, ThreadId } from "@omp-app/contracts";
import { PROGRAMS, realTest } from "./sdk-chat-host-harness";
import {
  call,
  chatSessionPorts,
  type PortSetup,
  streamOf,
  until,
} from "./sdk-chat-session-harness";
import {
  chatFiles,
  closeTerminals,
  eventually,
  SCRIPT,
  TERMINAL_CONFIG,
  TMUX,
  terminalOn,
} from "./tui-terminal";

const ports = chatSessionPorts();
/** omp's terminal app on a new agent folder, past its setup wizard (`tui-terminal.ts`), and the leases omp writes. */
const TERMINAL_READY = { realLeases: true, config: TERMINAL_CONFIG };

afterEach(async () => {
  await closeTerminals();
  await ports.stopAll();
}, 90_000);

/**
 * The fake model's answer to `count_reply <word>`: `count-<n> <word>`. The prompt itself says `count_reply <word>`, so
 * this matches the answer only; `n` counts every request the provider saw, titles included.
 */
function reply(word: string): RegExp {
  return new RegExp(`count-\\d+ ${word}`);
}

/** Sends a prompt from the app and waits for its result on the chat's stream. */
async function appTurn(setup: PortSetup, threadId: ThreadId, text: string): Promise<void> {
  const mark = streamOf(setup, threadId).length;
  await setup.runtime.request({ threadId, method: "prompt", params: { text } }, call());
  await until(() =>
    streamOf(setup, threadId)
      .slice(mark)
      .find((payload) => payload.kind === "event" && payload.event.type === "prompt_result"),
  );
}

/** Closes the app's only view of a chat and stops its host, which lets go of the chat. */
async function appCloses(setup: PortSetup, threadId: ThreadId): Promise<void> {
  await setup.runtime.close({ threadId }, call());
  await setup.registry.stopIfUnwatched(threadId, "renamed");
}

/** The chat's messages as the app's host reads them. */
async function appMessages(setup: PortSetup, threadId: ThreadId): Promise<string> {
  return JSON.stringify(
    await setup.runtime.request({ threadId, method: "get_messages_page", params: {} }, call()),
  );
}

describe("omp-app tui: omp's own terminal app on the app's chats", () => {
  for (const program of PROGRAMS) {
    const runs = program.command !== undefined && TMUX !== null && SCRIPT !== null;
    const programTest = runs ? realTest : test.skip;
    const command = program.command ?? [];
    const compiled = program.name === "compiled" ? command[0] : undefined;

    programTest(
      `${program.name}: a chat started in the app continues in the terminal, comes back after a detach, and shows back in the app`,
      async () => {
        const setup = await ports.start(command, TERMINAL_READY);
        const opened = await setup.runtime.open({ folderPath: setup.folder, start: "new" }, call());
        const threadId = opened.threadId;
        setup.files.set(threadId, opened.sessionFile);
        await appTurn(setup, threadId, "count_reply app-first");
        await appCloses(setup, threadId);

        const terminal = await terminalOn(setup, compiled);
        terminal.open(["--resume", threadId]);
        await terminal.shows(reply("app-first"));
        await terminal.type("count_reply terminal-second");
        await terminal.shows(reply("terminal-second"));

        // While the terminal holds the chat, the app does not open it: omp would move the chat to a new file.
        await expect(setup.runtime.open({ threadId }, call())).rejects.toMatchObject({
          appError: { code: "conflict", conflictReason: "held_elsewhere" },
        });

        // Leaving the terminal (tmux's detach) keeps omp running; the same command goes back to it.
        expect((await terminal.tmux("detach-client", "-s", `=${terminal.name}`)).code).toBe(0);
        expect(await terminal.running()).toBe(true);
        terminal.open();
        const clients = async () =>
          (await terminal.tmux("list-clients", "-t", `=${terminal.name}`)).out
            .split("\n")
            .filter((line) => line !== "");
        await eventually(async () => (await clients()).length === 1);
        await terminal.shows(reply("terminal-second"));

        // Quitting omp ends the session and lets go of the chat: the app opens it with the terminal's turn.
        await terminal.type("/exit");
        await eventually(async () => !(await terminal.running()));
        await setup.runtime.open({ threadId }, call());
        expect(await appMessages(setup, threadId)).toMatch(reply("terminal-second"));
        await appTurn(setup, threadId, "count_reply app-third");
        const files = await chatFiles(setup);
        expect([...files.keys()]).toEqual([threadId]);
        const written = await readFile(files.get(threadId) ?? "", "utf8");
        for (const word of ["app-first", "terminal-second", "app-third"]) {
          expect(written).toMatch(reply(word));
        }
      },
      240_000,
    );

    programTest(
      `${program.name}: a chat started in the terminal shows in the app, which continues it`,
      async () => {
        const setup = await ports.start(command, TERMINAL_READY);
        const terminal = await terminalOn(setup, compiled);
        terminal.open();
        // omp's status line names the model once its terminal app is up.
        await terminal.shows(/fake-model|Fake Model/);
        await terminal.type("count_reply terminal-start");
        await terminal.shows(reply("terminal-start"));
        await terminal.type("/exit");
        await eventually(async () => !(await terminal.running()));

        const files = await chatFiles(setup);
        expect(files.size).toBe(1);
        const [[id, file]] = [...files.entries()] as [[string, string]];
        const threadId = ThreadId.parse(id);
        setup.files.set(threadId, SessionFilePath.parse(file));
        await setup.runtime.open({ threadId }, call());
        expect(await appMessages(setup, threadId)).toMatch(reply("terminal-start"));
        await appTurn(setup, threadId, "count_reply app-continues");
        expect(await readFile(file, "utf8")).toMatch(reply("app-continues"));
      },
      240_000,
    );

    programTest(
      `${program.name}: with both on one chat, the terminal's turn goes to a chat of its own and the app's file keeps its own`,
      async () => {
        const setup = await ports.start(command, TERMINAL_READY);
        const opened = await setup.runtime.open({ folderPath: setup.folder, start: "new" }, call());
        const threadId = opened.threadId;
        setup.files.set(threadId, opened.sessionFile);
        await appTurn(setup, threadId, "count_reply app-holds");

        const terminal = await terminalOn(setup, compiled);
        terminal.open(["--resume", threadId]);
        await terminal.shows(reply("app-holds"));
        await terminal.type("count_reply terminal-too");
        await terminal.shows(reply("terminal-too"));

        const files = await chatFiles(setup);
        expect(files.size).toBe(2);
        const appFile = await readFile(files.get(threadId) ?? "", "utf8");
        expect(appFile).toMatch(reply("app-holds"));
        expect(appFile).not.toContain("terminal-too");
        const [copy] = [...files.entries()].filter(([id]) => id !== threadId);
        expect(await readFile(copy?.[1] ?? "", "utf8")).toMatch(reply("terminal-too"));

        // The app's chat goes on in its own file.
        await appTurn(setup, threadId, "count_reply app-goes-on");
        expect(await readFile(files.get(threadId) ?? "", "utf8")).toMatch(reply("app-goes-on"));
      },
      240_000,
    );
  }
});
