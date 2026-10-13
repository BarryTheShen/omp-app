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

  test.each(["x", "Backspace", "ArrowLeft"])(
    "a %s typed after an Enter kept while the list loads drops it, so nothing is sent when the list answers",
    async (key) => {
      const submitted = vi.fn(async () => undefined);
      const { input, held } = heldFileComposer(submitted);
      fireEvent.change(input, { target: { value: "@zz" } });
      input.setSelectionRange(3, 3);
      await waitFor(() =>
        expect(screen.getByRole("listbox", { name: "File suggestions" })).toBeTruthy(),
      );

      fireEvent.keyDown(input, { key: "Enter" });
      fireEvent.keyDown(input, { key });
      held.release();
      // Long enough for the list to answer: its search runs after a debounce, and a shorter wait can pass before it lands.
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 300);
      await promise;
      expect(submitted).not.toHaveBeenCalled();
    },
  );

  test("a Shift press after an Enter kept while the list loads changes no text, so the Enter is still pressed again", async () => {
    const submitted = vi.fn(async () => undefined);
    const { input, held } = heldFileComposer(submitted);
    fireEvent.change(input, { target: { value: "@zz" } });
    input.setSelectionRange(3, 3);
    await waitFor(() =>
      expect(screen.getByRole("listbox", { name: "File suggestions" })).toBeTruthy(),
    );

    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Shift" });
    held.release();
    await waitFor(() => expect(submitted).toHaveBeenCalledTimes(1));
  });
});

describe("#1334: an Enter that commits an IME word does not choose the highlighted row", () => {
  test("an emoji list stays open and inserts nothing for an IME's Enter; a real Enter inserts the emoji", async () => {
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
    held.release();
    await waitForHighlight(input);

    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    expect(input.value).toBe(":smi");
    expect(screen.getByRole("listbox", { name: "Emoji suggestions" })).toBeTruthy();
    expect(submitted).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(input.value).toContain("😄"));
    expect(submitted).not.toHaveBeenCalled();
  });

  test("a file list stays open and inserts nothing for an Enter with keyCode 229; a real Enter inserts the file", async () => {
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
    held.release();
    await waitForHighlight(input);

    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    expect(input.value).toBe("@RE");
    expect(screen.getByRole("listbox", { name: "File suggestions" })).toBeTruthy();
    expect(submitted).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(input.value).toContain("README.md"));
    expect(submitted).not.toHaveBeenCalled();
  });

  test("an arrow key an IME uses leaves the list highlight where it is; a real arrow key moves it", async () => {
    const held = heldSearch(
      {
        id: "emoji:smile",
        kind: "emoji",
        source: "client",
        label: ":smile:",
        insertText: "😄",
      },
      {
        id: "emoji:smile_cat",
        kind: "emoji",
        source: "client",
        label: ":smile_cat:",
        insertText: "😸",
      },
    );
    const provider = {
      trigger: ":",
      kind: "emoji",
      source: "client",
      search: async () => [],
      searchTyped: held.search,
    } as unknown as LocalProvider;
    render(
      <RuntimeHarness>
        <LocalTriggerSlot providers={[provider]} onSelect={() => undefined}>
          <ComposerSurface submitPrompt={async () => undefined} cancel={() => undefined} />
        </LocalTriggerSlot>
      </RuntimeHarness>,
    );
    const input = screen.getByRole("textbox", { name: "Message input" }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: ":smi" } });
    input.setSelectionRange(4, 4);
    held.release();
    await waitForHighlight(input);
    const first = input.getAttribute("aria-activedescendant");

    fireEvent.keyDown(input, { key: "ArrowDown", isComposing: true });
    fireEvent.keyDown(input, { key: "ArrowDown", keyCode: 229 });
    expect(input.getAttribute("aria-activedescendant")).toBe(first);

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.getAttribute("aria-activedescendant")).not.toBe(first);
  });
});
