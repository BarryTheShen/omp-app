/**
 * The viewers' preferences, `!` runs and session switches on the server's chat session port (SDK plan H5.3c), end to
 * end through the port's runtime on real chat hosts. Runs from source and compiled (`sdk-chat-session-harness.ts`).
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { ChatSessionEvent, SessionFilePath, ThreadId } from "@omp-app/contracts";
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

/** Sends a prompt and waits for its result; resolves with the payloads its turn added to the chat's stream. */
async function turn(
  setup: PortSetup,
  threadId: ThreadId,
  text: string,
): Promise<ChatSessionEvent[]> {
  const mark = streamOf(setup, threadId).length;
  await setup.runtime.request({ threadId, method: "prompt", params: { text } }, call());
  await until(() =>
    streamOf(setup, threadId)
      .slice(mark)
      .find((payload) => payload.kind === "event" && payload.event.type === "prompt_result"),
  );
  return streamOf(setup, threadId).slice(mark);
}

/** Whether the turn's message updates carried the message so far (`full`), not only the increment (`delta`). */
function updatesCarryTheMessage(payloads: readonly ChatSessionEvent[]): boolean {
  const update = payloads.find(
    (payload) => payload.kind === "event" && payload.event.type === "message_update",
  );
  if (update?.kind !== "event" || update.event.type !== "message_update") {
    throw new Error("the turn sent no message update");
  }
  return "content" in update.event.message;
}

describe("viewers, shell runs and session switches on the chat session port", () => {
  for (const program of PROGRAMS) {
    const programTest = program.command === undefined ? test.skip : realTest;
    const command = program.command ?? [];

    programTest(
      `${program.name}: the viewers' levels and message updates reach the host as one, and a viewer leaving is taken out`,
      async () => {
        const setup = await ports.start(command);
        const { runtime } = setup;
        const { threadId } = await runtime.open({ folderPath: setup.folder, start: "new" }, call());
        await runtime.open({ threadId }, call("connection-2"));

        expect(
          await runtime.setSubagentSubscription({ threadId, level: "progress" }, call()),
        ).toEqual({ level: "progress" });
        expect(
          await runtime.setSubagentSubscription(
            { threadId, level: "events" },
            call("connection-2"),
          ),
        ).toEqual({ level: "events" });

        expect(
          await runtime.setEventOptions({ threadId, messageUpdates: "delta" }, call()),
        ).toEqual({
          messageUpdates: "delta",
        });
        expect(updatesCarryTheMessage(await turn(setup, threadId, "hello"))).toBe(false);

        expect(
          await runtime.setEventOptions({ threadId, messageUpdates: "full" }, call("connection-2")),
        ).toEqual({ messageUpdates: "full" });
        expect(updatesCarryTheMessage(await turn(setup, threadId, "hello"))).toBe(true);

        // The second viewer leaves: the host is told the first one's choice again, with nothing asked anew.
        await runtime.releaseConnection("connection-2");
        expect(updatesCarryTheMessage(await turn(setup, threadId, "hello"))).toBe(false);
      },
      90_000,
    );

    programTest(
      `${program.name}: a ! run is published to the chat's stream as running and ended, with omp's output`,
      async () => {
        const setup = await ports.start(command);
        const { runtime } = setup;
        const { threadId } = await runtime.open({ folderPath: setup.folder, start: "new" }, call());
        const mark = streamOf(setup, threadId).length;
        const result = await runtime.request(
          { threadId, method: "bash", params: { command: "echo shell-run" } },
          call(),
        );
        expect(result).toMatchObject({ output: "shell-run\n", cancelled: false });
        const runs = streamOf(setup, threadId)
          .slice(mark)
          .filter((payload) => payload.kind === "shell");
        expect(runs).toMatchObject([
          { kind: "shell", method: "bash", input: "echo shell-run", status: "running" },
          {
            kind: "shell",
            method: "bash",
            input: "echo shell-run",
            status: "ended",
            result: { output: "shell-run\n" },
          },
        ]);
      },
      90_000,
    );

    programTest(
      `${program.name}: a new chat moves the chat to its new id, and the old id still names it`,
      async () => {
        const setup = await ports.start(command);
        const { runtime, registry } = setup;
        const opened = await runtime.open({ folderPath: setup.folder, start: "new" }, call());
        await turn(setup, opened.threadId, "hello");

        expect(
          await runtime.request(
            { threadId: opened.threadId, method: "new_session", params: {} },
            call(),
          ),
        ).toEqual({ cancelled: false });
        const state = (await runtime.request(
          { threadId: opened.threadId, method: "get_state", params: {} },
          call(),
        )) as { sessionId: ThreadId; sessionFile: SessionFilePath };
        expect(state.sessionId).not.toBe(opened.threadId);

        // The stream carries on under the new id, its history and the move included.
        const stream = streamOf(setup, opened.threadId);
        expect(stream.at(-1)).toEqual({
          kind: "moved",
          threadId: state.sessionId,
          sessionFile: state.sessionFile,
        });
        expect(runtime.subscribe({ threadId: opened.threadId })).toEqual(
          runtime.subscribe({ threadId: state.sessionId }),
        );
        expect(
          stream.some(
            (payload) => payload.kind === "event" && payload.event.type === "prompt_result",
          ),
        ).toBe(true);
        expect(registry.has(state.sessionId)).toBe(true);
        expect(registry.has(opened.threadId)).toBe(false);
        expect(runtime.watcherCount(opened.threadId)).toBe(1);
      },
      90_000,
    );
  }
});
