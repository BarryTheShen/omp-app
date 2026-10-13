import { acceptedKindsText, notAttachedMessage } from "../attachments/attachments";

/**
 * Names for the files the composer refuses. assistant-ui refuses a file that its accept list does not match
 * before the attachment adapter sees it, and its event carries the file's type but not its name. The drop,
 * paste or file picker that offered the file dispatches a browser event first, and the refusal happens inside
 * that same dispatch, so the offer is read there and each refusal uses up the offered file it refers to.
 */

/** The files a drop, a paste or a file picker has just offered, read from the browser event that carries them. */
export function offeredFiles(event: Event): File[] {
  const carried =
    (event as Partial<DragEvent>).dataTransfer ?? (event as Partial<ClipboardEvent>).clipboardData;
  const list =
    carried?.files ?? (event.target instanceof HTMLInputElement ? event.target.files : null);
  return list ? [...list] : [];
}

/** Uses up the first offered file of this type: a refusal names one file, and an offer names only its own refusals. */
function takeOffered(offers: File[], type: string): File | undefined {
  const index = offers.findIndex((file) => file.type === type);
  return index < 0 ? undefined : offers.splice(index, 1)[0];
}

/** The composer's notice for an attachment failure: which file was not taken and why, or the failure's own words. */
export function refusalNotice(
  failure: { readonly reason: string; readonly message: string; readonly contentType?: string },
  accept: string,
  offers: File[],
): string {
  if (failure.reason !== "not-accepted") return failure.message;
  const name = takeOffered(offers, failure.contentType ?? "")?.name ?? "That file";
  return notAttachedMessage(name, acceptedKindsText(accept));
}
