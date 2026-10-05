import {
  AssistantRuntimeProvider,
  type ThreadMessage,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ComposerSurface } from "../../U2/composer/composer";
import type { MentionProvider } from "../contract";
import { MentionTriggerSlot } from "./trigger-slot";

function RuntimeHarness({ children }: { readonly children: React.ReactNode }) {
  const runtime = useExternalStoreRuntime({
    messages: [] as readonly ThreadMessage[],
    onNew: async () => undefined,
    onCancel: async () => undefined,
  });
  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}

afterEach(() => cleanup());

describe("D2.4 MentionTriggerSlot", () => {
  test("opens a caret trigger popover and inserts a selected file candidate", async () => {
    const provider: MentionProvider = {
      trigger: "@",
      kind: "file",
      source: "a1.file-search",
      search: async () => [],
      searchTyped: async () => ({
        state: "ready",
        candidates: [
          {
            id: "file:src/app.ts",
            kind: "file",
            source: "a1.file-search",
            label: "src/app.ts",
            insertText: "@src/app.ts ",
          },
        ],
      }),
    };
    const selected = vi.fn();
    render(
      <RuntimeHarness>
        <MentionTriggerSlot providers={[provider]} onSelect={selected}>
          <ComposerSurface submitPrompt={async () => undefined} cancel={() => undefined} />
        </MentionTriggerSlot>
      </RuntimeHarness>,
    );
    const input = screen.getByRole("textbox", { name: "Message input" });
    fireEvent.change(input, { target: { value: "before @src" } });
    (input as HTMLTextAreaElement).setSelectionRange(11, 11);
    await waitFor(() => expect(screen.getByRole("listbox")).toBeTruthy());
    await waitFor(() => expect(screen.getByText("src/app.ts")).toBeTruthy());
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(selected).toHaveBeenCalledTimes(1));
    expect(selected).toHaveBeenCalledWith(expect.objectContaining({ id: "file:src/app.ts" }));
    expect((input as HTMLTextAreaElement).value).toBe("before @src/app.ts ");
  });

  test("Escape closes the popover without changing the draft", async () => {
    const provider: MentionProvider = {
      trigger: "@",
      kind: "file",
      source: "a1.file-search",
      search: async () => [],
      searchTyped: async () => ({
        state: "ready",
        candidates: [
          { id: "file:src/app.ts", kind: "file", source: "a1.file-search", label: "src/app.ts" },
        ],
      }),
    };
    render(
      <RuntimeHarness>
        <MentionTriggerSlot providers={[provider]} onSelect={() => undefined}>
          <ComposerSurface submitPrompt={async () => undefined} cancel={() => undefined} />
        </MentionTriggerSlot>
      </RuntimeHarness>,
    );
    const input = screen.getByRole("textbox", { name: "Message input" });
    fireEvent.change(input, { target: { value: "keep @src" } });
    (input as HTMLTextAreaElement).setSelectionRange(9, 9);
    await waitFor(() => expect(screen.getByRole("listbox")).toBeTruthy());
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    expect((input as HTMLTextAreaElement).value).toBe("keep @src");
  });
});
