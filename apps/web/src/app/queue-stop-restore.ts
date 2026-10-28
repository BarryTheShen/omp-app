import type { Omp } from "@omp-app/contracts";

/** The notice after Stop when it withdrew queued messages. */
export const STOP_RESTORED_NOTICE = "Stopped. The queued messages are back in the message box.";

/** Withdrawn messages in omp's order: steering first, then follow-ups, oldest first. */
function withdrawnInOrder(
  restored: Omp.AbortAndRestoreQueueResult,
): readonly Omp.RestoredQueuedMessage[] {
  return [...restored.steering, ...restored.followUp];
}

/** How many messages the answer withdrew. */
export function restoredCount(restored: Omp.AbortAndRestoreQueueResult): number {
  return withdrawnInOrder(restored).length;
}

/** The withdrawn messages as one editor text, a blank line between them, as omp's terminal restores them. */
export function restoredQueueText(restored: Omp.AbortAndRestoreQueueResult): string {
  return withdrawnInOrder(restored)
    .map((message) => message.text)
    .join("\n\n");
}

/** The message box after Stop: the restored messages come first, then whatever was already typed. */
export function composeRestoredDraft(restoredText: string, draftText: string): string {
  return [restoredText, draftText].filter((part) => part.trim() !== "").join("\n\n");
}

/** Each returned image as a file. omp sends only the bytes, so the app names the files. */
export function imageFiles(images: readonly Omp.ImageContent[]): File[] {
  return images.map((image, index) => imageFile(image, index + 1));
}
function imageFile(image: Omp.ImageContent, number: number): File {
  const bytes = Uint8Array.from(atob(image.data), (character) => character.charCodeAt(0));
  const extension = image.mimeType.split("/")[1] ?? "png";
  return new File([bytes], `queued-image-${number}.${extension}`, { type: image.mimeType });
}

/** Each image from a Stop result as a file, in message order. */
export function restoredQueueImages(restored: Omp.AbortAndRestoreQueueResult): File[] {
  const images = withdrawnInOrder(restored).flatMap((message) => message.images ?? []);
  return imageFiles(images);
}
