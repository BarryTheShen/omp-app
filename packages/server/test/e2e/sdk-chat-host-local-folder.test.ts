/**
 * The chat's own scratch folder (#2830), end to end on the fake model provider: `local_folder` names omp's `local://`
 * folder of a new chat, made before its first reply, and a file put there is what omp's `read` gets for
 * `local://<name>`. omp takes the name as written and then decodes it (18.12.6 `internal-urls/local-protocol.ts:210-236`),
 * so a space stays as it is and a `%` is written `%25`. Runs from source and compiled (`sdk-chat-host-harness.ts`).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chatHostChats, lastReply, PROGRAMS, realTest, resultOf } from "./sdk-chat-host-harness";

const chats = chatHostChats();
afterEach(() => chats.stopAll(), 60_000);

describe("the chat host's local folder", () => {
  for (const program of PROGRAMS) {
    const programTest = program.command === undefined ? test.skip : realTest;
    const command = program.command ?? [];

    programTest(
      `${program.name}: a new chat's local folder exists, and omp reads a file put there as local://`,
      async () => {
        const chat = await chats.start(command);
        await chat.client.hello;
        const { folder } = await chat.client.request("local_folder", {});
        expect((await stat(folder)).isDirectory()).toBe(true);
        // Asked again, the same folder.
        expect(await chat.client.request("local_folder", {})).toEqual({ folder });

        await writeFile(join(folder, "lecture 3 notes.txt"), "first marker 2830\n");
        await writeFile(join(folder, "50% off.txt"), "second marker 2830\n");
        await chat.client.request("prompt", {
          text: 'call_tool read {"path":"local://lecture 3 notes.txt"}',
        });
        await chat.next(resultOf("3"));
        expect(lastReply(chat)).toContain("first marker 2830");
        await chat.client.request("prompt", {
          text: 'call_tool read {"path":"local://50%25 off.txt"}',
        });
        await chat.next(resultOf("4"));
        expect(lastReply(chat)).toContain("second marker 2830");
      },
      60_000,
    );
  }
});
