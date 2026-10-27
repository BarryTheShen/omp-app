/**
 * The chat host's dialogs (SDK plan H5.2d), end to end on the fake model provider: a test extension opens omp's dialogs
 * through the host's UI context, the test answers them as the app would, and the extension reports what it got as a
 * notice. Runs from source and compiled (`sdk-chat-host-harness.ts`).
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { HostRequest } from "../../src/chat-host/client";
import { type Chat, chatHostChats, PROGRAMS, realTest } from "./sdk-chat-host-harness";

/** `/dialogs <kind>` opens one dialog and reports the answer omp got as a notice. */
const EXTENSION = `
export default function (pi) {
  pi.registerCommand("dialogs", {
    description: "Opens one dialog for the chat host's tests",
    handler: async (args, ctx) => {
      const report = (text) => ctx.ui.notify(text, "info");
      switch (args.trim()) {
        case "confirm":
          report("confirmed " + (await ctx.ui.confirm("Run the check?", "It takes a minute")));
          return;
        case "select":
          report("picked " + (await ctx.ui.select("Colour", ["red", { label: "blue", description: "like the sky" }], { initialIndex: 1 })));
          return;
        case "input":
          report("typed " + (await ctx.ui.input("Name", "your name")));
          return;
        case "editor":
          report("edited " + (await ctx.ui.editor("Message", "draft")));
          return;
        case "timeout":
          report("timed out with " + (await ctx.ui.select("Quick", ["a", "b"], { timeout: 300 })));
          return;
        case "approve":
          report("approved " + JSON.stringify(await ctx.ui.approve({
            full: "Run ls?",
            compact: "ls",
            session: "Approve for this session",
            grants: [{ scope: "folder", label: "Approve Directory: ~/src", alwaysLabel: "Always Approve Directory: ~/src" }],
          })));
          return;
        case "ask":
          if (!ctx.ui.askDialog) {
            report("no ask dialog");
            return;
          }
          report("asked " + JSON.stringify(await ctx.ui.askDialog([
            { id: "colour", question: "Which colour?", options: [{ label: "red" }, { label: "blue" }] },
          ])));
          return;
        case "show":
          ctx.ui.setStatus("build", "Running");
          ctx.ui.setWidget("build", ["step 1"]);
          ctx.ui.setTitle("Build");
          ctx.ui.setEditorText("draft text");
          report("shown");
          return;
      }
    },
  });
}
`;

const chats = chatHostChats();
afterEach(() => chats.stopAll(), 60_000);

/** A chat with the test extension; `answer` plays the app, and every request it got is kept in order. */
async function chatWithDialogs(
  command: readonly string[],
  answer: (request: HostRequest) => unknown,
) {
  const chat = await chats.start(command, {
    agentFiles: { "extensions/dialogs.ts": EXTENSION },
    nativeDiscovery: true,
  });
  const asked: HostRequest[] = [];
  chat.client.onRequest(async (request) => {
    asked.push(request);
    return answer(request);
  });
  await chat.client.hello;
  return { chat, asked };
}

/** Runs `/dialogs <kind>` and returns the notice the extension reports. */
async function run(chat: Chat, kind: string): Promise<string> {
  const before = chat.events.length;
  await chat.client.request("prompt", { text: `/dialogs ${kind}` });
  const notice = await chat.next(
    (event) =>
      event.type === "ui_notify" &&
      chat.events.findIndex((entry) => entry.event === event) >= before,
  );
  return notice.type === "ui_notify" ? notice.message : "";
}

describe("the chat host's dialogs", () => {
  for (const program of PROGRAMS) {
    const programTest = program.command === undefined ? test.skip : realTest;
    const command = program.command ?? [];

    programTest(
      `${program.name}: each dialog reaches the app with omp's fields, and the app's answer reaches the extension`,
      async () => {
        const { chat, asked } = await chatWithDialogs(command, (request) => {
          switch (request.method) {
            case "ui.confirm":
              return { confirmed: true };
            case "ui.select":
              return { value: "blue" };
            case "ui.input":
              return { value: "Alex" };
            default:
              return { cancelled: true };
          }
        });
        expect(await run(chat, "confirm")).toBe("confirmed true");
        expect(await run(chat, "select")).toBe("picked blue");
        expect(await run(chat, "input")).toBe("typed Alex");
        expect(await run(chat, "editor")).toBe("edited undefined");
        expect(asked.map(({ method, params }) => ({ method, params }))).toEqual([
          {
            method: "ui.confirm",
            params: { title: "Run the check?", message: "It takes a minute" },
          },
          {
            method: "ui.select",
            params: {
              title: "Colour",
              options: ["red", "blue"],
              optionDetails: [{}, { description: "like the sky" }],
              initialIndex: 1,
            },
          },
          { method: "ui.input", params: { title: "Name", placeholder: "your name" } },
          { method: "ui.editor", params: { title: "Message", prefill: "draft" } },
        ]);
      },
      60_000,
    );

    programTest(
      `${program.name}: a dialog omp times out closes on the app too, and the extension gets the default`,
      async () => {
        const late = Promise.withResolvers<unknown>();
        const { chat, asked } = await chatWithDialogs(command, () => late.promise);
        expect(await run(chat, "timeout")).toBe("timed out with undefined");
        const cancel = await chat.next((event) => event.type === "ui_cancel");
        expect(cancel).toEqual({ type: "ui_cancel", requestId: asked[0]?.id ?? "" });
        expect(asked[0]?.params).toMatchObject({ timeout: 300 });
        late.resolve({ value: "a" });
      },
      60_000,
    );

    programTest(
      `${program.name}: an approval carries omp's typed choices, and a typed grant comes back`,
      async () => {
        const { chat, asked } = await chatWithDialogs(command, () => ({
          grant: "folder",
          always: true,
        }));
        expect(await run(chat, "approve")).toBe('approved {"grant":"folder","always":true}');
        expect(asked[0]).toMatchObject({
          method: "ui.approve",
          params: {
            prompt: {
              full: "Run ls?",
              compact: "ls",
              session: "Approve for this session",
              grants: [{ scope: "folder", label: "Approve Directory: ~/src" }],
            },
          },
        });
      },
      60_000,
    );

    programTest(
      `${program.name}: the ask dialog is offered only once the app turns it on`,
      async () => {
        const { chat, asked } = await chatWithDialogs(command, () => ({
          answers: [{ id: "colour", selectedOptions: ["blue"] }],
        }));
        expect(await run(chat, "ask")).toBe("no ask dialog");
        expect(await chat.client.request("set_ask_dialog", { enabled: true })).toEqual({
          enabled: true,
        });
        const reported = await run(chat, "ask");
        expect(JSON.parse(reported.slice("asked ".length))).toMatchObject({
          kind: "submit",
          results: [{ id: "colour", selectedOptions: ["blue"], multi: false }],
        });
        expect(asked.map((request) => request.method)).toEqual(["ui.ask"]);
      },
      60_000,
    );

    programTest(
      `${program.name}: status, widget, title and editor text reach the app as events`,
      async () => {
        const { chat } = await chatWithDialogs(command, () => ({ cancelled: true }));
        expect(await run(chat, "show")).toBe("shown");
        // omp's own extensions keep their widgets too (`autoresearch`); only the test extension's are checked here.
        const shown = chat.events
          .map((entry) => entry.event)
          .filter(
            (event) =>
              (event.type === "ui_status" && event.statusKey === "build") ||
              (event.type === "ui_widget" && event.widgetKey === "build") ||
              event.type === "ui_title" ||
              event.type === "ui_editor_text",
          );
        expect(shown).toEqual([
          { type: "ui_status", statusKey: "build", statusText: "Running" },
          { type: "ui_widget", widgetKey: "build", widgetLines: ["step 1"] },
          { type: "ui_title", title: "Build" },
          { type: "ui_editor_text", text: "draft text" },
        ]);
      },
      60_000,
    );
  }
});
