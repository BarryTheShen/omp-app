import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type HostSocket, openHostSocket } from "./socket";

/** A server connecting to the host: what it received, and how to write to it or leave. */
async function server(path: string) {
  let text = "";
  const closed = Promise.withResolvers<void>();
  const socket = await Bun.connect({
    unix: path,
    socket: {
      data(_socket, data) {
        text += new TextDecoder().decode(data);
      },
      close() {
        closed.resolve();
      },
    },
  });
  return {
    received: () => text,
    write: (line: string) => socket.write(line),
    leave: () => socket.end(),
    closed: closed.promise,
  };
}

/** Waits until `check` holds, for at most a second. */
async function until(check: () => boolean): Promise<void> {
  for (let tries = 0; tries < 100 && !check(); tries++) await Bun.sleep(10);
  expect(check()).toBe(true);
}

let folder = "";
let host: HostSocket | undefined;

afterEach(async () => {
  await host?.close();
  host = undefined;
  if (folder !== "") await rm(folder, { recursive: true, force: true });
});

async function open(): Promise<{ path: string; host: HostSocket }> {
  folder = await mkdtemp(join(tmpdir(), "omp-app-host-socket-"));
  const path = join(folder, "hosts", "chat.sock");
  host = await openHostSocket(path);
  return { path, host };
}

describe("openHostSocket", () => {
  test("the server's lines come through across its connections; a line cut off by one that ended is dropped", async () => {
    const { path, host } = await open();
    const reader = host.lines[Symbol.asyncIterator]();
    const first = await server(path);
    await host.firstConnection;
    first.write("one\ntw");
    expect((await reader.next()).value).toBe("one");
    first.leave();
    await until(() => !host.connected());

    const second = await server(path);
    await until(() => host.connected());
    second.write("three\n");
    expect((await reader.next()).value).toBe("three");
  });

  test("one server at a time: a second connection is closed at once, the first keeps working", async () => {
    const { path, host } = await open();
    const first = await server(path);
    await host.firstConnection;
    const second = await server(path);
    await second.closed;
    host.writer.write("still here");
    await host.writer.flush();
    await until(() => first.received() === "still here\n");
  });

  test("lines go to the connected server; those written with none connected are dropped", async () => {
    const { path, host } = await open();
    const first = await server(path);
    await host.firstConnection;
    host.writer.write("hello");
    await until(() => first.received() === "hello\n");
    first.leave();
    await until(() => !host.connected());
    host.writer.write("lost");
    await host.writer.flush();

    const second = await server(path);
    await until(() => host.connected());
    host.writer.write("again");
    await until(() => second.received() === "again\n");
  });

  test("the socket and its folder are the user's alone; closing ends the lines and removes the socket", async () => {
    const { path, host } = await open();
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(folder, "hosts"))).mode & 0o777).toBe(0o700);
    const reader = host.lines[Symbol.asyncIterator]();
    const pending = reader.next();
    await host.close();
    expect((await pending).done).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  test("a connection or a departure is told to listeners", async () => {
    const { path, host } = await open();
    const seen: boolean[] = [];
    host.onConnection((connected) => seen.push(connected));
    const first = await server(path);
    await host.firstConnection;
    first.leave();
    await until(() => seen.length === 2);
    expect(seen).toEqual([true, false]);
  });
});
