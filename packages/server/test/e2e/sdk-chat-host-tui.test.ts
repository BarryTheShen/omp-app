/**
 * The terminal fallback (SDK plan H5.7, #2752) end to end: `omp-app tui` opens omp's own terminal app in tmux, on the
 * app's chats. The app's side is the server's chat session port on real chat hosts (`sdk-chat-session-harness.ts`),
 * reading omp's leases as the app does; the terminal's side is the command itself (`scripts/omp-app.ts`), run in a
 * pseudo-terminal (`script`) against a tmux server of the test's own (`TMUX_TMPDIR`), typed into with `send-keys` and
 * read with `capture-pane`. Both run on the fake model. Runs with OMP_APP_REAL_OMP=1 where tmux and `script` are
 * installed, from source and compiled.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SessionFilePath, ThreadId } from "@omp-app/contracts";
import { tuiSessionName } from "../../src/launcher/tui";
import { parseSessionContent } from "../../src/modules/A1/sessions";
import { PROGRAMS, realTest } from "./sdk-chat-host-harness";
import {
  call,
  chatSessionPorts,
  type PortSetup,
  streamOf,
  until,
} from "./sdk-chat-session-harness";

const TMUX = Bun.which("tmux");
const SCRIPT = Bun.which("script");
const OMP_APP = resolve(import.meta.dir, "../../scripts/omp-app.ts");
const ports = chatSessionPorts();
/**
 * The test's agent folder is new, and on a new folder omp's terminal app starts with its setup wizard (sign-ins, theme:
 * `main.ts:671-701` at 18.12.6) until `startup.setupWizard` is off; a person's own omp has been through it. The update
 * check is off so nothing but the fake model is asked.
 */
const TERMINAL_READY = {
  realLeases: true,
  config: "startup:\n  setupWizard: false\n  checkUpdate: false\n",
};
const terminals: Terminal[] = [];

afterEach(async () => {
  await Promise.all(terminals.splice(0).map((terminal) => terminal.close()));
  await ports.stopAll();
}, 90_000);

/** Waits until `check` holds, asking every 200 ms. */
async function eventually(check: () => Promise<boolean>, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(200);
  }
}

/** Quotes one word for the shell `script` runs its command with. */
function quoted(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

/** The terminal side: the folder's tmux session, on the test's own tmux server. */
interface Terminal {
  readonly name: string;
  /** Starts `omp-app tui` on the folder in a pseudo-terminal, as a person in a terminal does; it attaches. */
  open(ompArgs?: readonly string[]): Bun.Subprocess;
  tmux(
    ...args: readonly string[]
  ): Promise<{ readonly code: number; readonly out: string; readonly err: string }>;
  /** Whether the folder's session is running. */
  running(): Promise<boolean>;
  /** What the terminal shows now. */
  screen(): Promise<string>;
  /** Types a line and presses Enter. */
  type(line: string): Promise<void>;
  /** Waits until the terminal shows `text`; fails with what it shows instead. */
  shows(text: RegExp, timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

async function terminalOn(setup: PortSetup, compiled: string | undefined): Promise<Terminal> {
  const tmuxDir = await mkdtemp(join(tmpdir(), "omp-app-tui-"));
  const name = tuiSessionName(setup.folder);
  const env: Record<string, string | undefined> = {
    ...process.env,
    ...setup.env,
    TMUX_TMPDIR: tmuxDir,
    TMUX: undefined,
    TERM: "xterm-256color",
    OMP_APP_CHAT_HOST_BIN: compiled,
  };
  const clients: Bun.Subprocess[] = [];
  const tmux = async (...args: readonly string[]) => {
    const child = Bun.spawn([TMUX ?? "tmux", ...args], { env, stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code: await child.exited, out, err };
  };
  // A pane is named by its session, then `:` for the session's current window; `=` asks for the exact name.
  const pane = `=${name}:`;
  const screen = async () => {
    const captured = await tmux("capture-pane", "-p", "-t", pane);
    return captured.code === 0 ? captured.out : `(capture-pane: ${captured.err.trim()})`;
  };
  /** What each start of the command printed: `script` keeps it, so a failure can say why omp did not show. */
  const transcripts: string[] = [];
  const terminal: Terminal = {
    name,
    open(ompArgs = []) {
      const words = [
        process.execPath,
        OMP_APP,
        "tui",
        setup.folder,
        "--",
        "--model",
        "fake/fake-model",
        ...ompArgs,
      ];
      const transcript = join(tmuxDir, `client-${clients.length}.log`);
      transcripts.push(transcript);
      const client = Bun.spawn(
        [SCRIPT ?? "script", "-qfec", words.map(quoted).join(" "), transcript],
        { env, stdin: "pipe", stdout: "ignore", stderr: "ignore" },
      );
      clients.push(client);
      return client;
    },
    tmux,
    running: async () => (await tmux("has-session", "-t", `=${name}`)).code === 0,
    screen,
    async type(line) {
      await tmux("send-keys", "-t", pane, "-l", line);
      await tmux("send-keys", "-t", pane, "Enter");
    },
    async shows(text, timeoutMs = 60_000) {
      const deadline = Date.now() + timeoutMs;
      let last = "";
      while (Date.now() < deadline) {
        last = await screen();
        if (text.test(last)) return;
        await Bun.sleep(200);
      }
      const printed = await Promise.all(
        transcripts.map(async (file) =>
          (await readFile(file, "utf8").catch(() => ""))
            // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escapes are control characters
            .replace(/\u001b\[[0-9;?]*[A-Za-z]|\u001b[()][A-Za-z0-9]|\r/g, "")
            .split("\n")
            .slice(-15)
            .join("\n"),
        ),
      );
      throw new Error(
        `the terminal does not show ${text}; it shows:\n${last}\nsession running: ${await terminal.running()}\nthe command printed:\n${printed.join("\n----\n")}`,
      );
    },
    async close() {
      await tmux("kill-server");
      for (const client of clients) client.kill();
      await Promise.all(clients.map((client) => client.exited));
      await rm(tmuxDir, { recursive: true, force: true });
    },
  };
  terminals.push(terminal);
  return terminal;
}

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

/**
 * The chats omp wrote for the folder, by id, read as the app reads them (A1's parser: a session file starts with its
 * title slot, then the header that names the chat).
 */
async function chatFiles(setup: PortSetup): Promise<Map<string, string>> {
  const sessions = join(setup.env.PI_CODING_AGENT_DIR ?? "", "sessions");
  const files = new Map<string, string>();
  for (const bucket of await readdir(sessions)) {
    for (const entry of await readdir(join(sessions, bucket))) {
      if (!entry.endsWith(".jsonl")) continue;
      const file = join(sessions, bucket, entry);
      const id = parseSessionContent(await readFile(file, "utf8"), file).header?.id;
      if (id !== undefined) files.set(id, file);
    }
  }
  return files;
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
