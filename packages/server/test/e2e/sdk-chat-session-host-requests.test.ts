/**
 * The chat host's requests on the server's chat session port (SDK plan H5.3b), end to end: dialogs from the dialogs test
 * extension, the app's tools called by the fake model (`call_tool`), and the UI state, through the port's runtime on
 * real chat hosts. Runs from source and compiled (`sdk-chat-session-harness.ts`).
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { AppFailure, ChatSessionEvent, ThreadId } from "@omp-app/contracts";
import { DIALOGS_EXTENSION } from "./sdk-chat-host-dialogs-extension";
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

const WEATHER = {
  name: "weather",
  description: "Says the weather in a city",
  parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
};
const CLOCK = {
  name: "clock",
  description: "Says the time",
  parameters: { type: "object", properties: {} },
};

/** A new chat on the port, with the dialogs extension. */
async function dialogChat(command: readonly string[]) {
  const setup = await ports.start(command, {
    agentFiles: { "extensions/dialogs.ts": DIALOGS_EXTENSION },
    nativeDiscovery: true,
  });
  const opened = await setup.runtime.open({ folderPath: setup.folder, start: "new" }, call());
  setup.files.set(opened.threadId, opened.sessionFile);
  return { setup, threadId: opened.threadId };
}

/** Sends a prompt without waiting: a dialog's command answers only once its dialog is. */
function prompt(setup: PortSetup, threadId: ThreadId, text: string): Promise<unknown> {
  const sent = setup.runtime.request({ threadId, method: "prompt", params: { text } }, call());
  sent.catch(() => undefined);
  return sent;
}

/** The first payload on the chat's stream, from the `mark`th on, that `match` takes. */
function nextOnStream(
  setup: PortSetup,
  threadId: ThreadId,
  mark: number,
  match: (payload: ChatSessionEvent) => boolean,
): Promise<ChatSessionEvent> {
  return until(() => streamOf(setup, threadId).slice(mark).find(match));
}

/** The notice the dialogs extension reports, from the `mark`th payload on. */
async function notice(setup: PortSetup, threadId: ThreadId, mark: number): Promise<string> {
  const found = await nextOnStream(
    setup,
    threadId,
    mark,
    (payload) => payload.kind === "event" && payload.event.type === "ui_notify",
  );
  return found.kind === "event" && found.event.type === "ui_notify" ? found.event.message : "";
}

function failureOf(run: () => unknown): AppFailure["appError"] {
  try {
    run();
  } catch (error) {
    return (error as AppFailure).appError;
  }
  throw new Error("the call succeeded");
}

/**
 * Has the fake model call a tool (`call_tool`) and waits for the turn to end. Resolves with the tool the app was asked to
 * run (answered with `<name> answered`), or undefined when omp had no such tool to give the app: the session's active
 * tools do not list the app's, so a call is how to tell.
 */
async function callTool(
  setup: PortSetup,
  threadId: ThreadId,
  name: string,
  args: Record<string, unknown>,
): Promise<string | undefined> {
  const mark = streamOf(setup, threadId).length;
  prompt(setup, threadId, `call_tool ${name} ${JSON.stringify(args)}`);
  const ended = (payload: ChatSessionEvent) =>
    payload.kind === "event" && payload.event.type === "prompt_result";
  const next = await nextOnStream(
    setup,
    threadId,
    mark,
    (payload) => payload.kind === "host_request" || ended(payload),
  );
  if (next.kind !== "host_request") return undefined;
  setup.runtime.answer({
    threadId,
    id: next.request.id,
    answer: { content: [{ type: "text", text: `${name} answered` }] },
  });
  await nextOnStream(setup, threadId, mark, ended);
  return next.request.method === "tool.call" ? next.request.params.toolName : undefined;
}

describe("the chat host's requests on the chat session port", () => {
  for (const program of PROGRAMS) {
    const programTest = program.command === undefined ? test.skip : realTest;
    const command = program.command ?? [];

    programTest(
      `${program.name}: a dialog waits on the port until answered, and an answer that does not fit is refused`,
      async () => {
        const { setup, threadId } = await dialogChat(command);
        const { runtime } = setup;
        const mark = streamOf(setup, threadId).length;
        const sent = prompt(setup, threadId, "/dialogs confirm");
        const asked = await nextOnStream(
          setup,
          threadId,
          mark,
          (payload) => payload.kind === "host_request",
        );
        if (asked.kind !== "host_request") throw new Error("not a host request");
        expect(asked.request).toMatchObject({
          method: "ui.confirm",
          params: { title: "Run the check?", message: "It takes a minute" },
        });
        expect(runtime.openRequests({ threadId })).toEqual([
          { seq: expect.any(Number), request: asked.request },
        ]);

        expect(
          failureOf(() =>
            runtime.answer({ threadId, id: asked.request.id, answer: { value: "yes" } }),
          ),
        ).toMatchObject({ code: "invalid_args" });
        expect(runtime.openRequests({ threadId })).toHaveLength(1);

        runtime.answer({ threadId, id: asked.request.id, answer: { confirmed: true } });
        expect(runtime.openRequests({ threadId })).toEqual([]);
        expect(await notice(setup, threadId, mark)).toBe("confirmed true");
        await sent;
        expect(
          failureOf(() =>
            runtime.answer({ threadId, id: asked.request.id, answer: { confirmed: true } }),
          ),
        ).toMatchObject({ code: "not_found" });
      },
      90_000,
    );

    programTest(
      `${program.name}: omp's timeout closes the open request, and the extension gets the default`,
      async () => {
        const { setup, threadId } = await dialogChat(command);
        const mark = streamOf(setup, threadId).length;
        prompt(setup, threadId, "/dialogs timeout");
        expect(await notice(setup, threadId, mark)).toBe("timed out with undefined");
        await nextOnStream(
          setup,
          threadId,
          mark,
          (payload) => payload.kind === "event" && payload.event.type === "ui_cancel",
        );
        expect(setup.runtime.openRequests({ threadId })).toEqual([]);
      },
      90_000,
    );

    programTest(
      `${program.name}: the UI state keeps the latest status, widget and title, and a cleared status goes`,
      async () => {
        const { setup, threadId } = await dialogChat(command);
        // omp's own extensions keep widgets too (`autoresearch`): only the test extension's keys are read.
        const ours = () =>
          setup.runtime
            .uiState({ threadId })
            .map(({ event }) => event)
            .filter(
              (event) =>
                (event.type === "ui_status" && event.statusKey === "build") ||
                (event.type === "ui_widget" && event.widgetKey === "build") ||
                event.type === "ui_title",
            );
        let mark = streamOf(setup, threadId).length;
        prompt(setup, threadId, "/dialogs show");
        expect(await notice(setup, threadId, mark)).toBe("shown");
        expect(ours()).toEqual([
          { type: "ui_status", statusKey: "build", statusText: "Running" },
          { type: "ui_widget", widgetKey: "build", widgetLines: ["step 1"] },
          { type: "ui_title", title: "Build" },
        ]);

        mark = streamOf(setup, threadId).length;
        prompt(setup, threadId, "/dialogs clear");
        expect(await notice(setup, threadId, mark)).toBe("cleared");
        expect(ours()).toEqual([{ type: "ui_title", title: "Build" }]);
      },
      90_000,
    );

    programTest(
      `${program.name}: two owners' tools are merged, a call is answered through the port, and a closed connection takes its tools away`,
      async () => {
        const { setup, threadId } = await dialogChat(command);
        const { runtime } = setup;
        await runtime.open({ threadId }, call("connection-2"));
        expect(
          await runtime.request(
            {
              threadId,
              method: "set_host_tools",
              params: { tools: [WEATHER] },
              registrationOwner: "panel",
            },
            call(),
          ),
        ).toEqual({ toolNames: ["weather"] });
        expect(
          await runtime.request(
            {
              threadId,
              method: "set_host_tools",
              params: { tools: [CLOCK] },
              registrationOwner: "tray",
            },
            call("connection-2"),
          ),
        ).toEqual({ toolNames: ["clock"] });
        // Both owners' tools reach the host as one set: the model can call either.
        expect(await callTool(setup, threadId, "clock", {})).toBe("clock");

        const mark = streamOf(setup, threadId).length;
        prompt(setup, threadId, 'call_tool weather {"city":"Paris"}');
        const asked = await nextOnStream(
          setup,
          threadId,
          mark,
          (payload) => payload.kind === "host_request",
        );
        if (asked.kind !== "host_request") throw new Error("not a host request");
        expect(asked.request).toMatchObject({
          method: "tool.call",
          params: { toolName: "weather", arguments: { city: "Paris" } },
        });
        runtime.answer({
          threadId,
          id: asked.request.id,
          answer: { content: [{ type: "text", text: "sunny in Paris" }] },
        });
        const reply = await nextOnStream(
          setup,
          threadId,
          mark,
          (payload) =>
            payload.kind === "event" &&
            payload.event.type === "message_end" &&
            JSON.stringify(payload.event.message).includes("tool said: sunny in Paris"),
        );
        expect(reply).toBeDefined();
        await nextOnStream(
          setup,
          threadId,
          mark,
          (payload) => payload.kind === "event" && payload.event.type === "prompt_result",
        );

        // The closed connection's tool leaves the chat; the other connection's stays.
        await runtime.releaseConnection("connection-1");
        expect(await callTool(setup, threadId, "weather", { city: "Paris" })).toBeUndefined();
        expect(await callTool(setup, threadId, "clock", {})).toBe("clock");
        await expect(
          runtime.request(
            {
              threadId,
              method: "set_host_tools",
              params: { tools: [WEATHER] },
              registrationOwner: "panel",
            },
            call("connection-3"),
          ),
        ).rejects.toMatchObject({ appError: { code: "not_found" } });
      },
      90_000,
    );

    programTest(
      `${program.name}: a restart closes the open requests and registers the app's tools again`,
      async () => {
        const { setup, threadId } = await dialogChat(command);
        const { runtime } = setup;
        await runtime.request(
          {
            threadId,
            method: "set_host_tools",
            params: { tools: [WEATHER] },
            registrationOwner: "panel",
          },
          call(),
        );
        // The chat has a file to resume from once its first turn is saved.
        let mark = streamOf(setup, threadId).length;
        prompt(setup, threadId, "hello");
        await nextOnStream(
          setup,
          threadId,
          mark,
          (payload) => payload.kind === "event" && payload.event.type === "prompt_result",
        );

        mark = streamOf(setup, threadId).length;
        prompt(setup, threadId, "/dialogs confirm");
        const asked = await nextOnStream(
          setup,
          threadId,
          mark,
          (payload) => payload.kind === "host_request",
        );
        if (asked.kind !== "host_request") throw new Error("not a host request");
        await runtime.restart({ threadId });
        expect(runtime.openRequests({ threadId })).toEqual([]);
        expect(
          failureOf(() =>
            runtime.answer({ threadId, id: asked.request.id, answer: { confirmed: true } }),
          ),
        ).toMatchObject({ code: "not_found" });
        expect(await callTool(setup, threadId, "weather", { city: "Paris" })).toBe("weather");
      },
      90_000,
    );
  }
});
