import type { OmpWire } from "@omp-app/contracts";
import { describe, expect, test, vi } from "vitest";
import {
  createQueueAdapter,
  P6_QUEUE_CAPABILITIES,
  type QueuePort,
  type QueueSnapshot,
} from "../contract";
import {
  dequeueToEdit,
  isQueueSubmission,
  queueSubmissionIntents,
  queueSubmitPolicy,
  resolveQueueSubmitPolicy,
  splitQueuedMessages,
} from ".";

const draft = (text: string) => ({ text, images: [], attachmentRefs: [] });
const snapshot: QueueSnapshot = {
  steering: [],
  followUp: ["queued text"],
  steeringMode: "all",
  followUpMode: "one-at-a-time",
  interruptMode: "wait",
  isStreaming: true,
};

function queueController(
  current: QueueSnapshot = snapshot,
  removeResult: {
    changed: boolean;
    images?: readonly OmpWire.ImageContent[];
    imagesDropped?: boolean;
  } = {
    changed: true,
  },
) {
  const calls: string[] = [];
  const port = {
    getSnapshot: () => current,
    getCapabilities: () => ({
      [P6_QUEUE_CAPABILITIES.remove]: { state: "available" as const, via: "rpc" as const },
      [P6_QUEUE_CAPABILITIES.followUp]: { state: "available" as const, via: "rpc" as const },
    }),
    subscribe: () => () => undefined,
    submit: async () => undefined,
    remove: async ({ message }: { message: string }) => {
      calls.push(message);
      return removeResult;
    },
    promote: async () => ({ changed: true }),
    setModes: async () => undefined,
    answerDialog: async () => undefined,
    answerHostTool: async () => undefined,
    updateHostTool: async () => true,
    answerHostUri: async () => undefined,
    onAddToolResult: async () => undefined,
  } as unknown as QueuePort;
  return { controller: createQueueAdapter(port), calls };
}

describe("P6 composer queue policy", () => {
  test("maps idle Enter, streaming Enter, and follow-up chords", () => {
    expect(queueSubmitPolicy({ isStreaming: false, keyChord: "enter", draft: draft("x") })).toEqual(
      {
        delivery: "new",
      },
    );
    expect(queueSubmitPolicy({ isStreaming: true, keyChord: "enter", draft: draft("x") })).toEqual({
      delivery: "steer",
    });
    expect(
      queueSubmitPolicy({ isStreaming: true, keyChord: "ctrlEnter", draft: draft("x") }),
    ).toEqual({
      delivery: "followUp",
    });
    expect(
      queueSubmitPolicy({ isStreaming: false, keyChord: "metaEnter", draft: draft("x") }),
    ).toEqual({
      delivery: "followUp",
    });
    expect(queueSubmitPolicy({ isStreaming: false, keyChord: "ctrlJ", draft: draft("x") })).toEqual(
      {
        delivery: "new",
      },
    );
    expect(
      resolveQueueSubmitPolicy({ isStreaming: true, keyChord: "enter", draft: draft("x") }),
    ).toEqual({
      delivery: "steer",
    });
  });

  test("never emits new while streaming and keeps explicit queue syntax in follow-up", () => {
    expect(() =>
      resolveQueueSubmitPolicy({ isStreaming: true, keyChord: "enter", draft: draft("x") }),
    ).not.toThrow();
    expect(
      queueSubmitPolicy({ isStreaming: true, keyChord: "enter", draft: draft("/queue later") }),
    ).toEqual({
      split: [{ mode: "prompt", text: "later", delivery: "followUp" }],
    });
    expect(() =>
      resolveQueueSubmitPolicy({ isStreaming: true, keyChord: "enter", draft: draft("x") }),
    ).not.toThrow();
  });

  test("mirrors omp's decimal, Roman, alphabetic, and shorthand splitting", () => {
    expect(splitQueuedMessages("1. first\n2. second\n3. third")).toEqual([
      "first",
      "second",
      "third",
    ]);
    expect(splitQueuedMessages("I) one\nII) two")).toEqual(["one", "two"]);
    expect(splitQueuedMessages("a) alpha\nb) beta")).toEqual(["alpha", "beta"]);
    expect(splitQueuedMessages("1. first\n3. not sequential")).toEqual([
      "1. first\n3. not sequential",
    ]);
    expect(queueSubmissionIntents("->\n1. one\n2. two", { images: [] })).toEqual([
      { mode: "prompt", text: "one", delivery: "followUp" },
      { mode: "prompt", text: "two", delivery: "followUp" },
    ]);
    expect(queueSubmissionIntents("/queue one", { images: [] })).toEqual([
      { mode: "prompt", text: "one", delivery: "followUp" },
    ]);
    expect(isQueueSubmission("=> one")).toBe(true);
    expect(isQueueSubmission("normal prompt")).toBe(false);
  });

  test("dequeue-to-edit removes once and asks before replacing an existing draft", async () => {
    const { controller, calls } = queueController();
    const id = controller.getSnapshot().items[0]?.id;
    if (!id) throw new Error("missing queue id");
    const restored: string[] = [];
    const result = await dequeueToEdit(controller, id, {
      getDraft: () => ({ text: "new text already typed", attachmentRefs: [] }),
      chooseConflict: () => "queued",
      restoreDraft: (request) => {
        restored.push(request.text);
      },
    });
    expect(result).toEqual({
      removed: true,
      restored: true,
      choice: "queued",
      imagesDropped: false,
    });
    expect(calls).toEqual(["queued text"]);
    expect(restored).toEqual(["queued text"]);
  });
  test("dequeue-to-edit restores returned images alongside queued text", async () => {
    const image: OmpWire.ImageContent = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };
    const { controller } = queueController(snapshot, { changed: true, images: [image] });
    const id = controller.getSnapshot().items[0]?.id;
    if (!id) throw new Error("missing queue id");
    const restored: unknown[] = [];
    const result = await dequeueToEdit(controller, id, {
      getDraft: () => ({ text: "", attachmentRefs: [] }),
      restoreDraft: (request, images) => {
        restored.push({ text: request.text, images });
      },
    });
    expect(result).toEqual({
      removed: true,
      restored: true,
      choice: "queued",
      imagesDropped: false,
    });
    expect(restored).toEqual([{ text: "queued text", images: [image] }]);
  });

  test("dequeue-to-edit reports omitted images while restoring text", async () => {
    const { controller } = queueController(snapshot, { changed: true, imagesDropped: true });
    const id = controller.getSnapshot().items[0]?.id;
    if (!id) throw new Error("missing queue id");
    const restored: unknown[] = [];
    const result = await dequeueToEdit(controller, id, {
      getDraft: () => ({ text: "", attachmentRefs: [] }),
      restoreDraft: (request, images) => {
        restored.push({ text: request.text, images });
      },
    });
    expect(result.imagesDropped).toBe(true);
    expect(restored).toEqual([{ text: "queued text", images: undefined }]);
  });

  test("dequeue-to-edit refuses and restores nothing when omp removed nothing", async () => {
    const { controller } = queueController(snapshot, { changed: false });
    const id = controller.getSnapshot().items[0]?.id;
    if (!id) throw new Error("missing queue id");
    const restoreDraft = vi.fn();
    await expect(
      dequeueToEdit(controller, id, {
        getDraft: () => ({ text: "", attachmentRefs: [] }),
        restoreDraft,
      }),
    ).rejects.toMatchObject({ appError: { code: "conflict" } });
    expect(restoreDraft).not.toHaveBeenCalled();
  });

  test("dequeue-to-edit does not trust a controller that reports nothing changed", async () => {
    const { controller } = queueController();
    const id = controller.getSnapshot().items[0]?.id;
    if (!id) throw new Error("missing queue id");
    const restoreDraft = vi.fn();
    const unchanged = { ...controller, removeForEdit: async () => ({ changed: false }) };
    await expect(
      dequeueToEdit(unchanged, id, {
        getDraft: () => ({ text: "", attachmentRefs: [] }),
        restoreDraft,
      }),
    ).rejects.toMatchObject({
      appError: {
        code: "conflict",
        message: "The queued message could not be removed. Try again.",
      },
    });
    expect(restoreDraft).not.toHaveBeenCalled();
  });

  test("dequeue cancel keeps an existing draft and never removes the queue item", async () => {
    const { controller, calls } = queueController();
    const id = controller.getSnapshot().items[0]?.id;
    if (!id) throw new Error("missing queue id");
    const restore = { count: 0 };
    const result = await dequeueToEdit(controller, id, {
      getDraft: () => ({ text: "keep me", attachmentRefs: [] }),
      chooseConflict: () => "cancel",
      restoreDraft: () => {
        restore.count += 1;
      },
    });
    expect(result).toEqual({
      removed: false,
      restored: false,
      choice: "cancel",
      imagesDropped: false,
    });
    expect(calls).toEqual([]);
    expect(restore.count).toBe(0);
  });
  test("does not put a live-steered message back into the draft", async () => {
    const { controller, calls } = queueController({
      ...snapshot,
      steering: ["sent live steering"],
      followUp: [],
      liveSteered: 1,
    });
    const item = controller.getSnapshot().steerItems[0];
    if (!item) throw new Error("missing live steering item");
    const restoreDraft = vi.fn();

    await expect(
      dequeueToEdit(controller, item.id, {
        getDraft: () => ({ text: "", attachmentRefs: [] }),
        restoreDraft,
      }),
    ).rejects.toMatchObject({
      appError: {
        code: "conflict",
        message:
          "omp already sent this steering message into the reply; it cannot be returned to the message box.",
      },
    });
    expect(calls).toEqual([]);
    expect(restoreDraft).not.toHaveBeenCalled();
  });
});
