import {
  AssistantRuntimeProvider,
  type ThreadMessage,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ComposerSurface } from "@/modules/U2/composer";
import type { MentionProvider, TriggerCandidate, TriggerSearchResult } from "../contract";
import { type LocalProvider, LocalTriggerSlot } from "../local";
import { MentionTriggerSlot } from "../mentions";

function RuntimeHarness({ children }: { readonly children: ReactNode }) {
  const runtime = useExternalStoreRuntime({
    messages: [] as readonly ThreadMessage[],
    onNew: async () => undefined,
    onCancel: async () => undefined,
  });
  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}

afterEach(() => cleanup());

/** A search whose answer the test releases itself, so Enter can be pressed while the list is still loading. */
function heldSearch(...candidates: TriggerCandidate[]) {
  const answer = Promise.withResolvers<TriggerSearchResult>();
  return {
    search: () => answer.promise,
    release: () => answer.resolve({ state: "ready", candidates, revision: "held" }),
  };
}

/**
 * Waits until the list has options and the composer points at one. The options render first and the first is
 * highlighted a moment later: an Enter pressed in between would send the text instead of choosing.
 */
async function waitForHighlight(input: HTMLTextAreaElement): Promise<void> {
  await waitFor(() => {
    const first = document.querySelector('[role="option"]');
    expect(first).not.toBeNull();
    expect(input.getAttribute("aria-activedescendant")).toBe(first?.id);
  });
}

/** A file list whose search the test holds, under a composer that sends through `submitted`. */
function heldFileComposer(submitted: () => Promise<void>) {
  const held = heldSearch();
  const provider = {
    trigger: "@",
    kind: "file",
    source: "a1.file-search",
    search: async () => [],
    searchTyped: held.search,
  } as unknown as MentionProvider;
  render(
    <RuntimeHarness>
      <MentionTriggerSlot providers={[provider]} onSelect={() => undefined}>
        <ComposerSurface submitPrompt={submitted} cancel={() => undefined} />
      </MentionTriggerSlot>
    </RuntimeHarness>,
  );
  const input = screen.getByRole("textbox", { name: "Message input" }) as HTMLTextAreaElement;
  return { input, held };
}

describe("#818: Enter waits for a list that is still loading", () => {
  test("an emoji search still loading holds Enter; once it answers, Enter inserts the emoji and sends nothing", async () => {
    const held = heldSearch({
      id: "emoji:smile",
      kind: "emoji",
      source: "client",
      label: ":smile:",
      insertText: "😄",
    });
    const provider = {
      trigger: ":",
      kind: "emoji",
      source: "client",
      search: async () => [],
      searchTyped: held.search,
    } as unknown as LocalProvider;
    const submitted = vi.fn(async () => undefined);
    render(
      <RuntimeHarness>
        <LocalTriggerSlot providers={[provider]} onSelect={() => undefined}>
          <ComposerSurface submitPrompt={submitted} cancel={() => undefined} />
        </LocalTriggerSlot>
      </RuntimeHarness>,
    );
    const input = screen.getByRole("textbox", { name: "Message input" }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: ":smi" } });
    input.setSelectionRange(4, 4);
    await waitFor(() =>
      expect(screen.getByRole("listbox", { name: "Emoji suggestions" })).toBeTruthy(),
    );

    fireEvent.keyDown(input, { key: "Enter" });
    expect(submitted).not.toHaveBeenCalled();

    held.release();
    await waitForHighlight(input);
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(input.value).toContain("😄"));
    expect(submitted).not.toHaveBeenCalled();
  });

  test("a file search still loading holds Enter; once it answers, Enter inserts the file and sends nothing", async () => {
    const held = heldSearch({
      id: "file:README.md",
      kind: "file",
      source: "a1.file-search",
      label: "README.md",
      insertText: "@README.md",
    });
    const provider = {
      trigger: "@",
      kind: "file",
      source: "a1.file-search",
      search: async () => [],
      searchTyped: held.search,
    } as unknown as MentionProvider;
    const submitted = vi.fn(async () => undefined);
    render(
      <RuntimeHarness>
        <MentionTriggerSlot providers={[provider]} onSelect={() => undefined}>
          <ComposerSurface submitPrompt={submitted} cancel={() => undefined} />
        </MentionTriggerSlot>
      </RuntimeHarness>,
    );
    const input = screen.getByRole("textbox", { name: "Message input" }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "@RE" } });
    input.setSelectionRange(3, 3);
    await waitFor(() =>
      expect(screen.getByRole("listbox", { name: "File suggestions" })).toBeTruthy(),
    );

    fireEvent.keyDown(input, { key: "Enter" });
    expect(submitted).not.toHaveBeenCalled();

    held.release();
    await waitForHighlight(input);
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(input.value).toContain("README.md"));
    expect(submitted).not.toHaveBeenCalled();
  });

  test("Shift+Enter while the list is still loading is not held: it stays a newline", async () => {
    const held = heldSearch({
      id: "file:README.md",
      kind: "file",
      source: "a1.file-search",
      label: "README.md",
      insertText: "@README.md",
    });
    const provider = {
      trigger: "@",
      kind: "file",
      source: "a1.file-search",
      search: async () => [],
      searchTyped: held.search,
    } as unknown as MentionProvider;
    render(
      <RuntimeHarness>
        <MentionTriggerSlot providers={[provider]} onSelect={() => undefined}>
          <ComposerSurface submitPrompt={async () => undefined} cancel={() => undefined} />
        </MentionTriggerSlot>
      </RuntimeHarness>,
    );
    const input = screen.getByRole("textbox", { name: "Message input" }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "@RE" } });
    input.setSelectionRange(3, 3);
    await waitFor(() =>
      expect(screen.getByRole("listbox", { name: "File suggestions" })).toBeTruthy(),
    );

    expect(fireEvent.keyDown(input, { key: "Enter", shiftKey: true })).toBe(true);
    held.release();
  });

  test("an Enter kept while the list loads is pressed again when it answers with nothing, so the text is sent", async () => {
    const submitted = vi.fn(async () => undefined);
    const { input, held } = heldFileComposer(submitted);
    fireEvent.change(input, { target: { value: "@zz" } });
    input.setSelectionRange(3, 3);
    await waitFor(() =>
      expect(screen.getByRole("listbox", { name: "File suggestions" })).toBeTruthy(),
    );

    fireEvent.keyDown(input, { key: "Enter" });
    expect(submitted).not.toHaveBeenCalled();
    held.release();
    await waitFor(() => expect(submitted).toHaveBeenCalledTimes(1));
  });

  test("Escape cancels an Enter kept while the list loads, so nothing is sent when it answers", async () => {
    const submitted = vi.fn(async () => undefined);
    const { input, held } = heldFileComposer(submitted);
    fireEvent.change(input, { target: { value: "@zz" } });
    input.setSelectionRange(3, 3);
    await waitFor(() =>
      expect(screen.getByRole("listbox", { name: "File suggestions" })).toBeTruthy(),
    );

    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Escape" });
    held.release();
    // Long enough for the answer to arrive and for its microtask to run.
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 50);
    await promise;
    expect(submitted).not.toHaveBeenCalled();
  });
});
