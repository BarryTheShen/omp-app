/**
 * The chat host on a Unix socket (D2 step 1, `D2-step1-plan.md`), end to end on the fake model: a chat keeps running
 * when its server goes, answers the server that comes back, and hands the chat back once no server has come for a
 * while. Runs from source and compiled (`sdk-chat-host-harness.ts`).
 */
import { afterEach, describe, expect } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CHAT_HOST_CHAT_ARG } from "@omp-app/contracts/chat-host";
import { ChatHostClient, type LineDuplex } from "../../src/chat-host/client";
import { chatHostChats, PROGRAMS, realTest } from "./sdk-chat-host-harness";

const chats = chatHostChats();
const hosts: Bun.Subprocess[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) {
    host.kill("SIGKILL");
    await host.exited;
  }
  await chats.stopAll();
}, 60_000);

/** A server's connection to the host's socket, as the client's line duplex. */
async function connect(path: string): Promise<{ readonly duplex: LineDuplex; leave(): void }> {
  for (let tries = 0; tries < 200 && !existsSync(path); tries++) await Bun.sleep(50);
  const chunks = new Set<(chunk: Uint8Array) => void>();
  const closes = new Set<(cause?: unknown) => void>();
  const socket = await Bun.connect({
    unix: path,
    socket: {
      data(_socket, data) {
        for (const listener of chunks) listener(data);
      },
      close() {
        for (const listener of closes) listener();
      },
    },
  });
  return {
    duplex: {
      writeLine: (line) => {
        socket.write(line);
      },
      onChunk(listener) {
        chunks.add(listener);
        return () => chunks.delete(listener);
      },
      onClose(listener) {
        closes.add(listener);
        return () => closes.delete(listener);
      },
    },
    leave: () => socket.end(),
  };
}

describe("the chat host on a socket", () => {
  for (const program of PROGRAMS) {
    const programTest = program.command === undefined ? () => undefined : realTest;
    const command = program.command ?? [];

    programTest(
      `${program.name}: it outlives its server, answers the next one, and hands the chat back after its wait`,
      async () => {
        const { home, folder, env } = await chats.prepare();
        const socket = join(home, "hosts", "chat.sock");
        const host = Bun.spawn([...command, CHAT_HOST_CHAT_ARG, "--model", "fake/fake-model"], {
          cwd: folder,
          env: { ...process.env, ...env, OMP_APP_HOST_SOCKET: socket, OMP_APP_HANDBACK_MS: "3000" },
          stdin: "ignore",
          stdout: "ignore",
          stderr: "inherit",
        });
        hosts.push(host);

        const first = await connect(socket);
        const client = new ChatHostClient(first.duplex);
        expect((await client.hello).kind).toBe("hello");
        const state = await client.request("get_state", {});
        expect(state.model?.id).toBe("fake-model");

        // The server goes: the chat keeps running.
        first.leave();
        await Bun.sleep(1_000);
        expect(host.exitCode).toBeNull();

        // A server comes back within the wait and is answered.
        const second = await connect(socket);
        const again = new ChatHostClient(second.duplex);
        expect((await again.request("get_state", {})).model?.id).toBe("fake-model");

        // It goes for good: after the wait the chat is handed back, the host ends cleanly and its socket is gone.
        second.leave();
        expect(await host.exited).toBe(0);
        expect(existsSync(socket)).toBe(false);
      },
      90_000,
    );
  }
});
