import {
  AssistantRuntimeProvider,
  type ThreadMessage,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import type { AppClient } from "@omp-app/client";
import { FolderPath } from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ComposerSurface } from "../../U2/composer/composer";
import type { MentionProvider, TriggerSearchResult } from "../contract";
import { createGithubMentionProvider } from "./mentions";
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

  test("with no provider offered, @ and # open no popover and typing is untouched", async () => {
    render(
      <RuntimeHarness>
        <MentionTriggerSlot providers={[]} onSelect={() => undefined}>
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

  test("an unavailable search shows its row and never No matches", async () => {
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
        <MentionTriggerSlot providers={[files]} onSelect={() => undefined}>
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

  test("a # with a space that finds nothing closes its list: it is prose, not a reference", async () => {
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
        <MentionTriggerSlot providers={[github]} onSelect={() => undefined}>
          <ComposerSurface submitPrompt={async () => undefined} cancel={() => undefined} />
        </MentionTriggerSlot>
      </RuntimeHarness>,
    );
    const input = screen.getByRole("textbox", { name: "Message input" });
    const typed = "ticket #12 i";
    fireEvent.change(input, { target: { value: typed } });
    (input as HTMLTextAreaElement).setSelectionRange(typed.length, typed.length);
    await waitFor(() => expect(searched).toHaveBeenCalledWith("12"));
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    expect((input as HTMLTextAreaElement).value).toBe(typed);
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
        <MentionTriggerSlot providers={[github]} onSelect={() => undefined}>
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
        <MentionTriggerSlot providers={[realGithubProvider()]} onSelect={() => undefined}>
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
        <MentionTriggerSlot providers={[realGithubProvider()]} onSelect={() => undefined}>
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
        <MentionTriggerSlot providers={[files]} onSelect={() => undefined}>
          <ComposerSurface submitPrompt={async () => undefined} cancel={() => undefined} />
        </MentionTriggerSlot>
      </RuntimeHarness>,
    );
    const input = screen.getByRole("textbox", { name: "Message input" });
    fireEvent.change(input, { target: { value: "before @src" } });
    (input as HTMLTextAreaElement).setSelectionRange(11, 11);
    expect(await screen.findByRole("listbox", { name: "File suggestions" })).toBeTruthy();
  });
});
