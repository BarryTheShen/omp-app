import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  type ThreadMessage,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ComposerSurface } from "@/modules/U2/composer";
import type { MentionProvider, TriggerCandidate, TriggerSearchResult } from "../contract";
import { type LocalProvider, LocalTriggerSlot } from "../local";
import { MentionComposerSlot } from "../mentions";
import { TriggerKeyScope, useSendAfterChoose, useTriggerListLoading } from "./trigger-keys";

/** The mention lists under a trigger root of their own, as a test mounts them on their own. */
function MentionTriggerSlot(props: ComponentProps<typeof MentionComposerSlot>) {
  return (
    <ComposerPrimitive.Unstable_TriggerPopoverRoot>
      <MentionComposerSlot {...props} />
    </ComposerPrimitive.Unstable_TriggerPopoverRoot>
  );
}

function RuntimeHarness({ children }: { readonly children: ReactNode }) {
  const runtime = useExternalStoreRuntime({
    messages: [] as readonly ThreadMessage[],
    onNew: async () => undefined,
    onCancel: async () => undefined,
  });
  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}

/** A list row: it chooses, and after the choose asks the composer to send, unless it is a row that does not send. */
function ChoosingRow({
  id,
  label,
  sends = true,
}: {
  readonly id: string;
  readonly label: string;
  readonly sends?: boolean;
}) {
  const sendAfterChoose = useSendAfterChoose();
  return (
    <button
      type="button"
      role="option"
      id={id}
      onClick={() => {
        if (sends) sendAfterChoose();
      }}
    >
      {label}
    </button>
  );
}

/** Lets the work that a key press queued in microtasks run: a macrotask runs only after every queued microtask. */
function settle(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  return promise;
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
      <MentionTriggerSlot
        notify={() => undefined}
        fail={() => undefined}
        providers={[provider]}
        onSelect={() => undefined}
      >
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
        <MentionTriggerSlot
          notify={() => undefined}
          fail={() => undefined}
          providers={[provider]}
          onSelect={() => undefined}
        >
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
        <MentionTriggerSlot
          notify={() => undefined}
          fail={() => undefined}
          providers={[provider]}
          onSelect={() => undefined}
        >
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
        <MentionTriggerSlot
          notify={() => undefined}
          fail={() => undefined}
          providers={[provider]}
          onSelect={() => undefined}
        >
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

describe("#1566: an Enter with an open, answered list chooses a row and never sends the text", () => {
  test("the row the list marks highlighted is chosen while the composer points at no row yet", () => {
    const chosen = vi.fn();
    const sent = vi.fn();
    render(
      <TriggerKeyScope isCurrentRow={() => true}>
        <textarea aria-label="Message input" onKeyDown={sent} />
        <div role="listbox">
          <button type="button" role="option" id="usage" aria-selected="true" onClick={chosen}>
            /usage
          </button>
          <button type="button" role="option" id="model" aria-selected="false">
            /model
          </button>
        </div>
      </TriggerKeyScope>,
    );
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Message input" }), { key: "Enter" });
    expect(chosen).toHaveBeenCalledTimes(1);
    expect(sent).not.toHaveBeenCalled();
  });

  test("after a re-render replaced the row the composer names, Enter chooses the row the list marks", () => {
    const chosen = vi.fn();
    const sent = vi.fn();
    render(
      <TriggerKeyScope isCurrentRow={() => true}>
        <textarea aria-label="Message input" aria-activedescendant="gone" onKeyDown={sent} />
        <div role="listbox">
          <button type="button" role="option" id="usage" aria-selected="true" onClick={chosen}>
            /usage
          </button>
        </div>
      </TriggerKeyScope>,
    );
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Message input" }), { key: "Enter" });
    expect(chosen).toHaveBeenCalledTimes(1);
    expect(sent).not.toHaveBeenCalled();
  });

  test("a list that marks no row chooses its first row when Enter comes", () => {
    const first = vi.fn();
    const second = vi.fn();
    const sent = vi.fn();
    render(
      <TriggerKeyScope isCurrentRow={() => true}>
        <textarea aria-label="Message input" onKeyDown={sent} />
        <div role="listbox">
          <button type="button" role="option" id="usage" aria-selected="false" onClick={first}>
            /usage
          </button>
          <button type="button" role="option" id="model" aria-selected="false" onClick={second}>
            /model
          </button>
        </div>
      </TriggerKeyScope>,
    );
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Message input" }), { key: "Enter" });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    expect(sent).not.toHaveBeenCalled();
  });

  test("an open list with no rows still lets Enter send the text", () => {
    const sent = vi.fn();
    render(
      <TriggerKeyScope>
        <textarea aria-label="Message input" onKeyDown={sent} />
        <div role="listbox" />
      </TriggerKeyScope>,
    );
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Message input" }), { key: "Enter" });
    expect(sent).toHaveBeenCalledTimes(1);
  });

  test("Tab keeps to the composer's pointer: with none, the page takes the key", () => {
    const chosen = vi.fn();
    const sent = vi.fn();
    render(
      <TriggerKeyScope isCurrentRow={() => true}>
        <textarea aria-label="Message input" onKeyDown={sent} />
        <div role="listbox">
          <button type="button" role="option" id="usage" aria-selected="true" onClick={chosen}>
            /usage
          </button>
        </div>
      </TriggerKeyScope>,
    );
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Message input" }), { key: "Tab" });
    expect(chosen).not.toHaveBeenCalled();
    expect(sent).toHaveBeenCalledTimes(1);
  });

  test("a choose that Tab makes does not send the text", async () => {
    const sent = vi.fn();
    render(
      <TriggerKeyScope>
        <textarea aria-label="Message input" aria-activedescendant="usage-row" onKeyDown={sent} />
        <div role="listbox">
          <ChoosingRow id="usage-row" label="/usage" />
        </div>
      </TriggerKeyScope>,
    );
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Message input" }), { key: "Tab" });
    // A send would press Enter again after a microtask: let that queued work run before judging.
    await settle();
    expect(sent).not.toHaveBeenCalled();
  });

  test("a pointer press clears a Tab's choose, so a click on a row that sends still sends", async () => {
    const sent = vi.fn();
    render(
      <TriggerKeyScope>
        <textarea aria-label="Message input" aria-activedescendant="quiet-row" onKeyDown={sent} />
        <div role="listbox">
          <ChoosingRow id="quiet-row" label="/quiet" sends={false} />
          <ChoosingRow id="send-row" label="/send" />
        </div>
      </TriggerKeyScope>,
    );
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Message input" }), { key: "Tab" });
    fireEvent.pointerDown(screen.getByRole("option", { name: "/send" }));
    fireEvent.click(screen.getByRole("option", { name: "/send" }));
    await settle();
    expect(sent).toHaveBeenCalledTimes(1);
  });
});

describe("#2245: a held Enter waits for its list when the list is between renders", () => {
  function choose(): "choose" {
    return "choose";
  }

  function Scoped({
    loading,
    rows,
    chosen,
  }: {
    readonly loading: boolean;
    readonly rows: boolean;
    readonly chosen: () => void;
  }) {
    useTriggerListLoading(loading, choose);
    return (
      <>
        <textarea aria-label="Message input" />
        {rows ? (
          <div role="listbox">
            <button type="button" role="option" aria-selected="true" onClick={chosen}>
              /usage
            </button>
          </div>
        ) : loading ? (
          <div role="listbox" />
        ) : null}
      </>
    );
  }

  test("the list hides in the commit its loading ends and shows its row in the next: the held Enter chooses that row", async () => {
    const chosen = vi.fn();
    const { rerender } = render(
      <TriggerKeyScope>
        <Scoped loading rows={false} chosen={chosen} />
      </TriggerKeyScope>,
    );
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Message input" }), { key: "Enter" });
    // The answer: the loading ends and the list is hidden in that commit. Its microtask runs before the next commit.
    rerender(
      <TriggerKeyScope>
        <Scoped loading={false} rows={false} chosen={chosen} />
      </TriggerKeyScope>,
    );
    await Promise.resolve();
    rerender(
      <TriggerKeyScope>
        <Scoped loading={false} rows chosen={chosen} />
      </TriggerKeyScope>,
    );
    await waitFor(() => expect(chosen).toHaveBeenCalledTimes(1));
  });

  test("a text key typed while the list is hidden drops the held Enter, so the row that shows later is not chosen", async () => {
    const chosen = vi.fn();
    const { rerender } = render(
      <TriggerKeyScope>
        <Scoped loading rows={false} chosen={chosen} />
      </TriggerKeyScope>,
    );
    const input = screen.getByRole("textbox", { name: "Message input" });
    fireEvent.keyDown(input, { key: "Enter" });
    rerender(
      <TriggerKeyScope>
        <Scoped loading={false} rows={false} chosen={chosen} />
      </TriggerKeyScope>,
    );
    await Promise.resolve();
    fireEvent.keyDown(input, { key: "x" });
    rerender(
      <TriggerKeyScope>
        <Scoped loading={false} rows chosen={chosen} />
      </TriggerKeyScope>,
    );
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 50);
    await promise;
    expect(chosen).not.toHaveBeenCalled();
  });
});

describe("#2245: an empty list is not an answer while a held Enter waits for its list", () => {
  /** Lets the scope's queued settles and the list observers run. */
  function settled(): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 20);
    return promise;
  }

  /** The @ file list: it passes its loading state and no answer, so a held Enter is dropped once it has options. */
  function FileList({
    loading,
    shown,
    submitted,
    chosen,
  }: {
    readonly loading: boolean;
    readonly shown: "none" | "empty" | "rows";
    readonly submitted: () => void;
    readonly chosen: () => void;
  }) {
    useTriggerListLoading(loading);
    return (
      <>
        <textarea
          aria-label="Message input"
          onKeyDown={(event) => {
            if (event.key === "Enter") submitted();
          }}
        />
        {shown === "rows" && (
          <div role="listbox" aria-label="File suggestions">
            <button type="button" role="option" aria-selected="true" onClick={chosen}>
              README.md
            </button>
          </div>
        )}
        {shown === "empty" && (
          <div role="listbox" aria-label="File suggestions">
            <p>No matches</p>
          </div>
        )}
      </>
    );
  }

  test("the list shows an empty shell before its rows once the loading ends: the held Enter is not pressed again, and the @ rule drops it", async () => {
    const submitted = vi.fn();
    const chosen = vi.fn();
    const list = (loading: boolean, shown: "none" | "empty" | "rows") => (
      <TriggerKeyScope>
        <FileList loading={loading} shown={shown} submitted={submitted} chosen={chosen} />
      </TriggerKeyScope>
    );
    const { rerender } = render(list(true, "empty"));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Message input" }), { key: "Enter" });
    expect(submitted).not.toHaveBeenCalled();
    // The loading ends in a commit where the list is not in the page: the held Enter waits for the list.
    rerender(list(false, "none"));
    await settled();
    // The first list to show is an empty shell: that is not an answer, so the Enter is not pressed again.
    rerender(list(false, "empty"));
    await settled();
    expect(submitted).not.toHaveBeenCalled();
    // The rows arrive: the @ rule drops the held Enter, so nothing is chosen and nothing is sent.
    rerender(list(false, "rows"));
    await settled();
    expect(submitted).not.toHaveBeenCalled();
    expect(chosen).not.toHaveBeenCalled();
  });
});

describe("#2757: a slot holds an Enter only for its own list", () => {
  /** Lets the scope's queued settles and the list observers run. */
  function settled(): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 20);
    return promise;
  }

  /** An outer slot's list loading out of sight, as the @ file list's warm-up does: it shows no list and passes no answer. */
  function OuterWarmUp({ loading }: { readonly loading: boolean }) {
    useTriggerListLoading(loading);
    return null;
  }

  /** The slots as the composer nests them: the outer slot's scope holds the inner slot's open `/` list. */
  function Slots({ loading, chosen }: { readonly loading: boolean; readonly chosen: () => void }) {
    return (
      <TriggerKeyScope>
        <OuterWarmUp loading={loading} />
        <TriggerKeyScope>
          <textarea aria-label="Message input" />
          <div role="listbox">
            <button type="button" role="option" aria-selected="true" onClick={chosen}>
              /clear
            </button>
          </div>
        </TriggerKeyScope>
      </TriggerKeyScope>
    );
  }

  test("an Enter on the inner slot's answered list chooses its row while the outer slot's list loads out of sight", async () => {
    const chosen = vi.fn();
    const { rerender } = render(<Slots loading chosen={chosen} />);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Message input" }), { key: "Enter" });
    expect(chosen).toHaveBeenCalledTimes(1);
    // The outer load answers later: it had no Enter to settle, so the row is not chosen again.
    rerender(<Slots loading={false} chosen={chosen} />);
    await settled();
    expect(chosen).toHaveBeenCalledTimes(1);
  });
});
