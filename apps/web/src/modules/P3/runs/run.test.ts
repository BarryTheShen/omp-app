import { type EntryId, ThreadId as ThreadIdSchema } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import type { PromptIntent } from "@/modules/R0/runtime";
import type { EditRunDecorator, EditSource } from "../contract";
import { type P3PromptRuntime, P3ThreadHandoff } from "./handoff";
import { createP3EditRun, type P3BranchHandler } from "./run";
import { pngImage, sourceThread, userEntry } from "./test-support";

const opened = ThreadIdSchema.parse("branch-of-source");

const source: EditSource = {
  threadId: sourceThread,
  entryId: userEntry,
  parentId: null,
  originalText: "Explain",
  originalImages: [pngImage],
  sourceHeadId: null,
};

/**
 * A branch that opens `opened` the way R0.4 does: it switches chats, then sends the prompt through the
 * handoff, which waits for the new chat's runtime.
 */
function harness(options: { readonly opensChat: boolean; readonly decorator?: EditRunDecorator }) {
  const handoff = new P3ThreadHandoff();
  const sent: PromptIntent[] = [];
  const edits: Array<{ readonly entryId: EntryId; readonly intent: PromptIntent }> = [];
  const regenerations: EntryId[] = [];
  const runtime: P3PromptRuntime = {
    submitPrompt: async (intent) => {
      sent.push(intent);
    },
  };
  handoff.attach(opened, runtime);
  const branching: P3BranchHandler = {
    editFrom: async (entryId, intent) => {
      edits.push({ entryId, intent });
      if (!options.opensChat) return;
      handoff.expect(opened);
      await handoff.submit(intent);
    },
    regenerateFrom: async (entryId) => {
      regenerations.push(entryId);
      if (!options.opensChat) return;
      handoff.expect(opened);
      await handoff.submit({ mode: "prompt", text: source.originalText, delivery: "new" });
    },
  };
  const run = createP3EditRun({ branching, handoff, decorator: options.decorator });
  return { handoff, run, sent, edits, regenerations };
}

describe("P3 edit run", () => {
  test("edit branches from the entry and sends the replacement on the new chat", async () => {
    const { run, edits, sent } = harness({ opensChat: true });

    const result = await run.edit({
      source,
      replacementText: "Explain again",
      replacementImages: [pngImage],
    });

    expect(edits).toEqual([
      {
        entryId: userEntry,
        intent: { mode: "prompt", text: "Explain again", images: [pngImage], delivery: "new" },
      },
    ]);
    expect(sent).toEqual([
      { mode: "prompt", text: "Explain again", images: [pngImage], delivery: "new" },
    ]);
    expect(result).toEqual({
      threadId: opened,
      admitted: true,
      settled: false,
      workspaceGuarantee: "not-managed",
    });
  });

  test("regenerate asks the same user message again on the new chat", async () => {
    const { run, regenerations, sent } = harness({ opensChat: true });

    const result = await run.reload({ source, runConfig: undefined });

    expect(regenerations).toEqual([userEntry]);
    expect(sent).toEqual([{ mode: "prompt", text: "Explain", delivery: "new" }]);
    expect(result.threadId).toBe(opened);
  });

  test("a decorator wraps both edit and regenerate, and its report is returned", async () => {
    const seen: string[] = [];
    const decorator: EditRunDecorator = async (request, next) => {
      seen.push(request.replacementText);
      const result = await next(request);
      return { ...result, workspaceGuarantee: "boundary", externalChanges: ["notes.md"] };
    };
    const { run } = harness({ opensChat: true, decorator });

    const edited = await run.edit({
      source,
      replacementText: "Explain again",
      replacementImages: [],
    });
    const regenerated = await run.reload({ source, runConfig: undefined });

    expect(seen).toEqual(["Explain again", "Explain"]);
    expect(edited).toMatchObject({ workspaceGuarantee: "boundary", externalChanges: ["notes.md"] });
    expect(regenerated).toMatchObject({ workspaceGuarantee: "boundary" });
  });

  test("a request cancelled before the branch branches nothing", async () => {
    const { run, edits } = harness({ opensChat: true });
    const controller = new AbortController();
    controller.abort();

    await expect(
      run.edit({
        source,
        replacementText: "Explain again",
        replacementImages: [],
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ appError: { code: "cancelled", retryable: false } });
    expect(edits).toEqual([]);
  });

  test("an image that cannot be read is refused before the branch", async () => {
    const { run, edits } = harness({ opensChat: true });

    await expect(
      run.edit({
        source,
        replacementText: "Explain again",
        replacementImages: [{ type: "image" }],
      }),
    ).rejects.toMatchObject({ appError: { code: "invalid_args" } });
    expect(edits).toEqual([]);
  });

  test("an edit whose branch opens no chat fails as internal", async () => {
    const { run } = harness({ opensChat: false });

    await expect(
      run.edit({ source, replacementText: "Explain again", replacementImages: [] }),
    ).rejects.toMatchObject({ appError: { code: "internal", retryable: true } });
  });

  test("resend sends on the opened chat without branching again", async () => {
    const { run, edits, sent } = harness({ opensChat: true });
    await run.edit({ source, replacementText: "Explain again", replacementImages: [] });

    const result = await run.resend({ text: "Explain again", images: [] });

    expect(edits).toHaveLength(1);
    expect(sent.at(-1)).toEqual({ mode: "prompt", text: "Explain again", delivery: "new" });
    expect(result.threadId).toBe(opened);
  });
});
