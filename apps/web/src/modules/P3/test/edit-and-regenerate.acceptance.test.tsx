// Stored messages are read from the recordings (fixtures/omp-branch.ts). The branch result is omp v18.8.9's
// (rpc-types.ts:540). The get_state answer and the sessionId key are in the recorded out-of-order run.
import { act, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import {
  ASSISTANT_ANSWER,
  BRANCHED_CHAT,
  PNG_IMAGE,
  SOURCE_CHAT,
  USER_WITH_IMAGE,
} from "../fixtures/omp-branch";
import { captureP3EditSource } from "../runs/source";
import { editAppend, renderRun, rowKeyOf } from "./run-harness";

afterEach(cleanup);

const EDIT_TEXT = "Explain again";

describe("acceptance: an edit branches from its user message and resends it", () => {
  test("editing a text-and-image message branches from that message and resends the image, and the source message is unchanged", async () => {
    const run = renderRun();
    const source = captureP3EditSource(run.store, USER_WITH_IMAGE);

    await act(async () => {
      await run.handlers.onEdit(editAppend(String(USER_WITH_IMAGE), EDIT_TEXT, [PNG_IMAGE]));
    });

    expect(run.sent).toEqual([
      { threadId: String(SOURCE_CHAT), type: "branch", entryId: String(USER_WITH_IMAGE) },
      { threadId: String(SOURCE_CHAT), type: "get_state" },
    ]);
    expect(run.opened).toEqual([String(BRANCHED_CHAT)]);
    expect(run.chats.get(String(BRANCHED_CHAT))?.admitted).toEqual([
      { mode: "prompt", text: EDIT_TEXT, images: [PNG_IMAGE], delivery: "new" },
    ]);
    expect(run.runs.status.getSnapshot()).toMatchObject({
      phase: "sent",
      kind: "edit",
      sourceEntryId: USER_WITH_IMAGE,
      sourceThreadId: SOURCE_CHAT,
      threadId: BRANCHED_CHAT,
      workspaceGuarantee: "not-managed",
    });
    expect(run.store.getSnapshot().threadId).toBe(SOURCE_CHAT);
    expect(captureP3EditSource(run.store, USER_WITH_IMAGE)).toEqual(source);
  });

  test("the edit reaches omp once: the branch is made once and the replacement is admitted once", async () => {
    const run = renderRun();

    await act(async () => {
      await run.handlers.onEdit(editAppend(String(USER_WITH_IMAGE), EDIT_TEXT, [PNG_IMAGE]));
    });

    expect(run.sent.filter((command) => command.type === "branch")).toHaveLength(1);
    expect(run.chats.get(String(BRANCHED_CHAT))?.attempts).toHaveLength(1);
    expect(run.chats.get(String(BRANCHED_CHAT))?.admitted).toHaveLength(1);
  });

  test("a branch whose new session keeps the chat's own id still reopens the chat, and the edit is sent there", async () => {
    const run = renderRun({ getState: { sessionId: String(SOURCE_CHAT) } });

    await act(async () => {
      await run.handlers.onEdit(editAppend(String(USER_WITH_IMAGE), EDIT_TEXT, [PNG_IMAGE]));
    });

    expect(run.opened).toEqual([String(SOURCE_CHAT)]);
    expect(run.chats.get(String(SOURCE_CHAT))?.admitted).toEqual([
      { mode: "prompt", text: EDIT_TEXT, images: [PNG_IMAGE], delivery: "new" },
    ]);
    expect(run.runs.status.getSnapshot()).toMatchObject({ phase: "sent", threadId: SOURCE_CHAT });
  });
});

describe("acceptance: regenerating an answer asks its user message again, once", () => {
  test("a regenerate from the answer's user message branches from that message and sends its text and image once", async () => {
    const run = renderRun();

    await act(async () => {
      await run.handlers.onReload(rowKeyOf(run.store, USER_WITH_IMAGE), undefined);
    });

    expect(run.sent).toEqual([
      { threadId: String(SOURCE_CHAT), type: "branch", entryId: String(USER_WITH_IMAGE) },
      { threadId: String(SOURCE_CHAT), type: "get_state" },
    ]);
    expect(run.chats.get(String(BRANCHED_CHAT))?.admitted).toEqual([
      { mode: "prompt", text: "Explain", images: [PNG_IMAGE], delivery: "new" },
    ]);
    expect(run.runs.status.getSnapshot()).toMatchObject({
      phase: "sent",
      kind: "regenerate",
      sourceEntryId: USER_WITH_IMAGE,
      threadId: BRANCHED_CHAT,
    });
  });

  test("a reload that names the answer's own row never branches on the assistant entry", async () => {
    const run = renderRun();

    await act(async () => {
      await run.handlers.onReload(rowKeyOf(run.store, ASSISTANT_ANSWER), undefined);
    });

    expect(run.sent.map((command) => command.entryId)).not.toContain(String(ASSISTANT_ANSWER));
    expect(run.sent.filter((command) => command.type === "branch")).toEqual([]);
  });
});
