import { type AttachmentRef, type DraftScope, ThreadId } from "@omp-app/contracts";
import { cleanup, render, waitFor } from "@testing-library/react";
import { useMemo, useState } from "react";
import { afterEach, describe, expect, test } from "vitest";
import { DraftController, type DraftTimer } from "../../U2/drafts/drafts";
import { ScopedDraftStore } from "../../U2/drafts/test-support";
import { useComposerDraft } from "../../U2/drafts/use-composer-draft";
import { composerDraftOf } from "./composer";

afterEach(cleanup);

// Autosave never fires here: every write happens at a step the test takes.
const noTimers: DraftTimer = { setTimeout: () => undefined, clearTimeout: () => undefined };

function chatScope(id: string): DraftScope {
  return { kind: "thread", threadId: ThreadId.parse(id) };
}

async function loadedController(id: string): Promise<DraftController> {
  const controller = new DraftController({
    store: new ScopedDraftStore(),
    scope: chatScope(id),
    timers: noTimers,
  });
  await controller.load();
  return controller;
}

const NO_ATTACHMENTS = { pending: [], complete: [], error: null };
const noAttachments = {
  restore: async () => undefined,
  dropPending: () => undefined,
  toDraftRefs: (): AttachmentRef[] => [],
  getState: () => NO_ATTACHMENTS,
  subscribe: () => () => undefined,
};

/** The composer as the app binds it: the text it shows is recorded, so the test can read what the person sees. */
function Composer({
  chat,
  controller,
  shown,
}: {
  readonly chat: object;
  readonly controller: DraftController;
  readonly shown: { text: string };
}) {
  const [text, setText] = useState("");
  const composer = useMemo(() => ({ setText }), []);
  shown.text = text;
  useComposerDraft({
    chat,
    controller,
    text,
    composer,
    attachments: noAttachments,
    isRecalledPrompt: () => false,
  });
  return null;
}

describe("the interview's goal text in the chat's composer", () => {
  test("the goal text written through the sink is the text the composer shows, and the draft holds it", async () => {
    const controller = await loadedController("thread-composer-shows");
    const shown = { text: "" };
    render(<Composer chat={{}} controller={controller} shown={shown} />);

    await composerDraftOf(() => controller).write("## Objective\nShip the parser");

    await waitFor(() => expect(shown.text).toBe("## Objective\nShip the parser"));
    expect(controller.getSnapshot().text).toBe("## Objective\nShip the parser");
  });

  test("after the chat's draft moves to another controller, the sink writes to that one and the composer shows it", async () => {
    const first = await loadedController("thread-composer-first");
    const second = await loadedController("thread-composer-second");
    const chat = {};
    let current = first;
    const shown = { text: "" };
    const sink = composerDraftOf(() => current);
    const view = render(<Composer chat={chat} controller={first} shown={shown} />);

    // The same chat, with its draft moved to the other controller: the identity stays, only the controller changes.
    current = second;
    view.rerender(<Composer chat={chat} controller={second} shown={shown} />);
    await sink.write("Moved goal text");

    await waitFor(() => expect(shown.text).toBe("Moved goal text"));
    expect(second.getSnapshot().text).toBe("Moved goal text");
    expect(first.getSnapshot().text).toBe("");
  });
});
