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

const MB = 1024 * 1024;

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  // In slices: one call with every byte as an argument overflows the stack.
  for (let start = 0; start < bytes.length; start += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  return btoa(binary);
}

/**
 * Reads pasted or dropped files as images for the next message: images omp reads, while the message stays within
 * {@link MAX_IMAGE_BYTES}. What is left out comes back as a sentence per file.
 */
export async function readImages(
  files: readonly File[],
  alreadyBytes: number,
): Promise<{ readonly added: readonly Attachment[]; readonly refused: readonly string[] }> {
  const added: Attachment[] = [];
  const refused: string[] = [];
  let total = alreadyBytes;
  for (const file of files) {
    const name = file.name === "" ? "The pasted file" : file.name;
    if (!IMAGE_TYPES.includes(file.type)) {
      refused.push(
        `${name} is not attached: only PNG, JPEG, GIF and WebP images go with a message.`,
      );
      continue;
    }
    if (total + file.size > MAX_IMAGE_BYTES) {
      refused.push(
        `${name} is not attached: a message takes ${MAX_IMAGE_BYTES / MB} MB of images, and this one is ${(file.size / MB).toFixed(1)} MB.`,
      );
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
  return { added, refused };
}
