import { ThreadId } from "@omp-app/contracts";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  D4_COPY_COMMAND,
  D4_COPY_DESCRIPTORS,
  D4_COPY_SHORTCUT,
} from "@/modules/D4/copy/descriptors";
import { OmpRuntimeStore } from "@/modules/R0/store";
import type {
  DialogHost,
  DialogHostOpenOptions,
  DialogRequest,
  DialogResult,
  DialogResultFor,
} from "@/modules/U4/contract";
import {
  MemoryPreferenceStore,
  type ShortcutRegistry,
  ShortcutRegistryProvider,
  useShortcutRegistry,
} from "@/shortcuts";
import { type CopyFromChatOptions, useCopyFromChat } from "./use-copy-from-chat";

afterEach(() => cleanup());

const threadId = ThreadId.parse("01a11a8a-ea99-72dd-a84a-017f5d3766ef");
const CODE = "const answer = 42;";

/** A chat with one saved user message that holds a fenced code block. */
function chatWithCode(): OmpRuntimeStore {
  const store = new OmpRuntimeStore({ threadId });
  store.pairEndedMessages([
    {
      type: "message",
      id: "user-code",
      parentId: null,
      timestamp: "2026-10-05T00:00:00.000Z",
      message: {
        role: "user",
        content: `Here is the snippet:\n\`\`\`ts\n${CODE}\n\`\`\``,
        timestamp: 1,
      },
    },
  ]);
  return store;
}

/** Answers each open in turn, as U4's DialogHost would, and records what it was asked. */
class ScriptedDialogs implements DialogHost {
  readonly requests: DialogRequest[] = [];
  private readonly answers: DialogResult[];

  constructor(answers: readonly DialogResult[]) {
    this.answers = [...answers];
  }

  open<R extends DialogRequest>(
    request: R,
    _options: DialogHostOpenOptions,
  ): Promise<DialogResultFor<R>> {
    this.requests.push(request);
    const answer = this.answers.shift();
    if (answer === undefined) {
      return Promise.reject(new Error("No answer was scripted for this dialog."));
    }
    return Promise.resolve(answer as DialogResultFor<R>);
  }

  confirm(): Promise<boolean> {
    return Promise.resolve(false);
  }
}

function chosen(value: string): DialogResult {
  return { outcome: "answered", response: { kind: "select", value } };
}

const CANCELLED: DialogResult = { outcome: "cancelled", kind: "select", timedOut: false };

type Options = Omit<CopyFromChatOptions, "showStatus" | "threadId">;

/** A component that mounts the hook and exposes the shortcut registry the palette and shortcuts use. */
function Harness({
  options,
  registry,
  showStatus,
}: {
  readonly options: Options;
  readonly registry: { current?: ShortcutRegistry };
  readonly showStatus: (text: string | null) => void;
}) {
  registry.current = useShortcutRegistry();
  useCopyFromChat({ ...options, threadId, showStatus });
  return <textarea aria-label="Message input" />;
}

function mountCopy(options: Options) {
  const registry: { current?: ShortcutRegistry } = {};
  const statuses: Array<string | null> = [];
  const showStatus = (text: string | null) => {
    statuses.push(text);
  };
  render(
    <ShortcutRegistryProvider
      descriptors={D4_COPY_DESCRIPTORS}
      preferenceStore={new MemoryPreferenceStore()}
    >
      <Harness options={options} registry={registry} showStatus={showStatus} />
    </ShortcutRegistryProvider>,
  );
  return { registry, statuses };
}

function recordingClipboard() {
  return { writeText: vi.fn(async () => undefined) };
}

describe("useCopyFromChat", () => {
  test("registers the palette command and its shortcut, and the shortcut opens the picker", async () => {
    const dialogs = new ScriptedDialogs([CANCELLED]);
    const { registry, statuses } = mountCopy({
      store: chatWithCode(),
      dialogs,
      clipboard: recordingClipboard(),
      download: vi.fn(),
    });
    await waitFor(() => expect(registry.current?.commandFor(D4_COPY_COMMAND.id)).toBeDefined());
    expect(registry.current?.commandFor(D4_COPY_COMMAND.id)?.shortcut).toBe(D4_COPY_SHORTCUT.id);

    const event = new KeyboardEvent("keydown", {
      key: "c",
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    expect(registry.current?.dispatch(event, "global").handled).toBe(true);
    await waitFor(() => expect(statuses).toEqual(["Nothing was copied."]));
    expect(dialogs.requests[0]).toMatchObject({ kind: "select", title: "Copy from this chat" });
  });

  test("copies the chosen code block, and says so only after the clipboard accepted it", async () => {
    const accepted = Promise.withResolvers<void>();
    const clipboard = { writeText: vi.fn(() => accepted.promise) };
    const dialogs = new ScriptedDialogs([chosen("Latest code")]);
    const { registry, statuses } = mountCopy({
      store: chatWithCode(),
      dialogs,
      clipboard,
      download: vi.fn(),
    });
    await waitFor(() => expect(registry.current?.commandFor(D4_COPY_COMMAND.id)).toBeDefined());
    registry.current?.commandFor(D4_COPY_COMMAND.id)?.run();

    await waitFor(() => expect(clipboard.writeText).toHaveBeenCalledWith(CODE));
    expect(statuses).toEqual([]);
    accepted.resolve();
    await waitFor(() =>
      expect(statuses).toEqual([`Copied "Latest code" (${CODE.length} characters).`]),
    );
  });

  test("a refused clipboard is never reported as a copy", async () => {
    const clipboard = { writeText: vi.fn(async () => Promise.reject(new Error("blocked"))) };
    const dialogs = new ScriptedDialogs([chosen("Latest code"), CANCELLED]);
    const { registry, statuses } = mountCopy({
      store: chatWithCode(),
      dialogs,
      clipboard,
      download: vi.fn(),
    });
    await waitFor(() => expect(registry.current?.commandFor(D4_COPY_COMMAND.id)).toBeDefined());
    registry.current?.commandFor(D4_COPY_COMMAND.id)?.run();

    await waitFor(() =>
      expect(statuses).toEqual([
        "Nothing was copied. The clipboard refused the copy, so nothing was saved.",
      ]),
    );
    expect(statuses.join(" ")).not.toContain("Copied");
  });
});
