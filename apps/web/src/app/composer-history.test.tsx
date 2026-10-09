import {
  AssistantRuntimeProvider,
  type ThreadMessage,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import type { AppClient } from "@omp-app/client";
import type { EntryId, ThreadId } from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test } from "vitest";
import { OmpRuntimeStore } from "@/modules/R0/store";
import { ComposerSurface } from "@/modules/U2/composer";
import { ComposerHistory } from "./composer-history";
import { ComposerTriggers } from "./composer-triggers";

const threadId = "history-app-thread" as ThreadId;

/** Never asked: with no folder and no capabilities the composer offers no file or URL trigger. */
const client = {} as unknown as AppClient;

/** A chat whose user sent `prompts` in order, the last one newest. */
function chatWith(prompts: readonly string[]): OmpRuntimeStore {
  const store = new OmpRuntimeStore({ threadId });
  const entries = prompts.map((content, index) => ({
    type: "message",
    id: `prompt-${index}`,
    parentId: index === 0 ? null : `prompt-${index - 1}`,
    timestamp: "2026-10-05T00:00:00.000Z",
    message: { role: "user", content, timestamp: 1 },
  }));
  store.pairEndedMessages(entries, entries[entries.length - 1]?.id as EntryId);
  return store;
}

function RuntimeHarness({ children }: { readonly children: ReactNode }) {
  const runtime = useExternalStoreRuntime({
    messages: [] as readonly ThreadMessage[],
    onNew: async () => undefined,
    onCancel: async () => undefined,
  });
  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}

/** The composer as root.tsx mounts it: the trigger slots around prompt history around the composer. */
function Composed({ store }: { readonly store: OmpRuntimeStore }) {
  return (
    <RuntimeHarness>
      <ComposerTriggers capabilities={{}} client={client} folder={null}>
        <ComposerHistory store={store}>
          <ComposerSurface submitPrompt={async () => undefined} cancel={() => undefined} />
        </ComposerHistory>
      </ComposerTriggers>
    </RuntimeHarness>
  );
}

function composerInput(): HTMLTextAreaElement {
  return screen.getByRole("textbox", { name: "Message input" }) as HTMLTextAreaElement;
}

/**
 * Lets a recalled prompt reach the textarea and the caret be placed, as the next frame does in a
 * browser; the next key press reads the caret from there.
 */
function nextFrame(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  requestAnimationFrame(() => resolve());
  return promise;
}

afterEach(() => cleanup());

describe("prompt history in the app's composer", () => {
  test("Up recalls the newest prompt, Up again goes back, Down walks forward and restores the empty draft", async () => {
    render(<Composed store={chatWith(["hello probe", "second probe"])} />);
    const composer = composerInput();
    composer.focus();

    fireEvent.keyDown(composer, { key: "ArrowUp" });
    expect(composer.value).toBe("second probe");
    await nextFrame();
    fireEvent.keyDown(composer, { key: "ArrowUp" });
    expect(composer.value).toBe("hello probe");
    await nextFrame();
    fireEvent.keyDown(composer, { key: "ArrowDown" });
    expect(composer.value).toBe("second probe");
    await nextFrame();
    fireEvent.keyDown(composer, { key: "ArrowDown" });
    expect(composer.value).toBe("");
  });

  test("a typed draft is recalled over, and Down restores it", async () => {
    render(<Composed store={chatWith(["hello probe"])} />);
    const composer = composerInput();
    fireEvent.change(composer, { target: { value: "my draft" } });
    composer.setSelectionRange(0, 0);

    fireEvent.keyDown(composer, { key: "ArrowUp" });
    expect(composer.value).toBe("hello probe");
    await nextFrame();
    composer.setSelectionRange(composer.value.length, composer.value.length);
    fireEvent.keyDown(composer, { key: "ArrowDown" });
    expect(composer.value).toBe("my draft");
  });

  test("inside a multi-line prompt, Down belongs to the caret until the caret is on the last line", async () => {
    render(<Composed store={chatWith(["older", "first line\nsecond line"])} />);
    const composer = composerInput();
    fireEvent.keyDown(composer, { key: "ArrowUp" });
    expect(composer.value).toBe("first line\nsecond line");
    await nextFrame();

    fireEvent.keyDown(composer, { key: "ArrowDown" });
    expect(composer.value).toBe("first line\nsecond line");

    composer.setSelectionRange(composer.value.length, composer.value.length);
    fireEvent.keyDown(composer, { key: "ArrowDown" });
    expect(composer.value).toBe("");
  });

  test("an open trigger list keeps Down: the recalled prompt is not replaced", async () => {
    render(<Composed store={chatWith(["pick :sm"])} />);
    const composer = composerInput();
    fireEvent.keyDown(composer, { key: "ArrowUp" });
    expect(composer.value).toBe("pick :sm");
    await nextFrame();

    composer.setSelectionRange(8, 8);
    fireEvent.select(composer);
    await screen.findByRole("listbox", { name: "Emoji suggestions" });
    fireEvent.keyDown(composer, { key: "ArrowDown" });
    expect(composer.value).toBe("pick :sm");
    expect(screen.getByRole("listbox", { name: "Emoji suggestions" })).toBeTruthy();
  });

  test("text typed over a recalled prompt is kept: Down does not restore the draft", async () => {
    render(<Composed store={chatWith(["hello probe"])} />);
    const composer = composerInput();
    fireEvent.keyDown(composer, { key: "ArrowUp" });
    expect(composer.value).toBe("hello probe");
    await nextFrame();

    fireEvent.change(composer, { target: { value: "hello probe, again" } });
    composer.setSelectionRange(composer.value.length, composer.value.length);
    fireEvent.keyDown(composer, { key: "ArrowDown" });
    expect(composer.value).toBe("hello probe, again");
  });
});
