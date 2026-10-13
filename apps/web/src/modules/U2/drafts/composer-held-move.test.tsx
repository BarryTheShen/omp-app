import { AppFailure, FolderPath, ThreadId } from "@omp-app/contracts";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { useEffect, useMemo, useState } from "react";
import { afterEach, describe, expect, test } from "vitest";
import type { PromptIntent } from "../../R0/runtime/runtime";
import { ScopedDraftStore } from "./test-support";
import { type ChatMessagesSource, type UseChatDraftResult, useChatDraft } from "./use-chat-draft";
import { useComposerDraft } from "./use-composer-draft";

afterEach(cleanup);

const folder = FolderPath.parse("/workspace/app");
const threadId = ThreadId.parse("chat-held");
const HELD =
  "/compact wasn't sent because omp's command list could not be read. omp could not list its commands.";

const noAttachments = {
  restore: async () => undefined,
  dropPending: () => undefined,
  toDraftRefs: () => [],
  getState: () => ({ pending: [], complete: [], error: null }),
  subscribe: () => () => undefined,
};

/** A chat with no messages yet. */
const NO_MESSAGES: ChatMessagesSource = {
  subscribe: () => () => undefined,
  getSnapshot: () => ({ messageOrder: [] }),
};

/** A store whose clear waits while held: a chat's draft move waits at the store, as it does on a slow server. */
class GatedClearStore extends ScopedDraftStore {
  clearCalls = 0;
  private gate: Promise<void> | undefined;
  private open: (() => void) | undefined;

  hold(): void {
    this.gate = new Promise<void>((resolve) => {
      this.open = resolve;
    });
  }

  release(): void {
    this.open?.();
    this.gate = undefined;
  }

  override async clear(args: Parameters<ScopedDraftStore["clear"]>[0]) {
    this.clearCalls += 1;
    if (this.gate !== undefined) await this.gate;
    return super.clear(args);
  }
}

/** What the test sees and does, as the composer's keystrokes and sends would. */
interface Shown {
  text: string;
  type(text: string): void;
  submit: UseChatDraftResult["submit"];
  scope(): unknown;
}

/** A new chat's composer, bound the way the app binds it: the chat's draft, and the composer's text. */
function NewChatComposer({
  store,
  loaded,
  shown,
}: {
  readonly store: ScopedDraftStore;
  readonly loaded: boolean;
  readonly shown: Shown;
}) {
  const draft = useChatDraft({
    draftStore: store,
    folder,
    threadId,
    messages: NO_MESSAGES,
    loaded,
  });
  const [text, setText] = useState("");
  const composer = useMemo(() => ({ setText }), []);
  useEffect(() => {
    void draft.controller.load();
  }, [draft.controller]);
  shown.text = text;
  shown.type = setText;
  shown.submit = draft.submit;
  shown.scope = () => draft.controller.getSnapshot().scope;
  useComposerDraft({
    chat: draft.chat,
    controller: draft.controller,
    text,
    composer,
    attachments: noAttachments,
    isRecalledPrompt: () => false,
  });
  return null;
}

const prompt = (text: string): PromptIntent => ({ mode: "prompt", text, delivery: "new" });

describe("a new chat's draft moves while the person types (#1477)", () => {
  test("text typed while the chat's draft moves is what the composer keeps; the held command does not come back over it", async () => {
    const store = new GatedClearStore();
    const shown: Shown = {
      text: "",
      type: () => undefined,
      submit: async () => undefined,
      scope: () => undefined,
    };
    const view = render(<NewChatComposer store={store} loaded={false} shown={shown} />);
    await waitFor(() => expect(shown.scope()).toEqual({ kind: "thread", threadId }));

    // The person types a command and sends it. omp's command list cannot be read, so the send is held and the text stays.
    act(() => shown.type("/compact"));
    await act(async () => {
      await shown
        .submit(prompt("/compact"), async () => {
          throw new AppFailure({ code: "unavailable", message: HELD, retryable: true });
        })
        .catch(() => undefined);
    });
    expect(store.text({ kind: "thread", threadId })).toBe("/compact");

    // The chat finishes loading: its draft moves to the folder's new-chat draft, and the move waits at the store.
    store.hold();
    await act(async () => {
      view.rerender(<NewChatComposer store={store} loaded={true} shown={shown} />);
    });
    await waitFor(() => expect(store.clearCalls).toBe(1));

    // The person types the next message while the move waits.
    act(() => shown.type("hello there"));
    store.release();

    await waitFor(() => expect(shown.scope()).toEqual({ kind: "folder", folder }));
    await waitFor(() => expect(shown.text).toBe("hello there"));
  });
});
