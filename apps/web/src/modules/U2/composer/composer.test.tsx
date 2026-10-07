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
});
