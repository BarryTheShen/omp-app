/**
 * The chat host's input methods (SDK plan H5.2a), end to end on the fake model provider: the command list, a built-in
 * command, a skill, `!` against `!!` (#839), and queue edits. Runs from source and compiled (`sdk-chat-host-harness.ts`).
 *
 * The fake model's `context_has <word>` answers whether any earlier message it was sent holds the word: omp converts a
 * run recorded with `excludeFromContext` to nothing for the model (18.12.6 `session/messages.ts:1063-1066`), and a plain
 * run to a user message with its command and output.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { AvailableCommandsEvent, CommandOutputEvent } from "@omp-app/contracts/chat-host";
import { chatHostChats, lastReply, PROGRAMS, realTest, resultOf } from "./sdk-chat-host-harness";

const chats = chatHostChats();
afterEach(() => chats.stopAll(), 60_000);

/**
 * omp runs `$` in a virtualenv of the chat's folder, its own managed Python, or `python` or `python3` on PATH
 * (18.12.6 `eval/py/runtime.ts:236-270`). A test chat has neither of the first two, so this machine's PATH decides; the
 * test containers on the test machine have no Python.
 */
const pythonOnPath = (Bun.which("python") ?? Bun.which("python3")) !== null;

/** A user skill: its body asks the fake model whether "skillword7" came before, which only the skill's text holds. */
const GREET_SKILL = `---
name: greet
description: Says hello for the e2e test.
---
context_has skillword7
`;

describe("the chat host's input methods", () => {
  for (const program of PROGRAMS) {
    const programTest = program.command === undefined ? test.skip : realTest;
    const command = program.command ?? [];

    programTest(
      `${program.name}: the command list arrives at start, reads back, and names a user skill`,
      async () => {
        const chat = await chats.start(command, {
          agentFiles: { "skills/greet/SKILL.md": GREET_SKILL },
          nativeDiscovery: true,
        });
        await chat.client.hello;
        const listed = (await chat.next(
          (event) => event.type === "available_commands",
        )) as AvailableCommandsEvent;
        expect(listed.commands).toContainEqual(
          expect.objectContaining({ name: "session", source: "builtin" }),
        );
        expect(
          listed.commands.some((entry) => entry.source === "skill" && entry.name.includes("greet")),
        ).toBe(true);
        const { commands } = await chat.client.request("get_available_commands", {});
        expect(commands.map((entry) => entry.name)).toEqual(
          listed.commands.map((entry) => entry.name),
        );
      },
      60_000,
    );

    programTest(
      `${program.name}: a built-in command answers in the chat without a turn`,
      async () => {
        const chat = await chats.start(command);
        const hello = await chat.client.hello;
        const answer = await chat.client.request("prompt", { text: "/session info" });
        expect(answer).toEqual({ resultFollows: false });
        const output = (await chat.next(
          (event) => event.type === "command_output",
        )) as CommandOutputEvent;
        expect(output.text).toContain(`Session: ${hello.session.id}`);
        expect(chat.events.some((entry) => entry.event.type === "agent_start")).toBe(false);
      },
      60_000,
    );

    programTest(
      `${program.name}: a skill command sends the skill's text to the model`,
      async () => {
        const chat = await chats.start(command, {
          agentFiles: { "skills/greet/SKILL.md": GREET_SKILL },
          nativeDiscovery: true,
        });
        await chat.client.hello;
        expect(await chat.client.request("prompt", { text: "/skill:greet" })).toEqual({
          resultFollows: true,
        });
        expect(await chat.next(resultOf("1"))).toMatchObject({ status: "completed" });
        expect(lastReply(chat)).toBe("context lacks skillword7");
      },
      60_000,
    );

    programTest(
      `${program.name}: a !! run stays out of the model's context, and a ! run reaches it`,
      async () => {
        const chat = await chats.start(command);
        await chat.client.hello;
        const hidden = await chat.client.request("bash", {
          command: "echo hiddenword42",
          excludeFromContext: true,
        });
        expect(hidden).toMatchObject({ output: "hiddenword42\n", exitCode: 0, cancelled: false });
        await chat.client.request("prompt", { text: "context_has hiddenword42" });
        await chat.next(resultOf("2"));
        expect(lastReply(chat)).toBe("context lacks hiddenword42");

        await chat.client.request("bash", { command: "echo shownword42" });
        await chat.client.request("prompt", { text: "context_has shownword42" });
        await chat.next(resultOf("4"));
        expect(lastReply(chat)).toBe("context has shownword42");
      },
      90_000,
    );

    (pythonOnPath ? programTest : test.skip)(
      `${program.name}: a $$ Python run stays out of the model's context, and a $ run reaches it`,
      async () => {
        const chat = await chats.start(command);
        await chat.client.hello;
        const hidden = await chat.client.request("python", {
          code: "print('hidden' + 'py9')",
          excludeFromContext: true,
        });
        expect(hidden).toMatchObject({ output: "hiddenpy9\n", exitCode: 0, cancelled: false });
        await chat.client.request("prompt", { text: "context_has hiddenpy9" });
        await chat.next(resultOf("2"));
        expect(lastReply(chat)).toBe("context lacks hiddenpy9");

        await chat.client.request("python", { code: "print('shown' + 'py9')" });
        await chat.client.request("prompt", { text: "context_has shownpy9" });
        await chat.next(resultOf("4"));
        expect(lastReply(chat)).toBe("context has shownpy9");
      },
      90_000,
    );

    (pythonOnPath ? test.skip : programTest)(
      `${program.name}: without a Python, a $ run fails with omp's reason and the chat goes on`,
      async () => {
        const chat = await chats.start(command);
        await chat.client.hello;
        await expect(chat.client.request("python", { code: "print(1)" })).rejects.toMatchObject({
          code: "failed",
          message: "Python executable not found on PATH",
        });
        await chat.client.request("prompt", { text: "hello" });
        expect(await chat.next(resultOf("2"))).toMatchObject({ status: "completed" });
      },
      90_000,
    );

    programTest(
      `${program.name}: queued messages can be taken back, promoted, and restored by Escape, and each prompt ends once`,
      async () => {
        const chat = await chats.start(command);
        await chat.client.hello;
        await chat.client.request("prompt", { text: "stream_held" });
        await chat.next((event) => event.type === "message_update");
        for (const text of ["first follow-up", "second follow-up", "third follow-up"]) {
          expect(
            await chat.client.request("prompt", { text, streamingBehavior: "followUp" }),
          ).toEqual({
            resultFollows: true,
          });
        }
        expect(
          await chat.client.request("remove_queued_message", {
            message: "first follow-up",
            queue: "followUp",
          }),
        ).toEqual({ removed: true, text: "first follow-up" });
        expect(
          await chat.client.request("remove_queued_message", {
            message: "first follow-up",
            queue: "followUp",
          }),
        ).toEqual({ removed: false });
        expect(
          await chat.client.request("promote_queued_message", { message: "second follow-up" }),
        ).toEqual({
          promoted: true,
        });

        const restored = await chat.client.request("abort_and_restore_queue", {});
        const texts = [...restored.steering, ...restored.followUp].map((message) => message.text);
        expect(texts).toContain("third follow-up");
        expect(texts).not.toContain("first follow-up");

        // Requests 1 to 4 were prompts answered with `resultFollows`: each gets exactly one result.
        for (const id of ["1", "2", "3", "4"]) await chat.next(resultOf(id));
        const results = chat.events.filter((entry) => entry.event.type === "prompt_result");
        expect(
          results
            .map((entry) => (entry.event.type === "prompt_result" ? entry.event.requestId : ""))
            .sort(),
        ).toEqual(["1", "2", "3", "4"]);
        expect((await chat.client.request("get_state", {})).isStreaming).toBe(false);
      },
      90_000,
    );
  }
});
