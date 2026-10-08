import { ThreadId } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import type { TranscriptCopyTarget } from "../contract";
import { createTranscriptActions } from "./actions";
import { realChatEntries } from "./fixtures/real-chat";
import { createCopySourceReader } from "./source";

const THREAD = ThreadId.parse("01a11a8a-ea99-72dd-a84a-017f5d3766ef");
const USER_PROMPT = "entry:01a11a8a-ea99-72dd-a84a-017f5d3766ef:b8e8c20d";
const BASH_RUN = "entry:01a11a8a-ea99-72dd-a84a-017f5d3766ef:3d278a13";
const PROMPT_TEXT =
  "Here is a snippet:\n```ts\nconst answer = 42;\n```\nAnd a shell step:\n```bash\necho inside\n```\nrun_bash";

function harness(options: { readonly refuse?: boolean } = {}) {
  const written: string[] = [];
  const messages = createCopySourceReader()(realChatEntries());
  const actions = createTranscriptActions({
    threadId: THREAD,
    messages: () => messages,
    clipboard: {
      writeText: async (text) => {
        if (options.refuse === true) throw new Error("Clipboard writes are blocked.");
        written.push(text);
      },
    },
  });
  return { actions, written };
}

describe("createTranscriptActions over the real chat", () => {
  test("copies a message's exact Markdown and reports the characters it wrote", async () => {
    const { actions, written } = harness();
    const result = await actions.copy({ kind: "message", messageKey: USER_PROMPT });
    expect(written).toEqual([PROMPT_TEXT]);
    expect(result).toEqual({ chars: PROMPT_TEXT.length });
  });

  test("copies a fenced block without its fences", async () => {
    const { actions, written } = harness();
    await actions.copy({ kind: "code", messageKey: USER_PROMPT, partIndex: 0, blockIndex: 0 });
    expect(written).toEqual(["const answer = 42;"]);
  });

  test("copies a shell fence as a command, without its fences", async () => {
    const { actions, written } = harness();
    await actions.copy({ kind: "command", messageKey: USER_PROMPT, partIndex: 0, blockIndex: 1 });
    expect(written).toEqual(["echo inside"]);
  });

  test("copies a bash command and its output, each without a final line ending", async () => {
    const { actions, written } = harness();
    await actions.copy({ kind: "command", messageKey: BASH_RUN, partIndex: 0 });
    await actions.copy({ kind: "code", messageKey: BASH_RUN, partIndex: 1 });
    expect(written).toEqual(["echo copy-me", "copy-me"]);
  });

  test("copies a bash run's message as its exact Markdown, with the output's newline", async () => {
    const { actions, written } = harness();
    await actions.copy({ kind: "message", messageKey: BASH_RUN });
    expect(written).toEqual(["echo copy-me\n\ncopy-me\n"]);
  });

  test("copies a range of characters inside a fenced block", async () => {
    const { actions, written } = harness();
    await actions.copy({
      kind: "code",
      messageKey: USER_PROMPT,
      partIndex: 0,
      blockIndex: 0,
      range: { start: 6, end: 12 },
    });
    expect(written).toEqual(["answer"]);
  });

  test("refuses a range that runs past the end of its block, copying nothing", async () => {
    const { actions, written } = harness();
    await expect(
      actions.copy({
        kind: "code",
        messageKey: USER_PROMPT,
        partIndex: 0,
        blockIndex: 0,
        range: { start: 0, end: 500 },
      }),
    ).rejects.toMatchObject({ appError: { code: "invalid_args" } });
    expect(written).toEqual([]);
  });

  test("refuses an empty range rather than copying nothing", async () => {
    const { actions, written } = harness();
    await expect(
      actions.copy({
        kind: "code",
        messageKey: USER_PROMPT,
        partIndex: 0,
        blockIndex: 0,
        range: { start: 3, end: 3 },
      }),
    ).rejects.toMatchObject({ appError: { code: "invalid_args" } });
    expect(written).toEqual([]);
  });

  test("refuses a block index the message does not have", async () => {
    const { actions } = harness();
    await expect(
      actions.copy({ kind: "code", messageKey: USER_PROMPT, partIndex: 0, blockIndex: 9 }),
    ).rejects.toMatchObject({ appError: { code: "not_found" } });
  });

  test("refuses a fenced block on a part that is not text", async () => {
    const { actions } = harness();
    await expect(
      actions.copy({ kind: "command", messageKey: BASH_RUN, partIndex: 0, blockIndex: 0 }),
    ).rejects.toMatchObject({ appError: { code: "invalid_args" } });
  });

  test("refuses a message the chat no longer has", async () => {
    const { actions } = harness();
    await expect(
      actions.copy({
        kind: "message",
        messageKey: "entry:01a11a8a-ea99-72dd-a84a-017f5d3766ef:ffffffff",
      }),
    ).rejects.toMatchObject({ appError: { code: "not_found" } });
  });

  test("refuses a target that is not one of the three copy kinds", async () => {
    const { actions, written } = harness();
    const invalid: TranscriptCopyTarget = JSON.parse(
      `{"kind":"image","messageKey":"${USER_PROMPT}"}`,
    );
    await expect(actions.copy(invalid)).rejects.toMatchObject({
      appError: { code: "invalid_args" },
    });
    expect(written).toEqual([]);
  });

  test("reports a refused clipboard as permission, and writes nothing", async () => {
    const { actions, written } = harness({ refuse: true });
    await expect(actions.copy({ kind: "message", messageKey: USER_PROMPT })).rejects.toMatchObject({
      appError: { code: "permission", retryable: true },
    });
    expect(written).toEqual([]);
  });

  test("lists targets only for its own chat", async () => {
    const { actions } = harness();
    await expect(actions.getCopyTargets(ThreadId.parse("some-other-chat"))).rejects.toMatchObject({
      appError: { code: "not_found" },
    });
    const options = await actions.getCopyTargets(THREAD);
    expect(options).toHaveLength(12);
  });

  test("reads a part target as the one raw part it names, and a message as all its parts", async () => {
    const { actions } = harness();
    const message = await actions.readParts({ kind: "message", messageKey: BASH_RUN });
    expect(message.map((part) => part.type)).toEqual(["command", "code"]);
    const part = await actions.readParts({
      kind: "code",
      messageKey: BASH_RUN,
      partIndex: 1,
    });
    expect(part.map((item) => item.index)).toEqual([1]);
  });

  test("refuses every call once its signal is aborted, and copies nothing", async () => {
    const { actions, written } = harness();
    const controller = new AbortController();
    controller.abort();
    await expect(
      actions.copy({ kind: "message", messageKey: USER_PROMPT }, controller.signal),
    ).rejects.toMatchObject({ appError: { code: "cancelled" } });
    await expect(actions.getCopyTargets(THREAD, controller.signal)).rejects.toMatchObject({
      appError: { code: "cancelled" },
    });
    expect(written).toEqual([]);
  });
});
