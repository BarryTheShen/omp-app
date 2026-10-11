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
import type { SubmitPolicy } from "../contract";
import { ComposerSurface } from "./composer";

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
) {
  return render(
    <RuntimeProvider running={running}>
      <ComposerSurface submitPrompt={submitPrompt} cancel={cancel} />
    </RuntimeProvider>,
  );
}

const BLOCKED_REASON = "Can't send yet. Your message stays here until omp-app reconnects.";

describe("U2.2 ComposerSurface", () => {
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
    expect(screen.getByText("Press Enter to steer this turn")).toBeTruthy();
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

    expect(screen.queryByText("Press Enter to steer this turn")).toBeNull();
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
