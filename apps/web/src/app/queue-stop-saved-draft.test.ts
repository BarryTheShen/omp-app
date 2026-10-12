import { AttachmentRef, Draft, DraftScope, type OmpWire } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import type { DraftStoreAdapter } from "@/modules/U2/drafts";
import { restoreStoppedQueueIntoSavedDraft } from "./queue-stop-saved-draft";

const scope = DraftScope.parse({ kind: "thread", threadId: "thread-saved-draft" });
const IMAGE: OmpWire.ImageContent = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };

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

const restored: OmpWire.AbortAndRestoreQueueResult = {
  steering: [{ text: "steer" }],
  followUp: [{ text: "follow", images: [IMAGE] }],
};

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
});
