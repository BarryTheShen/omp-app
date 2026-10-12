import type { AttachmentRef, DraftScope, OmpWire } from "@omp-app/contracts";
import type { createAttachmentBlobStore } from "@/modules/U2/attachments/blob-store";
import type { DraftStoreAdapter } from "@/modules/U2/drafts";
import {
  composeRestoredDraft,
  restoredCount,
  restoredQueueImages,
  restoredQueueText,
} from "./queue-stop-restore";

/** One way of storing an image in the blob store and returning its reference. */
export type ImageUpload = (file: File) => Promise<AttachmentRef>;

/** The upload the composer's own images use: the blob store keeps the bytes, the draft keeps the reference. */
export function imageUploadTo(
  blobs: Pick<ReturnType<typeof createAttachmentBlobStore>, "put">,
): ImageUpload {
  return async (file) => (await blobs.put({ id: crypto.randomUUID(), file })).ref;
}

/** Stores each restored image. One that cannot be stored is counted, and the others still come back. */
export async function storeRestoredImages(
  restored: OmpWire.AbortAndRestoreQueueResult,
  upload: ImageUpload,
): Promise<{ readonly refs: AttachmentRef[]; readonly lost: number }> {
  const refs: AttachmentRef[] = [];
  let lost = 0;
  for (const file of restoredQueueImages(restored)) {
    try {
      refs.push(await upload(file));
    } catch {
      lost += 1;
    }
  }
  return { refs, lost };
}

/** One chat's saved draft, and how the images of a restored message are stored. */
export interface SavedDraftTarget {
  readonly drafts: Pick<DraftStoreAdapter, "get" | "save">;
  readonly scope: DraftScope;
  readonly upload: ImageUpload;
}

/**
 * Writes what a Stop withdrew into a chat's saved draft by its thread id, for a chat that is not on screen when omp
 * answers. The text goes ahead of the saved text and the images ahead of the saved attachments, so opening the chat
 * shows them. An answer that withdrew nothing saves nothing. Returns how many images could not be stored.
 */
export async function restoreStoppedQueueIntoSavedDraft(
  target: SavedDraftTarget,
  restored: OmpWire.AbortAndRestoreQueueResult,
): Promise<number> {
  if (restoredCount(restored) === 0) return 0;
  const { refs, lost } = await storeRestoredImages(restored, target.upload);
  const saved = (await target.drafts.get({ scope: target.scope })).draft;
  await target.drafts.save({
    scope: target.scope,
    expectedRevision: saved?.revision ?? null,
    draft: {
      text: composeRestoredDraft(restoredQueueText(restored), saved?.text ?? ""),
      attachments: [...refs, ...(saved?.attachments ?? [])],
      failedSends: saved?.failedSends ?? [],
    },
  });
  return lost;
}
