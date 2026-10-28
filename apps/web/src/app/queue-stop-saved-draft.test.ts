import { AttachmentRef, Draft, DraftScope, type Omp } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { DraftController, type DraftStoreAdapter } from "@/modules/U2/drafts";
import { ScopedDraftStore } from "@/modules/U2/drafts/test-support";
import { restoreStoppedQueueIntoSavedDraft, storeQueueImages } from "./queue-stop-saved-draft";

const scope = DraftScope.parse({ kind: "thread", threadId: "thread-saved-draft" });
const IMAGE: Omp.ImageContent = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };

type SaveArgs = Parameters<DraftStoreAdapter["save"]>[0];

function ref(id: string): AttachmentRef {
  return AttachmentRef.parse({ id, name: `${id}.png`, mediaType: "image/png" });
}

function savedDraft(text: string, attachments: AttachmentRef[], revision: string): Draft {
  return Draft.parse({
    scope,
    text,
    attachments,
    failedSends: [],
    revision,
    updatedAt: "2026-10-12T00:00:00.000Z",
  });
}

/** An in-memory draft store that records each save, the way the app's draft port is called. */
function fakeDrafts(existing: Draft | null) {
  const saves: SaveArgs[] = [];
  const drafts: Pick<DraftStoreAdapter, "get" | "save"> = {
    get: async () => ({ draft: existing }),
    save: async (args) => {
      saves.push(args);
      return savedDraft(args.draft.text, args.draft.attachments, "rev-next");
    },
  };
  return { saves, drafts };
}

const restored: Omp.AbortAndRestoreQueueResult = {
  steering: [{ text: "steer" }],
  followUp: [{ text: "follow", images: [IMAGE] }],
};

describe("storeQueueImages", () => {
  test("uploads each returned queued image and counts images that omp omitted or storage refused", async () => {
    const uploaded: { readonly name: string; readonly type: string; readonly bytes: number[] }[] =
      [];
    const result = await storeQueueImages([IMAGE], async (file) => {
      uploaded.push({
        name: file.name,
        type: file.type,
        bytes: [...new Uint8Array(await file.arrayBuffer())],
      });
      return ref("queued-image");
    });
    expect(uploaded).toEqual([
      { name: "queued-image-1.png", type: "image/png", bytes: [104, 101, 108, 108, 111] },
    ]);
    expect(result).toEqual({ refs: [ref("queued-image")], lost: 0 });

    const omitted = await storeQueueImages([], async () => ref("unused"));
    expect(omitted).toEqual({ refs: [], lost: 0 });
    const refused = await storeQueueImages([IMAGE], async () => {
      throw new Error("storage refused");
    });
    expect(refused).toEqual({ refs: [], lost: 1 });
  });
});

describe("restoreStoppedQueueIntoSavedDraft", () => {
  test("puts the stopped text ahead of the saved text, and the images ahead of the saved attachments", async () => {
    const { saves, drafts } = fakeDrafts(savedDraft("typed later", [ref("old-1")], "rev-1"));
    const uploaded: string[] = [];
    await restoreStoppedQueueIntoSavedDraft(
      {
        drafts,
        scope,
        upload: async (file) => {
          uploaded.push(file.name);
          return ref(`image-${uploaded.length}`);
        },
      },
      restored,
    );
    expect(uploaded).toEqual(["queued-image-1.png"]);
    expect(saves).toEqual([
      {
        scope,
        expectedRevision: "rev-1",
        draft: {
          text: "steer\n\nfollow\n\ntyped later",
          attachments: [ref("image-1"), ref("old-1")],
          failedSends: [],
        },
      },
    ]);
  });

  test("starts a draft for a chat that has none, with no revision to match", async () => {
    const { saves, drafts } = fakeDrafts(null);
    await restoreStoppedQueueIntoSavedDraft(
      { drafts, scope, upload: async () => ref("image-1") },
      restored,
    );
    expect(saves).toEqual([
      {
        scope,
        expectedRevision: null,
        draft: { text: "steer\n\nfollow", attachments: [ref("image-1")], failedSends: [] },
      },
    ]);
  });

  test("saves nothing when the answer withdrew nothing", async () => {
    const { saves, drafts } = fakeDrafts(savedDraft("typed later", [], "rev-1"));
    await restoreStoppedQueueIntoSavedDraft(
      { drafts, scope, upload: async () => ref("unused") },
      { steering: [], followUp: [] },
    );
    expect(saves).toEqual([]);
  });

  test("a chat opened while the restore is still saving loads the restored text, not the draft before it (#2756)", async () => {
    const store = new ScopedDraftStore();
    // The image is still being stored when the person opens the chat, so the restore has not saved yet.
    const imageStored = Promise.withResolvers<void>();
    const restoring = restoreStoppedQueueIntoSavedDraft(
      {
        drafts: store,
        scope,
        upload: async () => {
          await imageStored.promise;
          return ref("image-1");
        },
      },
      restored,
    );
    const opened = new DraftController({ store, scope });
    const loading = opened.load();
    imageStored.resolve();
    await restoring;
    expect((await loading).text).toBe("steer\n\nfollow");
    expect((await loading).attachments).toEqual([ref("image-1")]);
  });
});
