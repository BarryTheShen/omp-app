import type { OmpWire } from "@omp-app/contracts";

const RESTORED_NOTICE = "Stopped. The queued messages are back in the message box.";
const IMAGES_DROPPED_NOTICE =
  "Stopped. The queued messages are back in the message box, but their images were too large to bring back.";
const TRUNCATED_NOTICE =
  "Stopped. The oldest queued messages are back in the message box. The rest were too large to bring back.";

/** Withdrawn messages in omp's order: steering first, then follow-ups, oldest first. */
function withdrawnInOrder(
  restored: OmpWire.AbortAndRestoreQueueResult,
): readonly OmpWire.RestoredQueuedMessage[] {
  return [...restored.steering, ...restored.followUp];
}

/** How many messages the answer withdrew. */
export function restoredCount(restored: OmpWire.AbortAndRestoreQueueResult): number {
  return withdrawnInOrder(restored).length;
}

/** The withdrawn messages as one editor text, a blank line between them, as omp's terminal restores them. */
export function restoredQueueText(restored: OmpWire.AbortAndRestoreQueueResult): string {
  return withdrawnInOrder(restored)
    .map((message) => message.text)
    .join("\n\n");
}

/** The message box after Stop: the restored messages come first, then whatever was already typed. */
export function composeRestoredDraft(restoredText: string, draftText: string): string {
  return [restoredText, draftText].filter((part) => part.trim() !== "").join("\n\n");
}

/** Each restored image as a file, in message order. omp sends only the bytes, so the app names the files. */
export function restoredQueueImages(restored: OmpWire.AbortAndRestoreQueueResult): File[] {
  const images = withdrawnInOrder(restored).flatMap((message) => message.images ?? []);
  return images.map((image, index) => imageFile(image, index + 1));
}

function imageFile(image: OmpWire.ImageContent, number: number): File {
  const bytes = Uint8Array.from(atob(image.data), (character) => character.charCodeAt(0));
  const extension = image.mimeType.split("/")[1] ?? "png";
  return new File([bytes], `queued-image-${number}.${extension}`, { type: image.mimeType });
}

/** The notice after Stop, in plain words, for an answer that withdrew something. */
export function stopRestoreNotice(restored: OmpWire.AbortAndRestoreQueueResult): string {
  if (restored.truncated) return TRUNCATED_NOTICE;
  if (restored.imagesDropped) return IMAGES_DROPPED_NOTICE;
  return RESTORED_NOTICE;
}
