/**
 * The server's chat session port on the chat host (SDK plan H5.3a), end to end: the port's runtime over a process
 * registry that starts real chat hosts on the fake model, and the replay hub the browser reads. Runs from source and
 * compiled (`sdk-chat-host-harness.ts`, `sdk-chat-session-harness.ts`).
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { AppFailure } from "@omp-app/contracts";
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

/** Opens a new chat and finishes one turn, so omp has written the chat's file. */
async function chatWithOneTurn(setup: PortSetup) {
  const { runtime, folder, files } = setup;
  const opened = await runtime.open({ folderPath: folder, start: "new" }, call());
  files.set(opened.threadId, opened.sessionFile);
  await runtime.request(
    { threadId: opened.threadId, method: "prompt", params: { text: "hello" } },
    call(),
  );
  await until(() =>
    streamOf(setup, opened.threadId).find(
      (payload) => payload.kind === "event" && payload.event.type === "prompt_result",
    ),
  );
  return opened;
}

async function failureOf(promise: Promise<unknown>): Promise<AppFailure["appError"]> {
  try {
    await promise;
  } catch (error) {
    return (error as AppFailure).appError;
  }
  throw new Error("the request succeeded");
}

describe("the chat session port on the chat host", () => {
  for (const program of PROGRAMS) {
    const programTest = program.command === undefined ? test.skip : realTest;
    const command = program.command ?? [];

    programTest(
      `${program.name}: a new chat opens under its own id, streams its turn on its stream, and maps the host's refusals`,
      async () => {
        const setup = await ports.start(command);
        const { runtime } = setup;
        const opened = await chatWithOneTurn(setup);
        expect(opened.threadId.startsWith("provisional-")).toBe(false);
        expect(opened.methods).toContain("prompt");
        const state = await runtime.request(
          { threadId: opened.threadId, method: "get_state", params: {} },
          call(),
        );
        expect(state).toMatchObject({
          sessionId: opened.threadId,
          sessionFile: opened.sessionFile,
        });

        const stream = streamOf(setup, opened.threadId);
        // The events before the chat's own id was known were held, then published on its stream, the ready first.
        expect(stream[0]).toMatchObject({ kind: "process" });
        expect(
          stream.some((payload) => payload.kind === "process" && payload.status === "ready"),
        ).toBe(true);
        expect(
          stream.some(
            (payload) => payload.kind === "event" && payload.event.type === "message_end",
          ),
        ).toBe(true);

        expect(
          await failureOf(
            runtime.request(
              { threadId: opened.threadId, method: "set_session_name", params: {} },
              call(),
            ),
          ),
        ).toMatchObject({ code: "invalid_args" });
        expect(
          await failureOf(
            runtime.request(
              {
                threadId: opened.threadId,
                method: "approve_plan",
                params: { planFilePath: "local://PLAN.md" },
              },
              call(),
            ),
          ),
        ).toMatchObject({
          code: "omp_error",
          omp: { command: "approve_plan", code: "plan_mode_off" },
        });
      },
      90_000,
    );

    programTest(
      `${program.name}: a prompt that comes while a reply streams, naming no delivery, is refused as omp's busy agent, in plain words`,
      async () => {
        const setup = await ports.start(command);
        const { runtime, folder, files } = setup;
        const opened = await runtime.open({ folderPath: folder, start: "new" }, call());
        files.set(opened.threadId, opened.sessionFile);
        const threadId = opened.threadId;
        await runtime.request(
          { threadId, method: "prompt", params: { text: "stream_held" } },
          call(),
        );
        await until(() =>
          streamOf(setup, threadId).find(
            (payload) => payload.kind === "event" && payload.event.type === "message_update",
          ),
        );
        const refused = await failureOf(
          runtime.request({ threadId, method: "prompt", params: { text: "hi" } }, call()),
        );
        expect(refused).toMatchObject({ code: "agent_busy", retryable: true });
        expect(refused.message).not.toContain("Agent is already processing");
        await runtime.request({ threadId, method: "abort", params: {} }, call());
        await until(() =>
          streamOf(setup, threadId).find(
            (payload) => payload.kind === "event" && payload.event.type === "session_settled",
          ),
        );
        // The refused prompt has no result of its own: only the held reply's.
        expect(
          streamOf(setup, threadId).filter(
            (payload) => payload.kind === "event" && payload.event.type === "prompt_result",
          ),
        ).toHaveLength(1);
      },
      60_000,
    );

    programTest(
      `${program.name}: a chat whose process stopped opens again from its file, with its turn`,
      async () => {
        const setup = await ports.start(command);
        const { runtime, registry } = setup;
        const opened = await chatWithOneTurn(setup);
        await runtime.close({ threadId: opened.threadId }, call());
        await registry.stopIfUnwatched(opened.threadId, "opened");
        expect(registry.has(opened.threadId)).toBe(false);

        const again = await runtime.open({ threadId: opened.threadId }, call());
        expect(again).toMatchObject({ threadId: opened.threadId, sessionFile: opened.sessionFile });
        const state = await runtime.request(
          { threadId: opened.threadId, method: "get_state", params: {} },
          call(),
        );
        expect(state).toMatchObject({ messageCount: 2 });
      },
      90_000,
    );

    programTest(
      `${program.name}: two connections view a chat, and a closed connection lets only its views go`,
      async () => {
        const setup = await ports.start(command);
        const { runtime, registry } = setup;
        const opened = await runtime.open({ folderPath: setup.folder, start: "new" }, call());
        setup.files.set(opened.threadId, opened.sessionFile);
        await runtime.open({ threadId: opened.threadId }, call("connection-2"));
        expect(runtime.watcherCount(opened.threadId)).toBe(2);
        expect(registry.watcherCount(opened.threadId)).toBe(2);

        await runtime.releaseConnection("connection-1");
        expect(runtime.viewsOf(opened.threadId, "connection-1")).toBe(0);
        expect(runtime.viewsOf(opened.threadId, "connection-2")).toBe(1);
        expect(registry.watcherCount(opened.threadId)).toBe(1);
      },
      90_000,
    );

    programTest(
      `${program.name}: restart starts the chat again from its file, and a killed process is repaired before a request`,
      async () => {
        const setup = await ports.start(command);
        const { runtime, registry } = setup;
        const opened = await chatWithOneTurn(setup);
        const first = registry.get(opened.threadId)?.pid;
        await runtime.restart({ threadId: opened.threadId });
        const second = registry.get(opened.threadId)?.pid;
        expect(second).toBeDefined();
        expect(second).not.toBe(first);

        process.kill(second ?? 0, "SIGKILL");
        await until(() => (registry.get(opened.threadId)?.status === "exited" ? true : undefined));
        const state = await runtime.request(
          { threadId: opened.threadId, method: "get_state", params: {} },
          call(),
        );
        expect(state).toMatchObject({ sessionId: opened.threadId, messageCount: 2 });
        expect(registry.get(opened.threadId)?.pid).not.toBe(second);
      },
      90_000,
    );
  }
});
