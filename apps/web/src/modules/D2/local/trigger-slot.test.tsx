import {
  AssistantRuntimeProvider,
  type ThreadMessage,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import type { AppClient } from "@omp-app/client";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ComposerSurface } from "../../U2/composer/composer";
import type { TriggerSearchResult } from "../contract";
import { createEmojiProvider } from "./emoji";
import type { LocalProvider } from "./provider";
import { LocalTriggerSlot } from "./trigger-slot";
import { createInternalUrlProvider } from "./urls";

afterEach(() => cleanup());

/** Lets a pending search answer and the popover settle before a negative assertion. */
function pause(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  // Longer than the 60 ms debounce, so a search that was started has answered by then.
  setTimeout(resolve, 200);
  return promise;
}

function RuntimeHarness({ children }: { readonly children: React.ReactNode }) {
  const runtime = useExternalStoreRuntime({
    messages: [] as readonly ThreadMessage[],
    onNew: async () => undefined,
    onCancel: async () => undefined,
  });
  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}

describe("D2.5 LocalTriggerSlot", () => {
  test("uses the shared popover path for emoji completion", async () => {
    const selected: string[] = [];
    render(
      <RuntimeHarness>
        <LocalTriggerSlot
          providers={[createEmojiProvider()]}
          onSelect={(candidate) => selected.push(candidate.label)}
        >
          <ComposerSurface submitPrompt={async () => undefined} cancel={() => undefined} />
        </LocalTriggerSlot>
      </RuntimeHarness>,
    );
    const input = screen.getByRole("textbox", { name: "Message input" });
    fireEvent.change(input, { target: { value: "say :smil" } });
    await waitFor(() => expect(screen.getByText(/:smile:/)).toBeTruthy());
    fireEvent.click(screen.getByText(/:smile:/));
    await waitFor(() => expect(selected).toContain("😄  :smile:"));
    expect((input as HTMLTextAreaElement).value).toBe("say 😄 ");
  });

  test("accepts a scheme provider through the same local slot", async () => {
    const provider: LocalProvider = {
      trigger: "://",
      kind: "internal-url",
      source: "a1.url-catalog",
      search: async () => [],
      searchTyped: async () => ({
        state: "ready",
        candidates: [
          {
            id: "url:skill://review",
            kind: "internal-url",
            source: "a1.url-catalog",
            label: "Review skill",
            insertText: "skill://review ",
          },
        ],
      }),
    };
    render(
      <RuntimeHarness>
        <LocalTriggerSlot providers={[provider]} onSelect={() => undefined}>
          <ComposerSurface submitPrompt={async () => undefined} cancel={() => undefined} />
        </LocalTriggerSlot>
      </RuntimeHarness>,
    );
    const input = screen.getByRole("textbox", { name: "Message input" });
    fireEvent.change(input, { target: { value: "open skill://rev" } });
    await waitFor(() => expect(screen.getByRole("listbox")).toBeTruthy());
  });

  test("with no provider offered, : and scheme triggers open no popover and typing is untouched", async () => {
    render(
      <RuntimeHarness>
        <LocalTriggerSlot providers={[]} onSelect={() => undefined}>
          <ComposerSurface submitPrompt={async () => undefined} cancel={() => undefined} />
        </LocalTriggerSlot>
      </RuntimeHarness>,
    );
    const input = screen.getByRole("textbox", { name: "Message input" });
    for (const typed of ["say :smil", "open skill://rev"]) {
      fireEvent.change(input, { target: { value: typed } });
      (input as HTMLTextAreaElement).setSelectionRange(typed.length, typed.length);
      await pause();
      expect(screen.queryByRole("listbox")).toBeNull();
      expect(screen.queryByText("No matches")).toBeNull();
      expect((input as HTMLTextAreaElement).value).toBe(typed);
    }
  });

  test("an unavailable URL search shows its row and never No matches", async () => {
    const result: TriggerSearchResult = {
      state: "unavailable",
      candidates: [],
      error: {
        state: "unavailable",
        error: {
          code: "unavailable",
          message: "Looking up issues and pull requests isn't available here.",
          retryable: false,
        },
      },
    };
    const searched = vi.fn(async (_query: string) => result);
    const provider: LocalProvider = {
      trigger: "://",
      kind: "internal-url",
      source: "a1.url-catalog",
      search: async () => [],
      searchTyped: searched,
    };
    render(
      <RuntimeHarness>
        <LocalTriggerSlot providers={[provider]} onSelect={() => undefined}>
          <ComposerSurface submitPrompt={async () => undefined} cancel={() => undefined} />
        </LocalTriggerSlot>
      </RuntimeHarness>,
    );
    const input = screen.getByRole("textbox", { name: "Message input" });
    fireEvent.change(input, { target: { value: "see issue://12" } });
    (input as HTMLTextAreaElement).setSelectionRange(15, 15);
    await waitFor(() => expect(searched).toHaveBeenCalledWith("issue://12"));
    expect(
      await screen.findByText("Looking up issues and pull requests isn't available here."),
    ).toBeTruthy();
    expect(screen.getByRole("listbox")).toBeTruthy();
    expect(screen.queryByText("No matches")).toBeNull();
    expect((input as HTMLTextAreaElement).value).toBe("see issue://12");
  });

  test("the emoji list is named Emoji suggestions", async () => {
    render(
      <RuntimeHarness>
        <LocalTriggerSlot providers={[createEmojiProvider()]} onSelect={() => undefined}>
          <ComposerSurface submitPrompt={async () => undefined} cancel={() => undefined} />
        </LocalTriggerSlot>
      </RuntimeHarness>,
    );
    const input = screen.getByRole("textbox", { name: "Message input" });
    fireEvent.change(input, { target: { value: "say :smil" } });
    (input as HTMLTextAreaElement).setSelectionRange(9, 9);
    expect(await screen.findByRole("listbox", { name: "Emoji suggestions" })).toBeTruthy();
  });

  test("a scheme the provider does not serve opens no list, while a served scheme still does", async () => {
    const client = {
      port: () => ({ list: async () => ({ resources: [], revision: "r1" }) }),
    } as unknown as AppClient;
    const provider = createInternalUrlProvider({ client });
    render(
      <RuntimeHarness>
        <LocalTriggerSlot providers={[provider]} onSelect={() => undefined}>
          <ComposerSurface submitPrompt={async () => undefined} cancel={() => undefined} />
        </LocalTriggerSlot>
      </RuntimeHarness>,
    );
    const input = screen.getByRole("textbox", { name: "Message input" });
    fireEvent.change(input, { target: { value: "see issue://" } });
    (input as HTMLTextAreaElement).setSelectionRange(12, 12);
    expect(screen.queryByRole("listbox")).toBeNull();
    await pause();
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.queryByText("No matches")).toBeNull();
    fireEvent.change(input, { target: { value: "open skill://" } });
    (input as HTMLTextAreaElement).setSelectionRange(13, 13);
    expect(await screen.findByRole("listbox", { name: "Link suggestions" })).toBeTruthy();
  });
});
