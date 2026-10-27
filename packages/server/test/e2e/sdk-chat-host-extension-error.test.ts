/**
 * Extension errors on the chat host (SDK plan H5.4a): a handler that throws reaches the server as omp's RPC reported it,
 * so the app can name the extension. Runs from source and compiled (`sdk-chat-host-harness.ts`).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chatHostChats, PROGRAMS, realTest } from "./sdk-chat-host-harness";

const chats = chatHostChats();
afterEach(() => chats.stopAll(), 60_000);

/** An extension whose `turn_start` handler throws, as the app's own extension-error spec uses. */
const FAILING_EXTENSION = `export default function failing(pi) {
  pi.on("turn_start", () => {
    throw new Error("notes index is locked");
  });
}
`;

describe("extension errors on the chat host", () => {
  for (const program of PROGRAMS) {
    const programTest = program.command === undefined ? test.skip : realTest;
    const command = program.command ?? [];

    programTest(
      `${program.name}: a handler that throws is an extension_error with the extension's file, its event and the error`,
      async () => {
        const chat = await chats.start(command, {
          agentFiles: { "extensions/failing.ts": FAILING_EXTENSION },
          nativeDiscovery: true,
        });
        await chat.client.hello;
        await chat.client.request("prompt", { text: "hello" });
        const failure = (await chat.next((event) => event.type === "extension_error")) as {
          readonly extensionPath: string;
        };
        expect(failure).toMatchObject({
          type: "extension_error",
          event: "turn_start",
          error: "notes index is locked",
        });
        expect(failure.extensionPath.endsWith("failing.ts")).toBe(true);
      },
      60_000,
    );
  }
});
