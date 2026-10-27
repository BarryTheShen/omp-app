/**
 * The chat host's host tools and host URI schemes (SDK plan H5.2e), end to end on the fake model provider: the fake
 * model calls a tool the app registered (`call_tool <name> <json>`), or reads one of the app's URIs with omp's `read`,
 * and the test answers as the app would. Runs from source and compiled (`sdk-chat-host-harness.ts`).
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { HostRequest } from "@omp-app/contracts/chat-host";
import {
  type Chat,
  chatHostChats,
  lastReply,
  PROGRAMS,
  realTest,
  resultOf,
} from "./sdk-chat-host-harness";

const chats = chatHostChats();
afterEach(() => chats.stopAll(), 60_000);

const WEATHER = {
  name: "weather",
  description: "Says the weather in a city",
  parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
};

/** A chat whose host requests `answer` handles, as the app would; each request is kept in order. */
async function chatAnswering(
  command: readonly string[],
  answer: (request: HostRequest, chat: Chat) => unknown,
) {
  const chat = await chats.start(command);
  const asked: HostRequest[] = [];
  chat.client.onRequest(async (request) => {
    asked.push(request);
    return answer(request, chat);
  });
  await chat.client.hello;
  return { chat, asked };
}

describe("the chat host's host tools and URI schemes", () => {
  for (const program of PROGRAMS) {
    const programTest = program.command === undefined ? test.skip : realTest;
    const command = program.command ?? [];

    programTest(
      `${program.name}: the model calls the app's tool; its progress reaches omp, and the model reads its result`,
      async () => {
        const { chat, asked } = await chatAnswering(command, async (request, current) => {
          const delivered = await current.client.request("host_tool_update", {
            callId: request.id,
            partialResult: { content: [{ type: "text", text: "half way" }] },
          });
          expect(delivered).toEqual({ delivered: true });
          return { content: [{ type: "text", text: "sunny in Paris" }] };
        });
        expect(await chat.client.request("set_host_tools", { tools: [WEATHER] })).toEqual({
          toolNames: ["weather"],
        });
        await chat.client.request("prompt", { text: 'call_tool weather {"city":"Paris"}' });
        await chat.next(resultOf("2"));
        expect(lastReply(chat)).toBe("tool said: sunny in Paris");
        expect(asked).toMatchObject([
          { method: "tool.call", params: { toolName: "weather", arguments: { city: "Paris" } } },
        ]);
        expect(
          chat.events.some(
            ({ event }) =>
              event.type === "tool_execution_update" &&
              JSON.stringify(event.partialResult).includes("half way"),
          ),
        ).toBe(true);
        // The call has ended: progress for it reaches nothing.
        expect(
          await chat.client.request("host_tool_update", {
            callId: asked[0]?.id ?? "",
            partialResult: { content: [] },
          }),
        ).toEqual({ delivered: false });
      },
      60_000,
    );

    programTest(
      `${program.name}: an error answer fails the call with its text`,
      async () => {
        const { chat } = await chatAnswering(command, () => ({
          content: [{ type: "text", text: "no such city" }],
          isError: true,
        }));
        await chat.client.request("set_host_tools", { tools: [WEATHER] });
        await chat.client.request("prompt", { text: 'call_tool weather {"city":"Atlantis"}' });
        await chat.next(resultOf("2"));
        expect(lastReply(chat)).toContain("no such city");
      },
      60_000,
    );

    programTest(
      `${program.name}: stopping the reply cancels a running call on the app too`,
      async () => {
        const never = Promise.withResolvers<unknown>();
        const called = Promise.withResolvers<void>();
        const { chat, asked } = await chatAnswering(command, () => {
          called.resolve();
          return never.promise;
        });
        await chat.client.request("set_host_tools", { tools: [WEATHER] });
        await chat.client.request("prompt", { text: 'call_tool weather {"city":"Paris"}' });
        await called.promise;
        await chat.client.request("abort", {});
        expect(await chat.next((event) => event.type === "tool_cancel")).toEqual({
          type: "tool_cancel",
          requestId: asked[0]?.id ?? "",
        });
        expect(await chat.next(resultOf("2"))).toMatchObject({ status: "aborted" });
      },
      60_000,
    );

    programTest(
      `${program.name}: omp's read tool reads the app's URI scheme, and omp's own schemes cannot be taken`,
      async () => {
        const { chat, asked } = await chatAnswering(command, () => ({
          content: "row one",
          contentType: "text/plain",
        }));
        expect(
          await chat.client.request("set_host_uri_schemes", { schemes: [{ scheme: "TestDB" }] }),
        ).toEqual({
          schemes: ["testdb"],
        });
        await expect(
          chat.client.request("set_host_uri_schemes", { schemes: [{ scheme: "local" }] }),
        ).rejects.toMatchObject({ message: "Host URI scheme is reserved by OMP: local://" });
        await chat.client.request("prompt", { text: 'call_tool read {"path":"testdb://rows/1"}' });
        await chat.next(resultOf("3"));
        expect(lastReply(chat)).toContain("row one");
        expect(asked.map(({ method, params }) => ({ method, params }))).toEqual([
          { method: "uri.read", params: { url: "testdb://rows/1" } },
        ]);
      },
      60_000,
    );

    programTest(
      `${program.name}: a tool without a name or description is refused with omp's reason`,
      async () => {
        const { chat } = await chatAnswering(command, () => ({ content: [] }));
        await expect(
          chat.client.request("set_host_tools", { tools: [{ ...WEATHER, name: "  " }] }),
        ).rejects.toMatchObject({ message: "Host tool at index 0 must provide a non-empty name" });
        await expect(
          chat.client.request("set_host_tools", { tools: [{ ...WEATHER, description: "" }] }),
        ).rejects.toMatchObject({
          message: 'Host tool "weather" must provide a non-empty description',
        });
      },
      60_000,
    );
  }
});
