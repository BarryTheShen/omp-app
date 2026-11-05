import type { ChatHostImage } from "@omp-app/contracts/chat-host";

/** The image types omp's models read. */
export const IMAGE_TYPES: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
];

/**
 * The images one message may carry, in bytes: the app's connection takes 16 MB a message (Bun's default), and base64
 * makes the bytes a third larger.
 */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** An image in the message box, waiting to be sent. */
export interface Attachment {
  readonly id: string;
  readonly name: string;
  readonly bytes: number;
  readonly image: ChatHostImage;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  // In slices: one call with every byte as an argument overflows the stack.
  for (let start = 0; start < bytes.length; start += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  return btoa(binary);
}

/**
 * Sorts pasted, dropped or picked files for the next message: the pictures omp's models read go with it while the
 * message's pictures stay within {@link MAX_IMAGE_BYTES}; every other file, and a picture past that, comes back in
 * `others`, to be uploaded to the chat's folder (#2830).
 */
export async function readImages(
  files: readonly File[],
  alreadyBytes: number,
): Promise<{ readonly added: readonly Attachment[]; readonly others: readonly File[] }> {
  const added: Attachment[] = [];
  const others: File[] = [];
  let total = alreadyBytes;
  for (const file of files) {
    if (!IMAGE_TYPES.includes(file.type) || total + file.size > MAX_IMAGE_BYTES) {
      others.push(file);
      continue;
    }
    total += file.size;
    const data = toBase64(new Uint8Array(await file.arrayBuffer()));
    added.push({
      id: crypto.randomUUID(),
      name: file.name === "" ? "image" : file.name,
      bytes: file.size,
      image: { type: "image", data, mimeType: file.type },
    });
  }
  return { added, others };
}
