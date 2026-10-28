import type { CapabilityMap, ChatSessionRequest, Omp, ThreadId } from "@omp-app/contracts";
import type { RemoveQueuedMessageResult } from "@omp-app/contracts/chat-host";
import { describe, expect, test } from "vitest";
import { createQueueController } from "@/modules/R0/actions";
import { OmpRuntimeStore, type OmpRuntimeTransport } from "@/modules/R0/store";
import { dequeueToEdit } from "../composer";
import { createQueueAdapter } from "../contract";

const threadId = "p6-queue-image-restoration" as ThreadId;
const capabilities: CapabilityMap = {
  "omp.cmd.remove_queued_message": { state: "available", via: "omp" },
};

function storeWithQueuedMessage(): OmpRuntimeStore {
  return new OmpRuntimeStore({
    threadId,
    transport: {} as OmpRuntimeTransport,
  });
}

async function restoreRemovedMessage(result: RemoveQueuedMessageResult) {
  const store = storeWithQueuedMessage();
  store.applySessionState({
    isStreaming: true,
    steeringMode: "all",
    followUpMode: "one-at-a-time",
    interruptMode: "wait",
    queuedMessages: { steering: [], followUp: ["queued item"], liveSteered: 0 },
  });
  const sent: unknown[] = [];
  const send: ChatSessionRequest = async ({ method, params }) => {
    sent.push({ method, params });
    return result as never;
  };
  const queue = createQueueAdapter(createQueueController({ store, send, capabilities }));
  const itemId = queue.getSnapshot().items[0]?.id;
  if (!itemId) throw new Error("queue fixture did not produce an item id");
  let restored:
    | { readonly text: string; readonly images?: readonly Omp.ImageContent[] }
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
    const image: Omp.ImageContent = {
      type: "image",
      data: "aGVsbG8=",
      mimeType: "image/png",
    };
    const result = await restoreRemovedMessage({
      removed: true,
      text: "queued item",
      images: [image],
    });
    expect(result.outcome).toEqual({ removed: true, restored: true, choice: "queued" });
    expect(result.restored).toEqual({ text: "queued item", images: [image] });
    expect(result.sent).toEqual([
      {
        method: "remove_queued_message",
        params: { message: "queued item", queue: "followUp" },
      },
    ]);
  });

  test("a removed message without images restores its text alone", async () => {
    const textOnly = await restoreRemovedMessage({ removed: true, text: "queued item" });
    expect(textOnly.outcome).toEqual({ removed: true, restored: true, choice: "queued" });
    expect(textOnly.restored).toEqual({ text: "queued item" });
  });
});
