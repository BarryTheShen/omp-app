/**
 * The terminal side of the `omp-app tui` tests: the command itself (`scripts/omp-app.ts`), run in a pseudo-terminal
 * (`script`) against a tmux server of the test's own (`TMUX_TMPDIR`), typed into with `send-keys` and read with
 * `capture-pane`; and the chats omp wrote, read as the app reads them.
 */
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { tuiSessionName } from "../../src/launcher/tui";
import { parseSessionContent } from "../../src/modules/A1/sessions";

export const TMUX = Bun.which("tmux");
export const SCRIPT = Bun.which("script");
const OMP_APP = resolve(import.meta.dir, "../../scripts/omp-app.ts");

/**
 * The test's agent folder is new, and on a new folder omp's terminal app starts with its setup wizard (sign-ins, theme:
 * `main.ts:671-701` at 18.12.6) until `startup.setupWizard` is off; a person's own omp has been through it. The update
 * check is off so nothing but the fake model is asked.
 */
export const TERMINAL_CONFIG = "startup:\n  setupWizard: false\n  checkUpdate: false\n";

/** What the terminal side needs of a test: its folder, and the environment omp runs with there. */
export interface TerminalSetup {
  readonly folder: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

const terminals: Terminal[] = [];

/** Closes every terminal the test opened (its tmux server and the commands attached to it). */
export async function closeTerminals(): Promise<void> {
  await Promise.all(terminals.splice(0).map((terminal) => terminal.close()));
}

/** Waits until `check` holds, asking every 200 ms. */
export async function eventually(check: () => Promise<boolean>, timeoutMs = 60_000): Promise<void> {
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
export interface Terminal {
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
  /** What the command printed before omp took the terminal, escapes removed. */
  printed(): Promise<string>;
  /** Types a line and presses Enter. */
  type(line: string): Promise<void>;
  /** Waits until the terminal shows `text`; fails with what it shows instead. */
  shows(text: RegExp, timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

export async function terminalOn(
  setup: TerminalSetup,
  compiled: string | undefined,
): Promise<Terminal> {
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
  const printed = async () =>
    (
      await Promise.all(
        transcripts.map(async (file) =>
          (
            await readFile(file, "utf8").catch(() => "")
          )
            // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escapes are control characters
            .replace(/\u001b\[[0-9;?]*[A-Za-z]|\u001b[()][A-Za-z0-9]|\r/g, ""),
        ),
      )
    ).join("\n----\n");
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
    printed,
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
      const tail = (await printed())
        .split("\n----\n")
        .map((one) => one.split("\n").slice(-15).join("\n"))
        .join("\n----\n");
      throw new Error(
        `the terminal does not show ${text}; it shows:\n${last}\nsession running: ${await terminal.running()}\nthe command printed:\n${tail}`,
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
 * The chats omp wrote for the test's agent folder, by id, read as the app reads them (A1's parser: a session file
 * starts with its title slot, then the header that names the chat).
 */
export async function chatFiles(setup: TerminalSetup): Promise<Map<string, string>> {
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
