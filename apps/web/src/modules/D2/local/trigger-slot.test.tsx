import {
  AssistantRuntimeProvider,
  type ThreadMessage,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { ComposerSurface } from "../../U2/composer/composer";
import { createEmojiProvider } from "./emoji";
import type { LocalProvider } from "./provider";
import { LocalTriggerSlot } from "./trigger-slot";

afterEach(() => cleanup());

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
});
