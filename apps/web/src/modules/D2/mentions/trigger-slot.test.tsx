import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  type ThreadMessage,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import type { AppClient } from "@omp-app/client";
import { FolderPath } from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ComposerSurface } from "../../U2/composer/composer";
import type { MentionProvider, TriggerSearchResult } from "../contract";
import { createGithubMentionProvider } from "./mentions";
import { MentionComposerSlot } from "./trigger-slot";

/** The mention lists under a trigger root of their own, as a test mounts them on their own. */
function MentionTriggerSlot(props: ComponentProps<typeof MentionComposerSlot>) {
  return (
    <ComposerPrimitive.Unstable_TriggerPopoverRoot>
      <MentionComposerSlot {...props} />
    </ComposerPrimitive.Unstable_TriggerPopoverRoot>
  );
}

function RuntimeHarness({ children }: { readonly children: React.ReactNode }) {
  const runtime = useExternalStoreRuntime({
    messages: [] as readonly ThreadMessage[],
    onNew: async () => undefined,
    onCancel: async () => undefined,
  });
  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}

afterEach(() => cleanup());

/** Where an action row reports, in the tests that do not read the report. */
const quiet = { notify: () => undefined, fail: () => undefined };

/** Presses one key as a browser does: `beforeinput` first, while the text is still the old text, then the change. */
function pressKey(input: HTMLTextAreaElement, key: string, next: string): void {
  fireEvent(
    input,
    new InputEvent("beforeinput", {
      inputType: "insertText",
      data: key,
      bubbles: true,
      cancelable: true,
    }),
  );
  fireEvent.change(input, { target: { value: next } });
  input.setSelectionRange(next.length, next.length);
}

/** Lets a pending search answer and the popover settle before a negative assertion. */
function pause(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  // Longer than the 60 ms debounce, so a search that was started has answered by then.
  setTimeout(resolve, 200);
  return promise;
}

/** The real GitHub provider on a host that finds nothing, so its five action rows are its only candidates. */
function realGithubProvider(): MentionProvider {
  const client = {
    port: () => ({ search: async () => ({ candidates: [], truncated: false }) }),
  } as unknown as AppClient;
  return createGithubMentionProvider({ client, folder: FolderPath.parse("/workspace") });
}

/** The GitHub provider the host answers for `#12`: issue #12, inserted as its link. */
const issueTwelve: MentionProvider = {
  trigger: "#",
  kind: "github",
  source: "a1.github-refs",
  search: async () => [],
  searchTyped: async () => ({
    state: "ready",
    candidates: [
      {
        id: "github:current:issue:12",
        kind: "github",
        source: "a1.github-refs",
        label: "issue #12",
        insertText: "issue://12 ",
      },
    ],
  }),
};

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
        <MentionTriggerSlot {...quiet} providers={[provider]} onSelect={selected}>
          <ComposerSurface submitPrompt={async () => undefined} cancel={() => undefined} />
        </MentionTriggerSlot>
      </RuntimeHarness>,
    );
    const input = screen.getByRole("textbox", { name: "Message input" });
    fireEvent.change(input, { target: { value: "before @src" } });
    (input as HTMLTextAreaElement).setSelectionRange(11, 11);
    await waitFor(() => expect(screen.getByRole("listbox")).toBeTruthy());
    await waitFor(() => expect(screen.getByText("src/app.ts")).toBeTruthy());
    await waitFor(() => expect(input.getAttribute("aria-activedescendant")).not.toBeNull());
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
        <MentionTriggerSlot {...quiet} providers={[provider]} onSelect={() => undefined}>
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

  test("with no provider offered, @ and # open no popover and typing is untouched", async () => {
    render(
      <RuntimeHarness>
        <MentionTriggerSlot {...quiet} providers={[]} onSelect={() => undefined}>
          <ComposerSurface submitPrompt={async () => undefined} cancel={() => undefined} />
        </MentionTriggerSlot>
      </RuntimeHarness>,
    );
    const input = screen.getByRole("textbox", { name: "Message input" });
    for (const typed of ["before @src", "fix #12"]) {
      fireEvent.change(input, { target: { value: typed } });
      (input as HTMLTextAreaElement).setSelectionRange(typed.length, typed.length);
      await pause();
      expect(screen.queryByRole("listbox")).toBeNull();
      expect(screen.queryByText("No matches")).toBeNull();
      expect((input as HTMLTextAreaElement).value).toBe(typed);
    }
  });

  test("an unavailable search shows its reason as text in the list, never No matches", async () => {
    const result: TriggerSearchResult = {
      state: "unavailable",
      candidates: [],
      error: {
        state: "unavailable",
        error: {
          code: "unavailable",
          message: "File search is unavailable here.",
          retryable: false,
        },
      },
    };
    const searched = vi.fn(async (_query: string) => result);
    const files: MentionProvider = {
      trigger: "@",
      kind: "file",
      source: "a1.file-search",
      search: async () => [],
      searchTyped: searched,
    };
    render(
      <RuntimeHarness>
        <MentionTriggerSlot {...quiet} providers={[files]} onSelect={() => undefined}>
          <ComposerSurface submitPrompt={async () => undefined} cancel={() => undefined} />
        </MentionTriggerSlot>
      </RuntimeHarness>,
    );
    const input = screen.getByRole("textbox", { name: "Message input" });
    fireEvent.change(input, { target: { value: "before @src" } });
    (input as HTMLTextAreaElement).setSelectionRange(11, 11);
    await waitFor(() => expect(searched).toHaveBeenCalledWith("src"));
    expect(await screen.findByText("File search is unavailable here.")).toBeTruthy();
    expect(screen.getByRole("listbox")).toBeTruthy();
    expect(screen.queryByText("No matches")).toBeNull();
    expect((input as HTMLTextAreaElement).value).toBe("before @src");
  });

  test("a # reference ends at its first space: the text past it never searches or opens a list", async () => {
    const empty: TriggerSearchResult = { state: "ready", candidates: [] };
    const searched = vi.fn(async (_query: string) => empty);
    const github: MentionProvider = {
      trigger: "#",
      kind: "github",
      source: "a1.github-refs",
      search: async () => [],
      searchTyped: searched,
    };
    render(
      <RuntimeHarness>
        <MentionTriggerSlot {...quiet} providers={[github]} onSelect={() => undefined}>
          <ComposerSurface submitPrompt={async () => undefined} cancel={() => undefined} />
        </MentionTriggerSlot>
      </RuntimeHarness>,
    );
    const input = screen.getByRole("textbox", { name: "Message input" });
    const typed = "ticket #12 i";
    fireEvent.change(input, { target: { value: typed } });
    (input as HTMLTextAreaElement).setSelectionRange(typed.length, typed.length);
    await pause();
    expect(searched).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).toBeNull();
    expect((input as HTMLTextAreaElement).value).toBe(typed);
  });

  test("a # reference followed by more text opens no list, and Enter sends the text (issue 1340)", async () => {
    const submitPrompt = vi.fn(async () => undefined);
    render(
      <RuntimeHarness>
        <MentionTriggerSlot {...quiet} providers={[issueTwelve]} onSelect={() => undefined}>
          <ComposerSurface submitPrompt={submitPrompt} cancel={() => undefined} />
        </MentionTriggerSlot>
      </RuntimeHarness>,
    );
    const input = screen.getByRole("textbox", { name: "Message input" });
    const typed = "see #12 for details";
    fireEvent.change(input, { target: { value: typed } });
    (input as HTMLTextAreaElement).setSelectionRange(typed.length, typed.length);
    await pause();
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(submitPrompt).toHaveBeenCalledWith({ mode: "prompt", text: typed, delivery: "new" }),
    );
  });

  test("Enter on a found # reference inserts its link and sends nothing (issue 1340)", async () => {
    const submitPrompt = vi.fn(async () => undefined);
    render(
      <RuntimeHarness>
        <MentionTriggerSlot {...quiet} providers={[issueTwelve]} onSelect={() => undefined}>
          <ComposerSurface submitPrompt={submitPrompt} cancel={() => undefined} />
        </MentionTriggerSlot>
      </RuntimeHarness>,
    );
    const input = screen.getByRole("textbox", { name: "Message input" });
    fireEvent.change(input, { target: { value: "see #12" } });
    (input as HTMLTextAreaElement).setSelectionRange(7, 7);
    expect(await screen.findByText("issue #12")).toBeTruthy();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect((input as HTMLTextAreaElement).value).toBe("see issue://12 "));
    expect(submitPrompt).not.toHaveBeenCalled();
  });

  test("a # reference without a space keeps its list open, named GitHub suggestions", async () => {
    const empty: TriggerSearchResult = { state: "ready", candidates: [] };
    const searched = vi.fn(async (_query: string) => empty);
    const github: MentionProvider = {
      trigger: "#",
      kind: "github",
      source: "a1.github-refs",
      search: async () => [],
      searchTyped: searched,
    };
    render(
      <RuntimeHarness>
        <MentionTriggerSlot {...quiet} providers={[github]} onSelect={() => undefined}>
          <ComposerSurface submitPrompt={async () => undefined} cancel={() => undefined} />
        </MentionTriggerSlot>
      </RuntimeHarness>,
    );
    const input = screen.getByRole("textbox", { name: "Message input" });
    fireEvent.change(input, { target: { value: "fix #1" } });
    (input as HTMLTextAreaElement).setSelectionRange(6, 6);
    await waitFor(() => expect(searched).toHaveBeenCalledWith("1"));
    expect(screen.getByRole("listbox", { name: "GitHub suggestions" })).toBeTruthy();
  });

  test("a bare # opens its list, and the list closes once a space makes the # a heading", async () => {
    render(
      <RuntimeHarness>
        <MentionTriggerSlot
          {...quiet}
          providers={[realGithubProvider()]}
          onSelect={() => undefined}
        >
          <ComposerSurface submitPrompt={async () => undefined} cancel={() => undefined} />
        </MentionTriggerSlot>
      </RuntimeHarness>,
    );
    const input = screen.getByRole("textbox", { name: "Message input" }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "#" } });
    input.setSelectionRange(1, 1);
    expect(await screen.findByRole("listbox", { name: "GitHub suggestions" })).toBeTruthy();
    fireEvent.change(input, { target: { value: "# " } });
    input.setSelectionRange(2, 2);
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  });

  test("a heading typed as '# Plan' opens no list, and Enter sends it instead of erasing it", async () => {
    const submitPrompt = vi.fn(async () => undefined);
    render(
      <RuntimeHarness>
        <MentionTriggerSlot
          {...quiet}
          providers={[realGithubProvider()]}
          onSelect={() => undefined}
        >
          <ComposerSurface submitPrompt={submitPrompt} cancel={() => undefined} />
        </MentionTriggerSlot>
      </RuntimeHarness>,
    );
    const input = screen.getByRole("textbox", { name: "Message input" }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "# Plan" } });
    input.setSelectionRange(6, 6);
    await pause();
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(submitPrompt).toHaveBeenCalledWith({
        mode: "prompt",
        text: "# Plan",
        delivery: "new",
      }),
    );
  });

  test("the file list is named File suggestions, not the raw @ syntax", async () => {
    const files: MentionProvider = {
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
    render(
      <RuntimeHarness>
        <MentionTriggerSlot {...quiet} providers={[files]} onSelect={() => undefined}>
          <ComposerSurface submitPrompt={async () => undefined} cancel={() => undefined} />
        </MentionTriggerSlot>
      </RuntimeHarness>,
    );
    const input = screen.getByRole("textbox", { name: "Message input" });
    fireEvent.change(input, { target: { value: "before @src" } });
    (input as HTMLTextAreaElement).setSelectionRange(11, 11);
    expect(await screen.findByRole("listbox", { name: "File suggestions" })).toBeTruthy();
  });

  test("an unavailable search shows its reason in place of a row, so Enter sends the text", async () => {
    const result: TriggerSearchResult = {
      state: "unavailable",
      candidates: [],
      error: {
        state: "unavailable",
        error: {
          code: "unavailable",
          message: "File search is unavailable here.",
          retryable: false,
        },
      },
    };
    const files: MentionProvider = {
      trigger: "@",
      kind: "file",
      source: "a1.file-search",
      search: async () => [],
      searchTyped: async () => result,
    };
    const submitPrompt = vi.fn(async () => undefined);
    render(
      <RuntimeHarness>
        <MentionTriggerSlot {...quiet} providers={[files]} onSelect={() => undefined}>
          <ComposerSurface submitPrompt={submitPrompt} cancel={() => undefined} />
        </MentionTriggerSlot>
      </RuntimeHarness>,
    );
    const input = screen.getByRole("textbox", { name: "Message input" }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "before @src" } });
    input.setSelectionRange(11, 11);
    expect(await screen.findByText("File search is unavailable here.")).toBeTruthy();
    expect(screen.queryByRole("option")).toBeNull();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(submitPrompt).toHaveBeenCalledWith({
        mode: "prompt",
        text: "before @src",
        delivery: "new",
      }),
    );
  });

  test("Move cursor to message start removes the # and puts the caret at the start of the message", async () => {
    render(
      <RuntimeHarness>
        <MentionTriggerSlot
          {...quiet}
          providers={[realGithubProvider()]}
          onSelect={() => undefined}
        >
          <ComposerSurface submitPrompt={async () => undefined} cancel={() => undefined} />
        </MentionTriggerSlot>
      </RuntimeHarness>,
    );
    const input = screen.getByRole("textbox", { name: "Message input" }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "hello #" } });
    input.setSelectionRange(7, 7);
    fireEvent.click(await screen.findByText("Move cursor to message start"));
    await waitFor(() => expect(input.value).toBe("hello "));
    expect(input.selectionStart).toBe(0);
  });

  test("Copy current line copies the line the # sits on, without the #, and says so", async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const notify = vi.fn();
    try {
      render(
        <RuntimeHarness>
          <MentionTriggerSlot
            {...quiet}
            notify={notify}
            providers={[realGithubProvider()]}
            onSelect={() => undefined}
          >
            <ComposerSurface submitPrompt={async () => undefined} cancel={() => undefined} />
          </MentionTriggerSlot>
        </RuntimeHarness>,
      );
      const input = screen.getByRole("textbox", { name: "Message input" }) as HTMLTextAreaElement;
      fireEvent.change(input, { target: { value: "first line\nsecond #" } });
      input.setSelectionRange(19, 19);
      fireEvent.click(await screen.findByText("Copy current line"));
      await waitFor(() => expect(notify).toHaveBeenCalledWith("Copied the current line."));
      expect(writeText).toHaveBeenCalledWith("second ");
      expect(input.value).toBe("first line\nsecond ");
    } finally {
      Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  test("Undo reverts the last word typed before the #", async () => {
    render(
      <RuntimeHarness>
        <MentionTriggerSlot
          {...quiet}
          providers={[realGithubProvider()]}
          onSelect={() => undefined}
        >
          <ComposerSurface submitPrompt={async () => undefined} cancel={() => undefined} />
        </MentionTriggerSlot>
      </RuntimeHarness>,
    );
    const input = screen.getByRole("textbox", { name: "Message input" }) as HTMLTextAreaElement;
    let typed = "";
    for (const character of "hello world #") {
      pressKey(input, character, `${typed}${character}`);
      typed += character;
    }
    fireEvent.click(await screen.findByText("Undo"));
    await waitFor(() => expect(input.value).toBe("hello "));
  });

  test("Undo with nothing typed before the # says so and leaves the text as it is", async () => {
    const notify = vi.fn();
    render(
      <RuntimeHarness>
        <MentionTriggerSlot
          {...quiet}
          notify={notify}
          providers={[realGithubProvider()]}
          onSelect={() => undefined}
        >
          <ComposerSurface submitPrompt={async () => undefined} cancel={() => undefined} />
        </MentionTriggerSlot>
      </RuntimeHarness>,
    );
    const input = screen.getByRole("textbox", { name: "Message input" }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "#" } });
    input.setSelectionRange(1, 1);
    fireEvent.click(await screen.findByText("Undo"));
    await waitFor(() => expect(notify).toHaveBeenCalledWith("There is nothing to undo."));
    expect(input.value).toBe("");
  });

  test("a GitHub row is inserted as its link, not run as an action", async () => {
    const result: TriggerSearchResult = {
      state: "ready",
      candidates: [
        {
          id: "github:current:issue:12",
          kind: "github",
          source: "a1.github-refs",
          label: "issue #12",
          insertText: "issue://12 ",
        },
      ],
    };
    const github: MentionProvider = {
      trigger: "#",
      kind: "github",
      source: "a1.github-refs",
      search: async () => [],
      searchTyped: async () => result,
    };
    render(
      <RuntimeHarness>
        <MentionTriggerSlot {...quiet} providers={[github]} onSelect={() => undefined}>
          <ComposerSurface submitPrompt={async () => undefined} cancel={() => undefined} />
        </MentionTriggerSlot>
      </RuntimeHarness>,
    );
    const input = screen.getByRole("textbox", { name: "Message input" }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "see #12" } });
    input.setSelectionRange(7, 7);
    fireEvent.click(await screen.findByText("issue #12"));
    await waitFor(() => expect(input.value).toBe("see issue://12 "));
  });
});
