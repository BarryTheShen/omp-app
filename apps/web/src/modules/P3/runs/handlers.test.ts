import {
  AppFailure,
  EntryId as EntryIdSchema,
  type ThreadId,
  ThreadId as ThreadIdSchema,
} from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import type { EditRequest, EditRunResult, ReloadRequest } from "../contract";
import { createP3RunHandlers } from "./handlers";
import { P3ThreadHandoff } from "./handoff";
import type { P3EditRun } from "./run";
import {
  createP3RunStatus,
  type P3FailedState,
  type P3RunReplacement,
  type P3RunStatus,
} from "./status";
import {
  editAppend,
  pngImage,
  sourceThread,
  storeWithUserMessage,
  userEntry,
} from "./test-support";

const opened: ThreadId = ThreadIdSchema.parse("branch-of-source");
const admitted: EditRunResult = {
  threadId: opened,
  admitted: true,
  settled: false,
  workspaceGuarantee: "not-managed",
};

interface SetupOptions {
  /** What an edit does; it may open `opened` through the handoff, the way a branch does. */
  readonly edit?: (request: EditRequest, handoff: P3ThreadHandoff) => Promise<EditRunResult>;
  readonly resend?: (replacement: P3RunReplacement) => Promise<EditRunResult>;
}

function setup(options: SetupOptions = {}) {
  const handoff = new P3ThreadHandoff();
  const status = createP3RunStatus();
  const phases: string[] = [];
  status.subscribe(() => phases.push(status.getSnapshot().phase));
  const edits: EditRequest[] = [];
  const regenerations: ReloadRequest[] = [];
  const resends: P3RunReplacement[] = [];
  const edit =
    options.edit ??
    (async (_request: EditRequest, opening: P3ThreadHandoff) => {
      opening.expect(opened);
      return admitted;
    });
  const run: P3EditRun = {
    edit: async (request) => {
      edits.push(request);
      return edit(request, handoff);
    },
    reload: async (request) => {
      regenerations.push(request);
      handoff.expect(opened);
      return admitted;
    },
    resend: async (replacement) => {
      resends.push(replacement);
      return options.resend ? options.resend(replacement) : admitted;
    },
  };
  const store = storeWithUserMessage("Explain");
  const handlers = createP3RunHandlers({
    store,
    run,
    handoff,
    status,
  });
  return { handlers, status, phases, edits, regenerations, resends, store };
}

function failedOf(status: P3RunStatus): P3FailedState {
  const state = status.getSnapshot();
  if (state.phase !== "failed") throw new Error(`expected a failed run, got ${state.phase}`);
  return state;
}

describe("P3 run handlers", () => {
  test("publishes sending, then sent on the new chat, with the captured source and replacement", async () => {
    const { handlers, status, phases, edits } = setup();

    await handlers.onEdit(editAppend(String(userEntry), "Explain again", [pngImage]));

    expect(phases).toEqual(["sending", "sent"]);
    expect(status.getSnapshot()).toMatchObject({
      phase: "sent",
      kind: "edit",
      sourceEntryId: userEntry,
      sourceThreadId: sourceThread,
      threadId: opened,
      workspaceGuarantee: "not-managed",
    });
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({
      replacementText: "Explain again",
      replacementImages: [pngImage],
      source: { entryId: userEntry, originalText: "Explain", originalImages: [] },
    });
  });

  test("a message that is no longer in the chat fails without a retry", async () => {
    const { handlers, status, edits } = setup();

    await handlers.onEdit(editAppend(String(EntryIdSchema.parse("gone-entry")), "Explain again"));

    expect(edits).toEqual([]);
    expect(status.getSnapshot()).toMatchObject({
      phase: "failed",
      message: "That message is no longer in this chat.",
      retryable: false,
    });
  });

  test("a message that is not saved yet fails without a retry", async () => {
    const { handlers, status } = setup();

    await handlers.onEdit(editAppend(null, "Explain again"));

    expect(failedOf(status)).toMatchObject({ retryable: false, branched: false });
    expect(failedOf(status).message).toContain("not saved");
  });

  test("a failure before a chat opened keeps the text and retries the edit from the source", async () => {
    let attempts = 0;
    const { handlers, status, edits } = setup({
      edit: async (_request, opening) => {
        attempts += 1;
        if (attempts === 1)
          throw new AppFailure({ code: "omp_error", message: "omp is busy", retryable: true });
        opening.expect(opened);
        return admitted;
      },
    });

    await handlers.onEdit(editAppend(String(userEntry), "Explain again"));
    const failed = failedOf(status);
    expect(failed).toMatchObject({
      branched: false,
      chatThreadId: sourceThread,
      message: "omp is busy",
      retryable: true,
      replacement: { text: "Explain again" },
    });

    await handlers.retry(failed);

    expect(edits).toHaveLength(2);
    expect(status.getSnapshot()).toMatchObject({ phase: "sent", threadId: opened });
  });

  test("a failure after the chat opened retries on that chat without branching again", async () => {
    const { handlers, status, edits, resends } = setup({
      edit: async (_request, opening) => {
        opening.expect(opened);
        throw new AppFailure({
          code: "omp_error",
          message: "The prompt was rejected",
          retryable: true,
        });
      },
    });

    await handlers.onEdit(editAppend(String(userEntry), "Explain again"));
    const failed = failedOf(status);
    expect(failed).toMatchObject({ branched: true, chatThreadId: opened });

    await handlers.retry(failed);

    expect(edits).toHaveLength(1);
    expect(resends).toEqual([{ text: "Explain again", images: [] }]);
    expect(status.getSnapshot()).toMatchObject({ phase: "sent", threadId: opened });
  });

  test("an internal failure shows the plain fallback, never the internal detail, and never rejects", async () => {
    const { handlers, status } = setup({
      edit: async () => {
        throw new Error("/private/path crashed");
      },
    });

    await expect(
      handlers.onEdit(editAppend(String(userEntry), "Explain again")),
    ).resolves.toBeUndefined();

    expect(status.getSnapshot()).toMatchObject({
      phase: "failed",
      message: "The message could not be sent. Try again.",
      retryable: true,
    });
  });

  test("regenerate asks the answer again from its user message on a new chat", async () => {
    const { handlers, status, regenerations, store } = setup();
    const [rowKey] = store.getSnapshot().messageOrder;

    await handlers.onReload(String(rowKey), undefined);

    expect(regenerations).toHaveLength(1);
    expect(regenerations[0]).toMatchObject({
      source: { entryId: userEntry, originalText: "Explain" },
    });
    expect(status.getSnapshot()).toMatchObject({
      phase: "sent",
      kind: "regenerate",
      sourceEntryId: userEntry,
      threadId: opened,
    });
  });

  test("regenerate names its user message by row, so an entry id finds no message", async () => {
    const { handlers, status, regenerations } = setup();

    await handlers.onReload(String(userEntry), undefined);

    expect(regenerations).toEqual([]);
    expect(failedOf(status)).toMatchObject({ kind: "regenerate", retryable: false });
  });

  test("regenerate without a message to answer fails without a retry", async () => {
    const { handlers, status, regenerations } = setup();

    await handlers.onReload(null, undefined);

    expect(regenerations).toEqual([]);
    expect(failedOf(status)).toMatchObject({ kind: "regenerate", retryable: false });
  });
});
