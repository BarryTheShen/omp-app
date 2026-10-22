// Stand-in texts are test inputs that omp or the transport would send; no production file emits them. Each row proves
// that P3 keeps the code, message and retryable flag it is given, and that it maps the source and the branch the way the
// row names. The branch and get_branch_messages shapes are omp v18.8.9's (fixtures/omp-branch.ts cites each one).
import type { CapabilityKey, ThreadId } from "@omp-app/contracts";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  ASSISTANT_ANSWER,
  BRANCH_ACCEPTED,
  BRANCH_CANCELLED,
  BRANCHED_CHAT,
  PNG_IMAGE,
  SOURCE_CHAT,
  USER_WITH_IMAGE,
} from "../fixtures/omp-branch";
import type { P3FailedState } from "../runs/status";
import { P3RunStatusSurface } from "../runs/view";
import { PreviousMessageSelectorView } from "../selector/view";
import { editAppend, failure, type RunHarness, renderRun, rowKeyOf } from "./run-harness";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const EDIT_TEXT = "Explain again";
const BRANCH_CAPABILITY = "omp.cmd.branch" satisfies CapabilityKey;

/** The failure the run ended in; the test fails if the run is in a different phase. */
function failedOf(run: RunHarness): P3FailedState {
  const state = run.runs.status.getSnapshot();
  if (state.phase !== "failed") throw new Error(`expected a failed run, got ${state.phase}`);
  return state;
}

/** The notice the person sees in `threadId`: the app's own status surface, bound to this run. */
function showNotice(run: RunHarness, threadId: ThreadId) {
  return render(
    <P3RunStatusSurface
      onOpenSource={async () => undefined}
      onRetry={run.handlers.retry}
      runs={run.runs}
      threadId={threadId}
    />,
  );
}

/** Edit the image-and-text message in the source chat, the way the person's Enter does. */
async function editFromSource(run: RunHarness): Promise<void> {
  await act(async () => {
    await run.handlers.onEdit(editAppend(String(USER_WITH_IMAGE), EDIT_TEXT, [PNG_IMAGE]));
  });
}

describe("failure matrix: the message the person sees, and what the run keeps", () => {
  test("omp cancels the branch: nothing is sent past the branch, no success shows, and no new chat opens", async () => {
    const run = renderRun({ branch: [BRANCH_CANCELLED] });

    await editFromSource(run);

    expect(run.sent.map((command) => command.type)).toEqual(["branch"]);
    expect(run.opened).toEqual([]);
    expect(run.chats.size).toBe(0);
    expect(run.runs.status.getSnapshot().phase).not.toBe("sent");
  });

  test("omp cancels the branch: a silent no-op, with no notice (spec §5.5)", async () => {
    const run = renderRun({ branch: [BRANCH_CANCELLED] });

    await editFromSource(run);

    expect(run.runs.status.getSnapshot().phase).toBe("idle");
  });

  test("omp cannot run the branch: its message shows with no retry, and nothing else is sent", async () => {
    const run = renderRun({
      branch: [
        failure(
          "unavailable",
          "test stand-in: branch refused as unavailable",
          false,
          BRANCH_CAPABILITY,
        ),
      ],
    });

    await editFromSource(run);
    showNotice(run, SOURCE_CHAT);

    expect(run.sent.map((command) => command.type)).toEqual(["branch"]);
    expect(run.opened).toEqual([]);
    expect(failedOf(run)).toMatchObject({
      message: "test stand-in: branch refused as unavailable",
      retryable: false,
      branched: false,
    });
    expect(screen.getByText("test stand-in: branch refused as unavailable")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(screen.getByText("Your text is kept here:")).toBeTruthy();
  });

  test("omp refuses the branch: Try again branches once more and sends the edit once", async () => {
    const run = renderRun({
      branch: [
        failure("omp_error", "test stand-in: omp refused the branch", true),
        BRANCH_ACCEPTED,
      ],
    });

    await editFromSource(run);
    const refused = failedOf(run);
    showNotice(run, SOURCE_CHAT);

    expect(refused).toMatchObject({
      message: "test stand-in: omp refused the branch",
      retryable: true,
      branched: false,
      chatThreadId: SOURCE_CHAT,
    });
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();

    await act(async () => {
      await run.handlers.retry(refused);
    });

    expect(run.sent.filter((command) => command.type === "branch")).toHaveLength(2);
    expect(run.chats.get(String(BRANCHED_CHAT))?.admitted).toHaveLength(1);
    expect(run.runs.status.getSnapshot()).toMatchObject({ phase: "sent", threadId: BRANCHED_CHAT });
  });

  test.each([
    { when: "before omp accepts the branch", branched: false, retryable: true },
    { when: "before omp accepts the branch", branched: false, retryable: false },
    { when: "after omp accepts the branch", branched: true, retryable: true },
    { when: "after omp accepts the branch", branched: true, retryable: false },
  ])(
    "omp_exited $when remains plain and preserves retryable=$retryable",
    async ({ branched, retryable }) => {
      const message = "omp stopped unexpectedly. Try again.";
      const run = branched
        ? renderRun({
            branch: [BRANCH_ACCEPTED],
            getState: failure("omp_exited", message, retryable),
          })
        : renderRun({ branch: [failure("omp_exited", message, retryable)] });

      await editFromSource(run);
      const failed = failedOf(run);
      showNotice(run, failed.chatThreadId);

      expect(failed).toMatchObject({
        message,
        retryable,
        branched,
        chatThreadId: SOURCE_CHAT,
      });
      expect(failed.message).not.toMatch(/RPC|transport|typed|omp_exited/i);
      expect(screen.getByText(message, { exact: true })).toBeTruthy();
      if (retryable) expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
      else expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    },
  );

  test("the chat changed while omp branched: the failure is retryable, and nothing is sent past the branch", async () => {
    const run = renderRun({
      branch: [failure("conflict", "test stand-in: the chat changed", true)],
    });

    await editFromSource(run);

    expect(run.sent.map((command) => command.type)).toEqual(["branch"]);
    expect(run.opened).toEqual([]);
    expect(failedOf(run)).toMatchObject({
      message: "test stand-in: the chat changed",
      retryable: true,
      branched: false,
      chatThreadId: SOURCE_CHAT,
    });
  });

  test("a Try again whose new chat is no longer open is refused as a conflict, and nothing is branched or sent", async () => {
    const run = renderRun({
      branch: [
        BRANCH_ACCEPTED,
        failure("omp_error", "test stand-in: omp refused the second branch", true),
      ],
      promptFailures: [failure("omp_error", "test stand-in: prompt refused", true)],
    });

    await editFromSource(run);
    const refused = failedOf(run);
    expect(refused).toMatchObject({ branched: true, chatThreadId: BRANCHED_CHAT });

    // A newer edit starts and omp refuses its branch, so no chat is open for the first run any more.
    await editFromSource(run);
    expect(failedOf(run)).toMatchObject({
      branched: false,
      message: "test stand-in: omp refused the second branch",
    });

    await act(async () => {
      await run.handlers.retry(refused);
    });

    expect(failedOf(run)).toMatchObject({
      message: "No new chat is open for this message.",
      retryable: false,
      branched: false,
    });
    expect(run.sent.filter((command) => command.type === "branch")).toHaveLength(2);
    expect(run.chats.get(String(BRANCHED_CHAT))?.attempts).toHaveLength(1);
  });

  test("the new chat never opens: the send times out as retryable, and Try again sends on that chat without branching", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const run = renderRun({ mountsNewChat: false, mountTimeoutMs: 1000 });

    const pending = run.handlers.onEdit(
      editAppend(String(USER_WITH_IMAGE), EDIT_TEXT, [PNG_IMAGE]),
    );
    await vi.advanceTimersByTimeAsync(1000);
    await act(async () => {
      await pending;
    });

    const timedOut = failedOf(run);
    expect(timedOut).toMatchObject({
      message: "The new chat did not open in time. Try again.",
      retryable: true,
      branched: true,
      chatThreadId: BRANCHED_CHAT,
    });

    const chat = run.mount(BRANCHED_CHAT);
    await act(async () => {
      await run.handlers.retry(timedOut);
    });

    expect(run.sent.filter((command) => command.type === "branch")).toHaveLength(1);
    expect(chat.admitted).toHaveLength(1);
    expect(run.runs.status.getSnapshot()).toMatchObject({ phase: "sent", threadId: BRANCHED_CHAT });
  });

  test("omp refuses the prompt after the chat opened: the new chat stays selected, and Try again resends there only", async () => {
    const run = renderRun({
      promptFailures: [failure("omp_error", "test stand-in: prompt refused", true)],
    });

    await editFromSource(run);
    const refused = failedOf(run);
    showNotice(run, BRANCHED_CHAT);

    expect(refused).toMatchObject({
      message: "test stand-in: prompt refused",
      retryable: true,
      branched: true,
      chatThreadId: BRANCHED_CHAT,
    });
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open the original chat" })).toBeTruthy();
    expect(run.chats.get(String(BRANCHED_CHAT))?.admitted).toEqual([]);

    await act(async () => {
      await run.handlers.retry(refused);
    });

    expect(run.sent.filter((command) => command.type === "branch")).toHaveLength(1);
    const chat = run.chats.get(String(BRANCHED_CHAT));
    expect(chat?.attempts).toHaveLength(2);
    expect(chat?.admitted).toEqual([
      { mode: "prompt", text: EDIT_TEXT, images: [PNG_IMAGE], delivery: "new" },
    ]);
    expect(run.runs.status.getSnapshot()).toMatchObject({ phase: "sent", threadId: BRANCHED_CHAT });
  });

  test("a refused prompt whose text is omp's busy message keeps Try again, which sends once", async () => {
    const run = renderRun({
      promptFailures: [failure("agent_busy", "test stand-in: omp is still working", true)],
    });

    await editFromSource(run);
    const busy = failedOf(run);
    showNotice(run, BRANCHED_CHAT);

    expect(busy).toMatchObject({
      message: "test stand-in: omp is still working",
      retryable: true,
      branched: true,
      chatThreadId: BRANCHED_CHAT,
    });
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();

    await act(async () => {
      await run.handlers.retry(busy);
    });

    expect(run.sent.filter((command) => command.type === "branch")).toHaveLength(1);
    expect(run.chats.get(String(BRANCHED_CHAT))?.admitted).toHaveLength(1);
    expect(run.runs.status.getSnapshot()).toMatchObject({ phase: "sent", threadId: BRANCHED_CHAT });
  });
  // The producer is the browser client: a WebSocket close with code 4401 or 4403 (a refused launch token or origin, sent by
  // packages/server/src/server.ts:106-110) becomes `permission` with retryable false (packages/client/src/client.ts:452-464, the
  // flag at :462) and rejects every pending call, so a P3 call that is pending at that close gets it. packages/client/test/
  // client.test.ts:657, :671 and :711 assert its code and message, not its retryable flag (issue 1753). This row injects that
  // failure at switchChat.
  test("a refused launch token: permission is shown with its message, and the chat stays selected", async () => {
    const run = renderRun({
      openFails: failure("permission", "Launch token is not valid", false),
    });

    await editFromSource(run);
    const refused = failedOf(run);
    showNotice(run, BRANCHED_CHAT);

    expect(refused).toMatchObject({
      message: "Launch token is not valid",
      retryable: false,
      branched: true,
      chatThreadId: BRANCHED_CHAT,
    });
    expect(screen.getByText("Launch token is not valid")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(run.sent.filter((command) => command.type === "branch")).toHaveLength(1);
    expect(run.opened).toEqual([String(BRANCHED_CHAT)]);
  });

  test("a regenerate whose prompt omp refuses: the new chat stays selected, and Try again sends the same text and image once", async () => {
    const run = renderRun({
      promptFailures: [failure("omp_error", "test stand-in: prompt refused", true)],
    });

    await act(async () => {
      await run.handlers.onReload(rowKeyOf(run.store, USER_WITH_IMAGE), undefined);
    });
    const refused = failedOf(run);
    expect(refused).toMatchObject({
      kind: "regenerate",
      branched: true,
      chatThreadId: BRANCHED_CHAT,
    });

    await act(async () => {
      await run.handlers.retry(refused);
    });

    expect(run.sent.filter((command) => command.type === "branch")).toHaveLength(1);
    expect(run.chats.get(String(BRANCHED_CHAT))?.admitted).toEqual([
      { mode: "prompt", text: "Explain", images: [PNG_IMAGE], delivery: "new" },
    ]);
    expect(run.runs.status.getSnapshot()).toMatchObject({ phase: "sent", kind: "regenerate" });
  });

  test("the new chat fails to open after omp branched: an internal error shows the generic message, and Try again sends on that chat without branching", async () => {
    const run = renderRun({ openFails: new Error("test stand-in: the chat could not open") });

    await editFromSource(run);
    const unopened = failedOf(run);
    showNotice(run, BRANCHED_CHAT);

    expect(unopened).toMatchObject({
      message: "The message could not be sent. Try again.",
      retryable: true,
      branched: true,
      chatThreadId: BRANCHED_CHAT,
    });
    expect(screen.queryByText("test stand-in: the chat could not open")).toBeNull();
    expect(run.chats.size).toBe(0);

    const chat = run.mount(BRANCHED_CHAT);
    await act(async () => {
      await run.handlers.retry(unopened);
    });

    expect(run.sent.filter((command) => command.type === "branch")).toHaveLength(1);
    expect(chat.admitted).toHaveLength(1);
    expect(run.runs.status.getSnapshot()).toMatchObject({ phase: "sent", threadId: BRANCHED_CHAT });
  });

  test("the new chat's saved model is unavailable: model_unavailable is shown with no Try again, and the branch stays selected", async () => {
    const run = renderRun({
      openFails: failure(
        "model_unavailable",
        "test stand-in: the chat's model is unavailable",
        false,
      ),
    });

    await editFromSource(run);
    showNotice(run, BRANCHED_CHAT);

    expect(failedOf(run)).toMatchObject({
      message: "test stand-in: the chat's model is unavailable",
      retryable: false,
      branched: true,
      chatThreadId: BRANCHED_CHAT,
    });
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(run.chats.size).toBe(0);
  });

  test("omp branched, then get_state failed before the new chat opened: Try again must not branch omp again (follow-up #1690)", async () => {
    const run = renderRun({
      getState: failure("omp_error", "test stand-in: omp did not report its chat", true),
    });

    await editFromSource(run);
    await act(async () => {
      await run.handlers.retry(failedOf(run));
    });

    expect(run.sent.filter((command) => command.type === "branch")).toHaveLength(1);
  });

  test("omp no longer has the message: nothing is sent past the branch, and the failure is not retryable", async () => {
    const run = renderRun({
      branch: [failure("not_found", "test stand-in: the message is gone", false)],
    });

    await editFromSource(run);

    expect(run.sent.map((command) => command.type)).toEqual(["branch"]);
    expect(run.opened).toEqual([]);
    expect(failedOf(run)).toMatchObject({
      message: "test stand-in: the message is gone",
      retryable: false,
      branched: false,
    });
  });

  test("an unexpected failure shows the generic message, never its own detail", async () => {
    const run = renderRun({ branch: [new Error("/private/path crashed")] });

    await editFromSource(run);
    showNotice(run, SOURCE_CHAT);

    expect(failedOf(run)).toMatchObject({
      message: "The message could not be sent. Try again.",
      retryable: true,
    });
    expect(screen.getByText("The message could not be sent. Try again.")).toBeTruthy();
    expect(screen.queryByText(/private\/path/)).toBeNull();
  });

  test.each([
    {
      name: "the message is no longer in the chat",
      sourceId: "gone-entry",
      message: "That message is no longer in this chat.",
    },
    {
      name: "the message is not saved yet",
      sourceId: null,
      message: "This message is not saved in the chat yet. Try again once it has finished.",
    },
  ])("$name: nothing is branched and the notice offers no retry", async ({ sourceId, message }) => {
    const run = renderRun();

    await act(async () => {
      await run.handlers.onEdit(editAppend(sourceId, EDIT_TEXT));
    });

    expect(run.sent).toEqual([]);
    expect(failedOf(run)).toMatchObject({ message, retryable: false, branched: false });
  });

  test("a regenerate with no stored message to answer branches nothing and is not retryable", async () => {
    const run = renderRun();

    await act(async () => {
      await run.handlers.onReload(null, undefined);
    });

    expect(run.sent).toEqual([]);
    expect(failedOf(run)).toMatchObject({
      kind: "regenerate",
      message: "This message is not saved in the chat yet. Try again once it has finished.",
      retryable: false,
    });
  });

  test("a regenerate of an answer, not of a user message, branches nothing and is not retryable", async () => {
    const run = renderRun();

    await act(async () => {
      await run.handlers.onReload(rowKeyOf(run.store, ASSISTANT_ANSWER), undefined);
    });

    expect(run.sent).toEqual([]);
    expect(failedOf(run)).toMatchObject({
      kind: "regenerate",
      message: "That message is no longer in this chat.",
      retryable: false,
    });
  });

  test("an image the run cannot send is refused as invalid before any branch is made, and nothing is sent", async () => {
    // The composer's own check (edit-surface.tsx:39) runs before a person's edit reaches the run, so this row drives the
    // run's check (run.ts:38-42) through the decorator hook P5 will use: the decorator hands the run an image without bytes.
    const run = renderRun({
      decorator: (request, edit) => edit({ ...request, replacementImages: [{ type: "image" }] }),
    });

    await editFromSource(run);
    showNotice(run, SOURCE_CHAT);

    expect(run.sent).toEqual([]);
    expect(run.opened).toEqual([]);
    expect(failedOf(run)).toMatchObject({
      message: "An attached image could not be read. Attach it again.",
      retryable: false,
      branched: false,
    });
    expect(screen.getByText("An attached image could not be read. Attach it again.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  test("the previous-message selector draws nothing when omp cannot list earlier messages (AP2)", () => {
    const { container } = render(
      <PreviousMessageSelectorView
        actions={{
          onOpen: () => undefined,
          onRetry: () => undefined,
          restoreFocus: () => undefined,
        }}
        viewModel={{ state: "unavailable" }}
        running={false}
      />,
    );

    expect(container.textContent).toBe("");
    expect(container.querySelector("button")).toBeNull();
  });
});
