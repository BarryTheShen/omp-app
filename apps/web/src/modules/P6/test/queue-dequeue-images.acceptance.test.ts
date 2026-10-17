import type { CapabilityMap, OmpWire, RpcSessionSend, ThreadId } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { createQueueController } from "@/modules/R0/actions";
import { OmpRuntimeStore, type OmpRuntimeTransport } from "@/modules/R0/store";
import { dequeueToEdit } from "../composer";
import { createQueueAdapter } from "../contract";

const threadId = "p6-queue-image-restoration" as ThreadId;
const capabilities: CapabilityMap = {
  "omp.cmd.remove_queued_message": { state: "available", via: "rpc" },
};

function storeWithQueuedMessage(): OmpRuntimeStore {
  return new OmpRuntimeStore({
    threadId,
    transport: {} as OmpRuntimeTransport,
  });
}

async function restoreRemovedMessage(result: OmpWire.RemoveQueuedMessageResult) {
  const store = storeWithQueuedMessage();
  store.applySessionState({
    isStreaming: true,
    steeringMode: "all",
    followUpMode: "one-at-a-time",
    interruptMode: "wait",
    queuedMessages: { steering: [], followUp: ["queued item"] },
  });
  const sent: unknown[] = [];
  const send: RpcSessionSend = async ({ command }) => {
    sent.push(command);
    return result as never;
  };
  const queue = createQueueAdapter(createQueueController({ store, send, capabilities }));
  const itemId = queue.getSnapshot().items[0]?.id;
  if (!itemId) throw new Error("queue fixture did not produce an item id");
  let restored:
    | { readonly text: string; readonly images?: readonly OmpWire.ImageContent[] }
    | undefined;
  const outcome = await dequeueToEdit(queue, itemId, {
    getDraft: () => ({ text: "", attachmentRefs: [] }),
    restoreDraft: (request, images) => {
      restored = { text: request.text, ...(images ? { images } : {}) };
    },
  });
  return { outcome, restored, sent };
}

describe("P6 acceptance: removed queue content reaches draft restoration", () => {
  test("R0 returns the image bytes and P6 restores them with the queued text", async () => {
    const image: OmpWire.ImageContent = {
      type: "image",
      data: "aGVsbG8=",
      mimeType: "image/png",
    };
    const result = await restoreRemovedMessage({ removed: true, images: [image] });
    expect(result.outcome).toEqual({
      removed: true,
      restored: true,
      choice: "queued",
      imagesDropped: false,
    });
    expect(result.restored).toEqual({ text: "queued item", images: [image] });
    expect(result.sent).toEqual([
      { type: "remove_queued_message", message: "queued item", queue: "followUp" },
    ]);
  });

  test("an omp omission marker reaches the edit result; ordinary text removal stays clean", async () => {
    const omitted = await restoreRemovedMessage({ removed: true, imagesDropped: true });
    expect(omitted.outcome.imagesDropped).toBe(true);
    expect(omitted.restored).toEqual({ text: "queued item" });

    const textOnly = await restoreRemovedMessage({ removed: true });
    expect(textOnly.outcome.imagesDropped).toBe(false);
    expect(textOnly.restored).toEqual({ text: "queued item" });
  });
});
