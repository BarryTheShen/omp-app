/**
 * D2's rules for hosts an earlier server left running, against fake hosts on Unix sockets: which hosts a starting
 * server takes over and which it asks to hand their chats back (`adoptRunningHosts`), what `omp-app tui` asks of them
 * (`handBackHosts`), and what an attached host's client reads (`DetachedOmpProcess.attach`).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHAT_HOST_PROTOCOL_VERSION } from "@omp-app/contracts/chat-host";
import { adoptRunningHosts, handBackHosts } from "./detached-process";
import type { OmpProcess } from "./omp-process";

const dirs: string[] = [];
const listeners: Bun.UnixSocketListener<undefined>[] = [];

afterEach(async () => {
  for (const listener of listeners.splice(0)) listener.stop(true);
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function hostsDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "omp-d2-unit-"));
  dirs.push(dir);
  return dir;
}

interface FakeHost {
  readonly id: string;
  /** Each line a server sent, parsed. */
  readonly received: { method?: string }[];
  readonly socketPath: string;
}

/**
 * A host on `socketPath` that says hello on each connection (unless `silent`), then sends `after`. Asked to hand back,
 * it answers and closes its link and its socket unless `keepsRunning`, as a host finishing a turn does.
 */
function fakeHost(
  socketPath: string,
  options: {
    readonly protocol?: number;
    readonly silent?: boolean;
    readonly keepsRunning?: boolean;
    readonly after?: readonly string[];
  } = {},
): FakeHost {
  const id = crypto.randomUUID();
  const received: { method?: string }[] = [];
  const hello = {
    kind: "hello",
    protocol: options.protocol ?? CHAT_HOST_PROTOCOL_VERSION,
    ompVersion: "0.0.0-test",
    methods: ["replay_live", "hand_back"],
    session: { id, file: join(socketPath, "..", `${id}.jsonl`), cwd: "/tmp" },
    pid: 0,
  };
  let partial = "";
  const listener = Bun.listen({
    unix: socketPath,
    socket: {
      open(socket) {
        if (options.silent) return;
        socket.write(`${JSON.stringify(hello)}\n${(options.after ?? []).join("")}`);
      },
      data(socket, data) {
        partial += new TextDecoder().decode(data);
        let newline = partial.indexOf("\n");
        while (newline !== -1) {
          const line = JSON.parse(partial.slice(0, newline)) as { id?: string; method?: string };
          partial = partial.slice(newline + 1);
          newline = partial.indexOf("\n");
          received.push(line);
          if (line.method !== "hand_back") continue;
          socket.write(
            `${JSON.stringify({ kind: "response", id: line.id, ok: true, result: { handedBack: true } })}\n`,
          );
          if (!options.keepsRunning) {
            socket.end();
            listener.stop(true);
          }
        }
      },
    },
  });
  listeners.push(listener);
  return { id, received, socketPath };
}

async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(20);
  }
}

describe("adoptRunningHosts", () => {
  test("takes over a host on this protocol, asks one on another to hand back, and clears a dead socket", async () => {
    const dir = await hostsDir();
    const current = fakeHost(join(dir, "a.sock"));
    const older = fakeHost(join(dir, "b.sock"), { protocol: CHAT_HOST_PROTOCOL_VERSION + 1 });
    const dead = join(dir, "c.sock");
    await writeFile(dead, "");
    await writeFile(`${dead}.log`, "the log of a host that is gone");
    const adopted: string[] = [];
    const handingBack: string[] = [];

    const found = await adoptRunningHosts({
      hostsDir: dir,
      protocol: CHAT_HOST_PROTOCOL_VERSION,
      adopt: (process, hello) => {
        adopted.push(hello.session.id);
        void process.release?.();
      },
      handingBack: (threadId) => handingBack.push(threadId),
    });

    expect(found).toEqual({ adopted: 1, handedBack: 1 });
    expect(adopted).toEqual([current.id]);
    expect(handingBack).toEqual([older.id]);
    await until(() => older.received.some((line) => line.method === "hand_back"));
    expect(current.received.some((line) => line.method === "hand_back")).toBe(false);
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(`${dead}.log`)).toBe(false);
  });

  test("leaves a socket whose host says no hello (one another server holds)", async () => {
    const dir = await hostsDir();
    const held = fakeHost(join(dir, "a.sock"), { silent: true });
    const found = await adoptRunningHosts({
      hostsDir: dir,
      protocol: CHAT_HOST_PROTOCOL_VERSION,
      adopt: () => {
        throw new Error("a held host is not taken over");
      },
      handingBack: () => {
        throw new Error("a held host is not asked to hand back");
      },
    });
    expect(found).toEqual({ adopted: 0, handedBack: 0 });
    expect(existsSync(held.socketPath)).toBe(true);
  }, 10_000);
});

describe("handBackHosts", () => {
  test("a host that hands back counts as handed back; one still finishing its turn is let go of and reported", async () => {
    const dir = await hostsDir();
    const idle = fakeHost(join(dir, "a.sock"));
    const busy = fakeHost(join(dir, "b.sock"), { keepsRunning: true });
    let asked = 0;

    const taken = await handBackHosts({
      hostsDir: dir,
      waitMs: 500,
      onAsked: (count) => {
        asked = count;
      },
    });

    expect(asked).toBe(2);
    expect(taken).toEqual({ handedBack: 1, finishing: 1 });
    for (const host of [idle, busy]) {
      expect(host.received.filter((line) => line.method === "hand_back").length).toBe(1);
    }
  });

  test("asks nothing of an empty or missing folder", async () => {
    let asked = false;
    const taken = await handBackHosts({
      hostsDir: join(await hostsDir(), "none"),
      waitMs: 100,
      onAsked: () => {
        asked = true;
      },
    });
    expect(taken).toEqual({ handedBack: 0, finishing: 0 });
    expect(asked).toBe(false);
  });
});

describe("an attached host's output", () => {
  test("a client that listens later reads the host's hello, never what came between", async () => {
    const dir = await hostsDir();
    fakeHost(join(dir, "a.sock"), {
      after: [`${JSON.stringify({ kind: "event", seq: 1, event: { type: "agent_start" } })}\n`],
    });
    let attached: OmpProcess | undefined;
    await adoptRunningHosts({
      hostsDir: dir,
      protocol: CHAT_HOST_PROTOCOL_VERSION,
      adopt: (process) => {
        attached = process;
      },
      handingBack: () => undefined,
    });
    if (attached === undefined) throw new Error("not attached");
    await Bun.sleep(100);

    const read: string[] = [];
    const decoder = new TextDecoder();
    attached.onChunk((chunk: Uint8Array) => read.push(decoder.decode(chunk, { stream: true })));
    const lines = read.join("").split("\n").filter(Boolean);
    expect(lines.map((line) => (JSON.parse(line) as { kind: string }).kind)).toEqual(["hello"]);

    await attached.release?.();
  });
});
