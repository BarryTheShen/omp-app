import {
  AssistantRuntimeProvider,
  type ThreadMessage,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { AppFailure } from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { type PropsWithChildren, useMemo } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { PromptIntent } from "../../R0/runtime/runtime";
import { type AttachmentBlobStore, AttachmentManager } from "../attachments";
import type { SubmitPolicy } from "../contract";
import { ComposerSurface } from "./composer";
import { LargePasteMenuThresholdContext } from "./large-paste-menu";

afterEach(() => cleanup());
function RuntimeProvider({ running, children }: PropsWithChildren<{ readonly running: boolean }>) {
  const messages = useMemo<readonly ThreadMessage[]>(() => [], []);
  const runtime = useExternalStoreRuntime({
    messages,
    isRunning: running,
    onNew: async () => undefined,
    onCancel: async () => undefined,
  });
  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}

function renderComposer(
  running: boolean,
  submitPrompt: (intent: PromptIntent) => Promise<void>,
  cancel: () => Promise<void> | void = async () => undefined,
  placeholder?: string,
) {
  return render(
    <RuntimeProvider running={running}>
      <ComposerSurface submitPrompt={submitPrompt} cancel={cancel} placeholder={placeholder} />
    </RuntimeProvider>,
  );
}

const BLOCKED_REASON = "Can't send yet. Your message stays here until omp-app reconnects.";

describe("U2.2 ComposerSurface", () => {
  test("applies the placeholder prop and keeps the original default", () => {
    renderComposer(
      false,
      vi.fn(async () => undefined),
      undefined,
      "Type / for commands",
    );
    expect(screen.getByRole("textbox", { name: "Message input" }).getAttribute("placeholder")).toBe(
      "Type / for commands",
    );

    cleanup();
    renderComposer(
      false,
      vi.fn(async () => undefined),
    );
    expect(screen.getByRole("textbox", { name: "Message input" }).getAttribute("placeholder")).toBe(
      "Send a message...",
    );
  });

  test("submits on Enter but leaves Shift+Enter as a newline gesture", async () => {
    const submitPrompt = vi.fn(async () => undefined);
    renderComposer(false, submitPrompt);
    const input = screen.getByRole("textbox", { name: "Message input" });
    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.keyDown(input, { key: "Shift", shiftKey: true });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(submitPrompt).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(submitPrompt).toHaveBeenCalledTimes(1));
    expect(submitPrompt).toHaveBeenCalledWith({ mode: "prompt", text: "hello", delivery: "new" });
  });

  test("does not submit while an IME composition is active", async () => {
    const submitPrompt = vi.fn(async () => undefined);
    renderComposer(false, submitPrompt);
    const input = screen.getByRole("textbox", { name: "Message input" });
    fireEvent.change(input, { target: { value: "かな" } });
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(submitPrompt).not.toHaveBeenCalled();
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(submitPrompt).toHaveBeenCalledTimes(1));
  });

  test("chooses steer while R0 reports a running turn and shows the hint", async () => {
    const submitPrompt = vi.fn(async () => undefined);
    renderComposer(true, submitPrompt);
    expect(screen.getByText("Enter steers · Ctrl+Enter queues")).toBeTruthy();
    const input = screen.getByRole("textbox", { name: "Message input" });
    fireEvent.change(input, { target: { value: "steer text" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(submitPrompt).toHaveBeenCalledTimes(1));
    expect(submitPrompt).toHaveBeenCalledWith({
      mode: "prompt",
      text: "steer text",
      delivery: "steer",
    });
  });

  test("marks the toolbar row only while the steer hint is rendered", () => {
    const idle = renderComposer(
      false,
      vi.fn(async () => undefined),
    );
    expect(
      idle.container.querySelector("[data-composer-toolbar]")?.hasAttribute("data-steer-hint"),
    ).toBe(false);
    cleanup();
    const running = renderComposer(
      true,
      vi.fn(async () => undefined),
    );
    expect(
      running.container.querySelector("[data-composer-toolbar]")?.getAttribute("data-steer-hint"),
    ).toBe("true");
  });

  test("the steer hint sits in the toolbar row with the stop control, so it adds no line above the editor", () => {
    renderComposer(
      true,
      vi.fn(async () => undefined),
    );
    const hint = screen.getByText("Enter steers · Ctrl+Enter queues");
    const stop = screen.getByRole("button", { name: "Stop generating" });
    const row = hint.closest("[data-composer-toolbar]");
    expect(row).not.toBeNull();
    expect(row?.contains(stop)).toBe(true);
    expect(hint.getAttribute("title")).toBe(
      "Enter steers this turn. Ctrl+Enter queues a message for after it.",
    );
  });

  test("on a Mac the steer hint names Cmd+Enter as the way to queue a message", () => {
    const userAgent = vi
      .spyOn(window.navigator, "userAgent", "get")
      .mockReturnValue("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15");
    try {
      renderComposer(
        true,
        vi.fn(async () => undefined),
      );
      expect(screen.getByText("Enter steers · Cmd+Enter queues")).toBeTruthy();
    } finally {
      userAgent.mockRestore();
    }
  });

  test.each([
    { chord: "ctrlEnter", modifier: { ctrlKey: true } },
    { chord: "metaEnter", modifier: { metaKey: true } },
  ])("$chord hands the policy a follow-up chord, not a steer", async ({ chord, modifier }) => {
    const submitPrompt = vi.fn(async (_intent: PromptIntent) => undefined);
    const keyChords: string[] = [];
    const policy: SubmitPolicy = (input) => {
      keyChords.push(input.keyChord);
      return { delivery: input.keyChord === "enter" ? "steer" : "followUp" };
    };
    render(
      <RuntimeProvider running>
        <ComposerSurface
          cancel={async () => undefined}
          policy={policy}
          submitPrompt={submitPrompt}
        />
      </RuntimeProvider>,
    );
    const input = screen.getByRole("textbox", { name: "Message input" });
    fireEvent.change(input, { target: { value: "follow later please" } });
    fireEvent.keyDown(input, { key: "Enter", ...modifier });
    await waitFor(() => expect(submitPrompt).toHaveBeenCalledTimes(1));
    expect(keyChords).toEqual([chord]);
    expect(submitPrompt).toHaveBeenCalledWith({
      mode: "prompt",
      text: "follow later please",
      delivery: "followUp",
    });
  });

  test("keeps the exact draft and shows a pre-admission failure", async () => {
    const failure = new AppFailure({
      code: "permission",
      message: "Prompt rejected",
      retryable: false,
    });
    const submitPrompt = vi.fn(async () => {
      throw failure;
    });
    renderComposer(false, submitPrompt);
    const input = screen.getByRole("textbox", { name: "Message input" });
    fireEvent.change(input, { target: { value: "do not lose me" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Prompt rejected"));
    expect((input as HTMLTextAreaElement).value).toBe("do not lose me");
  });
  test("renders toolbar controls in the action row and keeps the footer below", () => {
    render(
      <RuntimeProvider running={false}>
        <ComposerSurface
          cancel={() => undefined}
          submitPrompt={async () => undefined}
          toolbar={<button type="button">Prompt</button>}
        >
          <span data-testid="composer-footer">Attachments</span>
        </ComposerSurface>
      </RuntimeProvider>,
    );

    const row = screen.getByRole("button", { name: "Add attachment" }).parentElement;
    const mode = screen.getByRole("button", { name: "Prompt" });
    const send = screen.getByRole("button", { name: "Send message" });
    const footer = screen.getByTestId("composer-footer");
    expect(row?.contains(mode)).toBe(true);
    expect(row?.contains(send)).toBe(true);
    expect(row?.contains(footer)).toBe(false);
  });

  test("while an edit box takes its place, the composer's own input and send are hidden and the footer stays", () => {
    render(
      <RuntimeProvider running={false}>
        <ComposerSurface cancel={() => undefined} submitPrompt={async () => undefined} replaced>
          <span data-testid="composer-footer">Edit box</span>
        </ComposerSurface>
      </RuntimeProvider>,
    );

    expect(screen.queryByRole("textbox", { name: "Message input" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Send message" })).toBeNull();
    expect(screen.getByTestId("composer-footer")).toBeTruthy();
  });

  test("maps the cancel button to R0.3 cancel", async () => {
    const cancel = vi.fn(async () => undefined);
    renderComposer(
      true,
      vi.fn(async () => undefined),
      cancel,
    );
    const stop = screen.getByRole("button", { name: "Stop generating" });
    fireEvent.click(stop);
    await waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
  });

  test("sends a `!` line to the bash path as a bash intent, not to the model as a prompt", async () => {
    const submitPrompt = vi.fn(async () => undefined);
    renderComposer(false, submitPrompt);
    const input = screen.getByRole("textbox", { name: "Message input" });
    fireEvent.change(input, { target: { value: "!ls -la" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(submitPrompt).toHaveBeenCalledTimes(1));
    expect(submitPrompt).toHaveBeenCalledWith({ mode: "bash", text: "ls -la", delivery: "new" });
  });

  test("keeps a `!!` line in the composer when the host refuses it, and says why", async () => {
    const reason =
      "Running a command without sending its output to the model is not available in this version of omp.";
    const submitPrompt = vi.fn(async () => {
      throw new AppFailure({ code: "unavailable", message: reason, retryable: false });
    });
    renderComposer(false, submitPrompt);
    const input = screen.getByRole("textbox", { name: "Message input" }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "!!echo excluded-out" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain(reason));
    expect(submitPrompt).toHaveBeenCalledWith({
      mode: "bash",
      text: "echo excluded-out",
      delivery: "new",
      excludeFromContext: true,
    });
    expect(input.value).toBe("!!echo excluded-out");
  });

  test("refuses a `$` line while Python is unavailable: nothing is sent and the line stays", async () => {
    const submitPrompt = vi.fn(async () => undefined);
    renderComposer(false, submitPrompt);
    const input = screen.getByRole("textbox", { name: "Message input" }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "$ echo python-try" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "Python mode is not available in this version of omp.",
      ),
    );
    expect(submitPrompt).not.toHaveBeenCalled();
    expect(input.value).toBe("$ echo python-try");
  });

  test("a bare `!` line sends nothing and stays in the composer", () => {
    const submitPrompt = vi.fn(async () => undefined);
    renderComposer(false, submitPrompt);
    const input = screen.getByRole("textbox", { name: "Message input" }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "!" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(submitPrompt).not.toHaveBeenCalled();
    expect(input.value).toBe("!");
  });

  test("Escape in bash mode returns the composer to Prompt and keeps the text", () => {
    const submitPrompt = vi.fn(async () => undefined);
    renderComposer(false, submitPrompt);
    const input = screen.getByRole("textbox", { name: "Message input" }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "!some text" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.value).toBe("some text");
    expect(submitPrompt).not.toHaveBeenCalled();
  });

  test("an empty Backspace leaves bash mode, but a Backspace with text left does not", () => {
    renderComposer(
      false,
      vi.fn(async () => undefined),
    );
    const input = screen.getByRole("textbox", { name: "Message input" }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "!" } });
    fireEvent.keyDown(input, { key: "Backspace" });
    expect(input.value).toBe("");
    fireEvent.change(input, { target: { value: "!cmd" } });
    fireEvent.keyDown(input, { key: "Backspace" });
    expect(input.value).toBe("!cmd");
  });

  test("Escape in Prompt mode changes nothing, and a key a trigger already handled is left alone", () => {
    renderComposer(
      false,
      vi.fn(async () => undefined),
    );
    const input = screen.getByRole("textbox", { name: "Message input" }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.value).toBe("hello");
    fireEvent.change(input, { target: { value: "!still bash" } });
    // A trigger list takes Escape on the document, in the capture phase, before the composer sees it.
    const takesEscape = (event: KeyboardEvent) => event.preventDefault();
    document.addEventListener("keydown", takesEscape, { capture: true });
    fireEvent.keyDown(input, { key: "Escape" });
    document.removeEventListener("keydown", takesEscape, { capture: true });
    expect(input.value).toBe("!still bash");
  });

  test("a running turn takes Escape first; the next Escape leaves bash mode", async () => {
    const submitPrompt = vi.fn(async () => undefined);
    const cancel = vi.fn(async () => undefined);
    const { rerender } = renderComposer(true, submitPrompt, cancel);
    const input = screen.getByRole("textbox", { name: "Message input" }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "!some text" } });
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
    expect(input.value).toBe("!some text");

    rerender(
      <RuntimeProvider running={false}>
        <ComposerSurface submitPrompt={submitPrompt} cancel={cancel} />
      </RuntimeProvider>,
    );
    fireEvent.keyDown(input, { key: "Escape" });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(input.value).toBe("some text");
  });

  test("a running turn is not stopped by the Escape that dismisses a trigger list; the next Escape stops it", async () => {
    const cancel = vi.fn(async () => undefined);
    renderComposer(
      true,
      vi.fn(async () => undefined),
      cancel,
    );
    const input = screen.getByRole("textbox", { name: "Message input" }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "/us" } });
    // A trigger list takes Escape on the document, in the capture phase, before the composer sees it.
    const takesEscape = (event: KeyboardEvent) => event.preventDefault();
    document.addEventListener("keydown", takesEscape, { capture: true });
    fireEvent.keyDown(input, { key: "Escape" });
    document.removeEventListener("keydown", takesEscape, { capture: true });
    expect(cancel).not.toHaveBeenCalled();
    expect(input.value).toBe("/us");

    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
  });

  test("a composer that cannot send yet keeps the text, disables Send, and says why", () => {
    const submitPrompt = vi.fn(async () => undefined);
    render(
      <RuntimeProvider running={false}>
        <ComposerSurface
          cancel={() => undefined}
          sendBlockedReason={BLOCKED_REASON}
          submitPrompt={submitPrompt}
        />
      </RuntimeProvider>,
    );
    const input = screen.getByRole("textbox", { name: "Message input" });
    const send = screen.getByRole("button", { name: "Send message" });
    fireEvent.change(input, { target: { value: "still typing" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(submitPrompt).not.toHaveBeenCalled();
    expect(input).toHaveProperty("value", "still typing");
    expect(send.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(BLOCKED_REASON)).toBeTruthy();
    const describedBy = input.getAttribute("aria-describedby") ?? "";
    expect(document.getElementById(describedBy)?.textContent).toBe(BLOCKED_REASON);
  });

  test("the text the composer kept sends once it can send again", async () => {
    const submitPrompt = vi.fn(async () => undefined);
    const { rerender } = render(
      <RuntimeProvider running={false}>
        <ComposerSurface
          cancel={() => undefined}
          sendBlockedReason={BLOCKED_REASON}
          submitPrompt={submitPrompt}
        />
      </RuntimeProvider>,
    );
    const input = screen.getByRole("textbox", { name: "Message input" });
    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(submitPrompt).not.toHaveBeenCalled();

    rerender(
      <RuntimeProvider running={false}>
        <ComposerSurface cancel={() => undefined} submitPrompt={submitPrompt} />
      </RuntimeProvider>,
    );
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(submitPrompt).toHaveBeenCalledWith({ mode: "prompt", text: "hello", delivery: "new" }),
    );
    expect(screen.queryByText(BLOCKED_REASON)).toBeNull();
  });

  describe("a message that holds an image still loading", () => {
    const LOADING = "The image is still loading, so the message is not sent yet.";

    test("the normal send does nothing: Enter and Send keep the text and say why", () => {
      const submitPrompt = vi.fn(async () => undefined);
      render(
        <RuntimeProvider running={false}>
          <ComposerSurface
            attachmentHoldReason={LOADING}
            cancel={() => undefined}
            submitPrompt={submitPrompt}
          />
        </RuntimeProvider>,
      );
      const input = screen.getByRole("textbox", { name: "Message input" });
      fireEvent.change(input, { target: { value: "with a picture" } });
      fireEvent.keyDown(input, { key: "Enter" });
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));

      expect(submitPrompt).not.toHaveBeenCalled();
      expect(input).toHaveProperty("value", "with a picture");
      expect(screen.getByRole("button", { name: "Send message" }).hasAttribute("disabled")).toBe(
        true,
      );
      expect(screen.getByText(LOADING)).toBeTruthy();
    });

    test("the queue send does nothing: Ctrl+Enter while a turn runs keeps the text and queues nothing", () => {
      const submitPrompt = vi.fn(async () => undefined);
      render(
        <RuntimeProvider running>
          <ComposerSurface
            attachmentHoldReason={LOADING}
            cancel={() => undefined}
            submitPrompt={submitPrompt}
          />
        </RuntimeProvider>,
      );
      const input = screen.getByRole("textbox", { name: "Message input" });
      fireEvent.change(input, { target: { value: "with a picture" } });
      fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });

      expect(submitPrompt).not.toHaveBeenCalled();
      expect(input).toHaveProperty("value", "with a picture");
      expect(screen.getByText(LOADING)).toBeTruthy();
      // Enter does not steer while the message is held, so the steer hint is not offered either.
      expect(screen.queryByText("Enter steers · Ctrl+Enter queues")).toBeNull();
      // A picture that is loading does not hold back Stop: the turn can still be stopped.
      expect(screen.getByRole("button", { name: "Stop generating" }).hasAttribute("disabled")).toBe(
        false,
      );
    });

    test("the held message is sent once its image is attached", async () => {
      const submitPrompt = vi.fn(async () => undefined);
      const { rerender } = render(
        <RuntimeProvider running={false}>
          <ComposerSurface
            attachmentHoldReason={LOADING}
            cancel={() => undefined}
            submitPrompt={submitPrompt}
          />
        </RuntimeProvider>,
      );
      const input = screen.getByRole("textbox", { name: "Message input" });
      fireEvent.change(input, { target: { value: "with a picture" } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(submitPrompt).not.toHaveBeenCalled();

      rerender(
        <RuntimeProvider running={false}>
          <ComposerSurface cancel={() => undefined} submitPrompt={submitPrompt} />
        </RuntimeProvider>,
      );
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() =>
        expect(submitPrompt).toHaveBeenCalledWith({
          mode: "prompt",
          text: "with a picture",
          delivery: "new",
        }),
      );
      expect(screen.queryByText(LOADING)).toBeNull();
    });
  });

  test("while sending is blocked, Stop is disabled, Escape does not cancel, and no steer hint shows", () => {
    const cancel = vi.fn(async () => undefined);
    render(
      <RuntimeProvider running>
        <ComposerSurface
          cancel={cancel}
          sendBlockedReason={BLOCKED_REASON}
          submitPrompt={vi.fn(async () => undefined)}
        />
      </RuntimeProvider>,
    );
    const input = screen.getByRole("textbox", { name: "Message input" });
    fireEvent.change(input, { target: { value: "still typing" } });

    expect(screen.queryByText("Enter steers · Ctrl+Enter queues")).toBeNull();
    expect(screen.getByRole("button", { name: "Stop generating" }).hasAttribute("disabled")).toBe(
      true,
    );
    fireEvent.keyDown(input, { key: "Escape" });
    expect(cancel).not.toHaveBeenCalled();
    expect(input).toHaveProperty("value", "still typing");
  });

  describe("double-tap ← in the empty editor opens the Agent Hub", () => {
    afterEach(() => vi.restoreAllMocks());

    function renderArrows(value = "") {
      const onDoubleLeftArrow = vi.fn();
      render(
        <RuntimeProvider running={false}>
          <ComposerSurface
            cancel={async () => undefined}
            onDoubleLeftArrow={onDoubleLeftArrow}
            submitPrompt={async () => undefined}
          />
        </RuntimeProvider>,
      );
      const input = screen.getByRole("textbox", { name: "Message input" }) as HTMLTextAreaElement;
      if (value !== "") fireEvent.change(input, { target: { value } });
      return { input, onDoubleLeftArrow };
    }

    function pressAt(
      input: HTMLTextAreaElement,
      key: string,
      at: number,
      init: KeyboardEventInit = {},
    ) {
      vi.spyOn(Date, "now").mockReturnValue(at);
      fireEvent.keyDown(input, { key, ...init });
    }

    test("two ← presses close together in an empty editor open it once", () => {
      const { input, onDoubleLeftArrow } = renderArrows();
      pressAt(input, "ArrowLeft", 1_000);
      pressAt(input, "ArrowLeft", 1_200);
      expect(onDoubleLeftArrow).toHaveBeenCalledTimes(1);
    });

    test("a ← press in an editor with text does not open it, and the text stays", () => {
      const { input, onDoubleLeftArrow } = renderArrows("draft");
      pressAt(input, "ArrowLeft", 1_000);
      pressAt(input, "ArrowLeft", 1_200);
      expect(onDoubleLeftArrow).not.toHaveBeenCalled();
      expect(input.value).toBe("draft");
    });

    test("a second ← after the window is a first press, not a double-tap", () => {
      const { input, onDoubleLeftArrow } = renderArrows();
      pressAt(input, "ArrowLeft", 1_000);
      pressAt(input, "ArrowLeft", 1_600);
      expect(onDoubleLeftArrow).not.toHaveBeenCalled();
    });

    test("any other key between the two ← presses cancels the double-tap", () => {
      const { input, onDoubleLeftArrow } = renderArrows();
      pressAt(input, "ArrowLeft", 1_000);
      pressAt(input, "a", 1_100);
      pressAt(input, "ArrowLeft", 1_200);
      expect(onDoubleLeftArrow).not.toHaveBeenCalled();
    });

    test.each([
      { modifier: "Alt", init: { altKey: true } },
      { modifier: "Ctrl", init: { ctrlKey: true } },
      { modifier: "Meta", init: { metaKey: true } },
      { modifier: "Shift", init: { shiftKey: true } },
    ])("a ← held with $modifier is not a tap: two such presses open nothing", ({ init }) => {
      const { input, onDoubleLeftArrow } = renderArrows();
      pressAt(input, "ArrowLeft", 1_000, init);
      pressAt(input, "ArrowLeft", 1_200, init);
      expect(onDoubleLeftArrow).not.toHaveBeenCalled();
    });
  });
});

/** The blob store the composer tests need: a pasted chip's text stays in the manager, so nothing is stored. */
const NO_BLOBS: AttachmentBlobStore = {
  put: async ({ id, file }) => ({
    ref: { id, name: file.name, mediaType: file.type },
    content: [],
  }),
  get: async () => {
    throw new Error("the composer test never restores an attachment");
  },
  delete: async () => undefined,
};

function AttachmentRuntime({
  children,
  maxBytes,
}: PropsWithChildren<{ readonly maxBytes?: number }>) {
  const messages = useMemo<readonly ThreadMessage[]>(() => [], []);
  const adapters = useMemo(
    () => ({ attachments: new AttachmentManager({ blobStore: NO_BLOBS, maxBytes }) }),
    [maxBytes],
  );
  const runtime = useExternalStoreRuntime({
    messages,
    adapters,
    onNew: async () => undefined,
    onCancel: async () => undefined,
  });
  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}

/** Pastes plain text into the composer; false when the composer took the paste over (default prevented). */
function pasteText(input: HTMLElement, text: string): boolean {
  return fireEvent.paste(input, {
    clipboardData: { files: [], getData: (type: string) => (type === "text/plain" ? text : "") },
  });
}

describe("a large paste in the composer", () => {
  const LARGE = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`).join("\n");
  const CHOICE = "Pasted 100 lines. Where should they go?";
  const HOLD = "Choose where the pasted text goes first. The message is not sent yet.";

  test("a paste of 100 lines opens the choice and keeps the text out of the box", () => {
    render(
      <RuntimeProvider running={false}>
        <ComposerSurface submitPrompt={vi.fn(async () => undefined)} cancel={() => undefined} />
      </RuntimeProvider>,
    );
    const input = screen.getByRole("textbox", { name: "Message input" });
    expect(pasteText(input, LARGE)).toBe(false);
    expect(screen.getByText(CHOICE)).toBeTruthy();
    expect(input).toHaveProperty("value", "");
  });

  test("a paste of 99 lines is left to the box, as typed, with no choice", () => {
    render(
      <RuntimeProvider running={false}>
        <ComposerSurface submitPrompt={vi.fn(async () => undefined)} cancel={() => undefined} />
      </RuntimeProvider>,
    );
    const input = screen.getByRole("textbox", { name: "Message input" });
    expect(pasteText(input, LARGE.split("\n").slice(0, 99).join("\n"))).toBe(true);
    expect(screen.queryByText(/Where should they go/)).toBeNull();
  });

  test("with the Large Paste Menu off (0), a paste of 100 lines is left to the box with no choice", () => {
    render(
      <RuntimeProvider running={false}>
        <LargePasteMenuThresholdContext.Provider value={0}>
          <ComposerSurface submitPrompt={vi.fn(async () => undefined)} cancel={() => undefined} />
        </LargePasteMenuThresholdContext.Provider>
      </RuntimeProvider>,
    );
    const input = screen.getByRole("textbox", { name: "Message input" });
    expect(pasteText(input, LARGE)).toBe(true);
    expect(screen.queryByText(/Where should they go/)).toBeNull();
  });

  test("a changed threshold moves the choice: 100 lines is left to the box at 250, and 250 lines is offered it", () => {
    render(
      <RuntimeProvider running={false}>
        <LargePasteMenuThresholdContext.Provider value={250}>
          <ComposerSurface submitPrompt={vi.fn(async () => undefined)} cancel={() => undefined} />
        </LargePasteMenuThresholdContext.Provider>
      </RuntimeProvider>,
    );
    const input = screen.getByRole("textbox", { name: "Message input" });
    expect(pasteText(input, LARGE)).toBe(true);
    expect(screen.queryByText(/Where should they go/)).toBeNull();
    const longer = Array.from({ length: 250 }, (_, index) => `line ${index + 1}`).join("\n");
    expect(pasteText(input, longer)).toBe(false);
    expect(screen.getByText("Pasted 250 lines. Where should they go?")).toBeTruthy();
  });

  test("Paste inline puts the full text where it was pasted", async () => {
    render(
      <RuntimeProvider running={false}>
        <ComposerSurface submitPrompt={vi.fn(async () => undefined)} cancel={() => undefined} />
      </RuntimeProvider>,
    );
    const input = screen.getByRole("textbox", { name: "Message input" }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "ab" } });
    input.setSelectionRange(1, 1);
    pasteText(input, LARGE);
    fireEvent.click(screen.getByRole("button", { name: "Paste inline" }));
    await waitFor(() => expect(input).toHaveProperty("value", `a${LARGE}b`));
    expect(screen.queryByText(CHOICE)).toBeNull();
  });

  test("Escape puts the text inline, so it is not lost", async () => {
    render(
      <RuntimeProvider running={false}>
        <ComposerSurface submitPrompt={vi.fn(async () => undefined)} cancel={() => undefined} />
      </RuntimeProvider>,
    );
    const input = screen.getByRole("textbox", { name: "Message input" }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "ab" } });
    input.setSelectionRange(1, 1);
    pasteText(input, LARGE);
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(input).toHaveProperty("value", `a${LARGE}b`));
    expect(screen.queryByText(CHOICE)).toBeNull();
  });

  test("Attach as a wrapped block adds one chip, and Send carries that chip with the typed text", async () => {
    const submitPrompt = vi.fn(async () => undefined);
    render(
      <AttachmentRuntime>
        <ComposerSurface submitPrompt={submitPrompt} cancel={() => undefined} />
      </AttachmentRuntime>,
    );
    const input = screen.getByRole("textbox", { name: "Message input" });
    pasteText(input, LARGE);
    fireEvent.click(screen.getByRole("button", { name: "Attach as a wrapped block" }));
    await waitFor(() =>
      expect(screen.getAllByText("Pasted text 1 (100 lines).txt")).toHaveLength(1),
    );
    expect(screen.queryByText(CHOICE)).toBeNull();
    expect(input).toHaveProperty("value", "");
    fireEvent.change(input, { target: { value: "Summarize" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(submitPrompt).toHaveBeenCalledTimes(1));
    expect(submitPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "prompt",
        text: "Summarize",
        attachmentRefs: [expect.objectContaining({ name: "Pasted text 1 (100 lines).txt" })],
      }),
    );
  });

  test("Enter waits while the choice is open: nothing is sent and the text stays; Paste inline releases it", async () => {
    const submitPrompt = vi.fn(async () => undefined);
    render(
      <RuntimeProvider running={false}>
        <ComposerSurface submitPrompt={submitPrompt} cancel={() => undefined} />
      </RuntimeProvider>,
    );
    const input = screen.getByRole("textbox", { name: "Message input" }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "ab" } });
    input.setSelectionRange(1, 1);
    pasteText(input, LARGE);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(submitPrompt).not.toHaveBeenCalled();
    expect(input).toHaveProperty("value", "ab");
    expect(screen.getByText(HOLD)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send message" }).hasAttribute("disabled")).toBe(
      true,
    );

    fireEvent.click(screen.getByRole("button", { name: "Paste inline" }));
    await waitFor(() => expect(input).toHaveProperty("value", `a${LARGE}b`));
    expect(screen.queryByText(HOLD)).toBeNull();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(submitPrompt).toHaveBeenCalledWith(
        expect.objectContaining({ mode: "prompt", text: `a${LARGE}b` }),
      ),
    );
  });

  test("a chip that cannot be added puts the text into the box, and says why", async () => {
    render(
      <AttachmentRuntime maxBytes={10}>
        <ComposerSurface submitPrompt={vi.fn(async () => undefined)} cancel={() => undefined} />
      </AttachmentRuntime>,
    );
    const input = screen.getByRole("textbox", { name: "Message input" }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "ab" } });
    input.setSelectionRange(1, 1);
    pasteText(input, LARGE);
    fireEvent.click(screen.getByRole("button", { name: "Attach as a wrapped block" }));
    await waitFor(() => expect(input).toHaveProperty("value", `a${LARGE}b`));
    expect(screen.queryByText(CHOICE)).toBeNull();
    expect(screen.queryByText("Pasted text 1 (100 lines).txt")).toBeNull();
    expect(
      screen.getByText(
        "Pasted text 1 (100 lines).txt was not attached. Files over 10 bytes can't be attached.",
      ),
    ).toBeTruthy();
  });

  test("the choice offers a wrapped block, a local file and inline, in that order", () => {
    render(
      <RuntimeProvider running={false}>
        <ComposerSurface
          submitPrompt={vi.fn(async () => undefined)}
          cancel={() => undefined}
          savePasteFile={vi.fn(async () => "local://paste-1.md")}
        />
      </RuntimeProvider>,
    );
    pasteText(screen.getByRole("textbox", { name: "Message input" }), LARGE);
    const wrapped = screen.getByRole("button", { name: "Attach as a wrapped block" });
    const file = screen.getByRole("button", { name: "Attach as local file" });
    const inline = screen.getByRole("button", { name: "Paste inline" });
    expect(wrapped.compareDocumentPosition(file) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(file.compareDocumentPosition(inline) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test("without a way to save a file, the choice offers no local file option", () => {
    render(
      <RuntimeProvider running={false}>
        <ComposerSurface submitPrompt={vi.fn(async () => undefined)} cancel={() => undefined} />
      </RuntimeProvider>,
    );
    pasteText(screen.getByRole("textbox", { name: "Message input" }), LARGE);
    expect(screen.queryByRole("button", { name: "Attach as local file" })).toBeNull();
    expect(screen.getByRole("button", { name: "Paste inline" })).toBeTruthy();
  });

  test("Attach as local file saves the full text, and puts its reference where the paste was", async () => {
    const savePasteFile = vi.fn(async () => "local://paste-1.md");
    render(
      <RuntimeProvider running={false}>
        <ComposerSurface
          submitPrompt={vi.fn(async () => undefined)}
          cancel={() => undefined}
          savePasteFile={savePasteFile}
        />
      </RuntimeProvider>,
    );
    const input = screen.getByRole("textbox", { name: "Message input" }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "ab" } });
    input.setSelectionRange(1, 1);
    pasteText(input, LARGE);
    fireEvent.click(screen.getByRole("button", { name: "Attach as local file" }));
    await waitFor(() => expect(input).toHaveProperty("value", "alocal://paste-1.md b"));
    expect(savePasteFile).toHaveBeenCalledWith(LARGE);
    expect(screen.queryByText(CHOICE)).toBeNull();
    expect(screen.queryByText("Pasted text 1 (100 lines).txt")).toBeNull();
  });

  test("Enter waits while the file is saved, then the message goes with the reference", async () => {
    const submitPrompt = vi.fn(async () => undefined);
    let finish: (reference: string) => void = () => undefined;
    const savePasteFile = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    render(
      <RuntimeProvider running={false}>
        <ComposerSurface
          submitPrompt={submitPrompt}
          cancel={() => undefined}
          savePasteFile={savePasteFile}
        />
      </RuntimeProvider>,
    );
    const input = screen.getByRole("textbox", { name: "Message input" }) as HTMLTextAreaElement;
    pasteText(input, LARGE);
    fireEvent.click(screen.getByRole("button", { name: "Attach as local file" }));
    fireEvent.keyDown(input, { key: "Enter" });
    expect(submitPrompt).not.toHaveBeenCalled();
    expect(
      screen.getByText("The pasted text is being saved to a file. The message is not sent yet."),
    ).toBeTruthy();

    finish("local://paste-1.md");
    await waitFor(() => expect(input).toHaveProperty("value", "local://paste-1.md "));
    expect(screen.queryByText(HOLD)).toBeNull();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(submitPrompt).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: "prompt",
          text: expect.stringContaining("local://paste-1.md"),
        }),
      ),
    );
  });

  test("a file that cannot be saved attaches the text as a chip, and says why", async () => {
    const savePasteFile = vi.fn(async () => {
      throw new AppFailure({
        code: "internal",
        message: "The pasted text could not be saved to the chat's folder.",
        retryable: false,
      });
    });
    render(
      <AttachmentRuntime>
        <ComposerSurface
          submitPrompt={vi.fn(async () => undefined)}
          cancel={() => undefined}
          savePasteFile={savePasteFile}
        />
      </AttachmentRuntime>,
    );
    const input = screen.getByRole("textbox", { name: "Message input" }) as HTMLTextAreaElement;
    pasteText(input, LARGE);
    fireEvent.click(screen.getByRole("button", { name: "Attach as local file" }));
    await waitFor(() =>
      expect(screen.getAllByText("Pasted text 1 (100 lines).txt")).toHaveLength(1),
    );
    expect(input).toHaveProperty("value", "");
    expect(screen.queryByText(CHOICE)).toBeNull();
    expect(
      screen.getByText("The pasted text could not be saved to a file, so it was attached instead."),
    ).toBeTruthy();
  });
});
