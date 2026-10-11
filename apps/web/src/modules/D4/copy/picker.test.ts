import { ThreadId } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import type {
  DialogHost,
  DialogHostOpenOptions,
  DialogRequest,
  DialogResponse,
  DialogResult,
  DialogResultFor,
} from "@/modules/U4/contract";
import { createTranscriptActions } from "./actions";
import { realChatEntries } from "./fixtures/real-chat";
import { type CopyPickerDeps, createCopyPicker } from "./picker";
import { createCopySourceReader } from "./source";
import type { CopySourceMessage } from "./targets";

const THREAD = ThreadId.parse("01a11a8a-ea99-72dd-a84a-017f5d3766ef");
const PROMPT_TEXT =
  "Here is a snippet:\n```ts\nconst answer = 42;\n```\nAnd a shell step:\n```bash\necho inside\n```\nrun_bash";
const SHOW_BY_HAND = "Show the text to copy by hand";
const DOWNLOAD = "Download it as a file";

/** Answers each open in turn, as U4's DialogHost would, and records what it was asked and how. */
class ScriptedDialogs implements DialogHost {
  readonly requests: DialogRequest[] = [];
  readonly options: DialogHostOpenOptions[] = [];
  private readonly answers: DialogResult[];

  constructor(answers: readonly DialogResult[]) {
    this.answers = [...answers];
  }

  open<R extends DialogRequest>(
    request: R,
    options: DialogHostOpenOptions,
  ): Promise<DialogResultFor<R>> {
    this.requests.push(request);
    this.options.push(options);
    const answer = this.answers.shift();
    if (answer === undefined) {
      return Promise.reject(new Error("No answer was scripted for this dialog."));
    }
    return Promise.resolve(answer as DialogResultFor<R>);
  }

  confirm(
    _request: Extract<DialogRequest, { kind: "confirm" }>,
    _options: DialogHostOpenOptions,
  ): Promise<boolean> {
    return Promise.resolve(false);
  }
}

function answered(response: DialogResponse): DialogResult {
  return { outcome: "answered", response };
}

const CANCELLED: DialogResult = { outcome: "cancelled", kind: "select", timedOut: false };

function setUp(options: {
  readonly dialogs: ScriptedDialogs;
  readonly refuse?: boolean;
  readonly messages?: readonly CopySourceMessage[];
}) {
  const written: string[] = [];
  const downloads: Array<{ readonly fileName: string; readonly text: string }> = [];
  const messages = options.messages ?? createCopySourceReader()(realChatEntries());
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
  const deps: CopyPickerDeps = {
    threadId: THREAD,
    dialogs: options.dialogs,
    actions,
    download: (fileName, text) => {
      downloads.push({ fileName, text });
    },
  };
  return { picker: createCopyPicker(deps), written, downloads };
}

describe("createCopyPicker", () => {
  test("offers every target in one select, copies the one chosen, and reports the copy after the clipboard accepted it", async () => {
    const dialogs = new ScriptedDialogs([
      answered({ kind: "select", value: "Message 1 from you" }),
    ]);
    const { picker, written } = setUp({ dialogs });

    const outcome = await picker.run();

    expect(outcome).toEqual({
      outcome: "copied",
      label: "Message 1 from you",
      chars: PROMPT_TEXT.length,
    });
    expect(written).toEqual([PROMPT_TEXT]);
    const request = dialogs.requests[0];
    if (request?.kind !== "select") throw new Error("The picker should open a select.");
    expect(request.title).toBe("Copy from this chat");
    expect(request.id.startsWith("app-copy-")).toBe(true);
    expect(request.options).toHaveLength(12);
    expect(request.options[0]).toBe("Latest command");
    expect(request.optionDetails?.[0]).toEqual({ description: "echo copy-me" });
    expect(dialogs.options[0]).toMatchObject({ origin: "app", threadId: THREAD });
  });

  test("a cancelled choice copies nothing", async () => {
    const dialogs = new ScriptedDialogs([CANCELLED]);
    const { picker, written, downloads } = setUp({ dialogs });

    expect(await picker.run()).toEqual({ outcome: "cancelled" });
    expect(written).toEqual([]);
    expect(downloads).toEqual([]);
    expect(dialogs.requests).toHaveLength(1);
  });

  test("a chat with nothing to copy says so and opens no dialog", async () => {
    const dialogs = new ScriptedDialogs([]);
    const { picker } = setUp({ dialogs, messages: [] });

    expect(await picker.run()).toEqual({ outcome: "nothing-to-copy" });
    expect(dialogs.requests).toEqual([]);
  });

  test("a refused clipboard offers a download of the exact text, and reports a download rather than a copy", async () => {
    const dialogs = new ScriptedDialogs([
      answered({ kind: "select", value: "Code block 1 in message 1" }),
      answered({ kind: "select", value: DOWNLOAD }),
    ]);
    const { picker, written, downloads } = setUp({ dialogs, refuse: true });

    const outcome = await picker.run();

    expect(outcome).toEqual({
      outcome: "download-started",
      label: "Code block 1 in message 1",
      fileName: "code-block-1-in-message-1.txt",
      chars: "const answer = 42;".length,
    });
    expect(downloads).toEqual([
      { fileName: "code-block-1-in-message-1.txt", text: "const answer = 42;" },
    ]);
    expect(written).toEqual([]);
    const recovery = dialogs.requests[1];
    if (recovery?.kind !== "select") throw new Error("Recovery should be a select.");
    expect(recovery.options).toEqual([DOWNLOAD, SHOW_BY_HAND]);
  });

  test("a refused clipboard can show the exact text for a copy by hand, in an editor", async () => {
    const dialogs = new ScriptedDialogs([
      answered({ kind: "select", value: "Command 1 in message 1" }),
      answered({ kind: "select", value: SHOW_BY_HAND }),
      answered({ kind: "editor", value: "echo inside" }),
    ]);
    const { picker, written, downloads } = setUp({ dialogs, refuse: true });

    const outcome = await picker.run();

    expect(outcome).toEqual({
      outcome: "shown-for-manual-copy",
      label: "Command 1 in message 1",
      chars: "echo inside".length,
    });
    const editor = dialogs.requests[2];
    if (editor?.kind !== "editor") throw new Error("The by-hand view should be an editor.");
    expect(editor.title).toBe('Copy "Command 1 in message 1" by hand');
    expect(editor.prefill).toBe("echo inside");
    expect(editor.readOnly).toBe(true);
    expect(written).toEqual([]);
    expect(downloads).toEqual([]);
  });

  test("cancelling the recovery saves nothing and says so", async () => {
    const dialogs = new ScriptedDialogs([
      answered({ kind: "select", value: "Message 2" }),
      CANCELLED,
    ]);
    const { picker, written, downloads } = setUp({ dialogs, refuse: true });

    expect(await picker.run()).toEqual({
      outcome: "not-copied",
      reason: "The clipboard refused the copy, so nothing was saved.",
    });
    expect(written).toEqual([]);
    expect(downloads).toEqual([]);
  });

  test("a choice that matches no target is reported, and nothing is copied", async () => {
    const dialogs = new ScriptedDialogs([answered({ kind: "select", value: "Message 99" })]);
    const { picker, written } = setUp({ dialogs });

    expect(await picker.run()).toEqual({
      outcome: "not-copied",
      reason: "That copy target is no longer in this chat.",
    });
    expect(written).toEqual([]);
  });

  test("an aborted run ends cancelled before any dialog opens", async () => {
    const dialogs = new ScriptedDialogs([]);
    const { picker } = setUp({ dialogs });
    const controller = new AbortController();
    controller.abort();

    expect(await picker.run({ signal: controller.signal })).toEqual({ outcome: "cancelled" });
    expect(dialogs.requests).toEqual([]);
  });

  test("a dialog that fails is reported as a failed copy, not thrown", async () => {
    const dialogs = new ScriptedDialogs([]);
    const { picker, written } = setUp({ dialogs });

    const outcome = await picker.run();

    expect(outcome).toEqual({
      outcome: "not-copied",
      reason: "The copy failed for an unexpected reason.",
    });
    expect(written).toEqual([]);
  });
});
