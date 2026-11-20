import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentEvent } from "./agent";

let dir: string | null = null;
let stop: (() => void) | null = null;
afterEach(async () => {
  stop?.();
  stop = null;
  if (dir !== null) await rm(dir, { recursive: true, force: true });
  dir = null;
});

const ask = {
  id: "0123456789abcdef",
  path: "/home/p/workspace",
  write: true,
  why: "Read the build logs",
  server: "server.example",
};
/** The guard's state, off: an agent that did not turn access on would turn an on guard off (after a restart). */
const guardState = (asks: object[], shared: object[] = []) => ({
  on: false,
  until: null,
  sessions: 0,
  hostKey: "/x",
  reviewPending: false,
  changed: [],
  removed: [],
  sudoUntil: null,
  asks,
  shared,
});

test("the person's agent passes on the guard's folder requests and shared folders, tells each request once, and takes the person's answers to the guard (PLAN §7d)", async () => {
  dir = await mkdtemp(join(tmpdir(), "omp-agent-folders-"));
  const guardSocket = join(dir, "guard.sock");
  // A guard: answers every request with ok and notes it; a watch connection gets the lines the test sends.
  const requests: Record<string, unknown>[] = [];
  let watcher: { write(line: string): unknown } | null = null;
  const listener = Bun.listen<{ buffer: string }>({
    unix: guardSocket,
    socket: {
      open(socket) {
        socket.data = { buffer: "" };
      },
      data(socket, chunk) {
        socket.data.buffer += new TextDecoder().decode(chunk);
        const at = socket.data.buffer.indexOf("\n");
        if (at === -1) return;
        const request = JSON.parse(socket.data.buffer.slice(0, at)) as Record<string, unknown>;
        if (request.op === "watch") {
          watcher = socket;
          return;
        }
        requests.push(request);
        socket.end(`ok ${JSON.stringify(guardState([]))}\n`);
      },
    },
  });
  stop = () => listener.stop(true);
  const told: string[] = [];
  const agent = await Agent.open({
    dataDir: join(dir, "data"),
    runtimeDir: join(dir, "run"),
    guardSocket,
    tellTerminals: async (text) => told.push(text),
  });
  const events: AgentEvent[] = [];
  agent.watch((event) => events.push(event));
  await agent.start();
  const send = async (state: object) => {
    for (let tries = 0; tries < 50 && watcher === null; tries += 1) await Bun.sleep(20);
    watcher?.write(`${JSON.stringify({ type: "state", state })}\n`);
    await Bun.sleep(100);
  };

  // A request: watchers hear the folders, the person is told once, also when the guard says it again.
  await send(guardState([ask]));
  await send(guardState([ask]));
  expect(agent.folders.asks).toEqual([ask]);
  expect(events.filter((event) => event.type === "folders")).toHaveLength(1);
  expect(told).toEqual([
    "An agent asks to read and change /home/p/workspace: Read the build logs. Allow or deny it in Agent access.",
  ]);

  // The person's answers reach the guard, with the linked server for the dialog when there is one.
  expect(await agent.allowFolder(4242, ask.id, false)).toBeNull();
  expect(await agent.denyFolder(ask.id)).toBeNull();
  expect(await agent.removeFolder("/home/p/workspace")).toBeNull();
  expect(requests).toEqual([
    { op: "allow-folder", pid: 4242, id: ask.id, write: false },
    { op: "deny-folder", id: ask.id },
    { op: "remove-folder", path: "/home/p/workspace" },
  ]);

  // Answered: the folder is shared; a guard of before (no folders in its state) counts as none.
  const shared = {
    path: "/home/p/workspace",
    place: "workspace",
    write: false,
    server: "server.example",
    grantedAt: "2026-11-19T20:00:00.000Z",
  };
  await send(guardState([], [shared]));
  expect(agent.folders).toEqual({ asks: [], shared: [shared] });
  const { asks: _asks, shared: _shared, ...older } = guardState([]);
  await send(older);
  expect(agent.folders).toEqual({ asks: [], shared: [] });
  // The same request again later is a new one to tell (its id was forgotten once answered).
  await send(guardState([ask]));
  expect(told).toHaveLength(2);
  await agent.stop();
});
