import {
  AppFailure,
  type AttachmentBlobStore as AttachmentBlobStorePort,
  type AttachmentRef,
  MAX_ATTACHMENT_BYTES,
  type PortClient,
} from "@omp-app/contracts";
import {
  type AttachmentBlobStore,
  notAttachedMessage,
  type StoredAttachment,
  sizeInWords,
} from "./attachments";

type AttachmentBlobClient = PortClient<typeof AttachmentBlobStorePort>;

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)),
    );
  }
  return btoa(binary);
}

function safeFailure(error: unknown, operation: string): AppFailure {
  if (error instanceof AppFailure) return error;
  return new AppFailure({
    code: "unavailable",
    message: `Attachment ${operation} is unavailable.`,
    retryable: true,
  });
}

function contentFor(ref: AttachmentRef, bytes: string): StoredAttachment["content"] {
  const data = `data:${ref.mediaType};base64,${bytes}`;
  return ref.mediaType.startsWith("image/")
    ? [{ type: "image", image: data }]
    : [{ type: "file", data, mimeType: ref.mediaType }];
}

/** Browser-only AttachmentBlobStore adapter; binary bytes cross only the typed A1 port. */
export function createAttachmentBlobStore(client: AttachmentBlobClient): AttachmentBlobStore {
  return {
    async put({ id, file, signal }) {
      try {
        if (file.size > MAX_ATTACHMENT_BYTES) {
          throw new AppFailure({
            code: "invalid_args",
            message: notAttachedMessage(
              file.name,
              `Files over ${sizeInWords(MAX_ATTACHMENT_BYTES)} can't be attached.`,
            ),
            retryable: false,
          });
        }
        const bytes = toBase64(new Uint8Array(await file.arrayBuffer()));
        const result = await client.put(
          { id, name: file.name, mediaType: file.type, bytes },
          { signal },
        );
        return { ref: result.ref, content: contentFor(result.ref, bytes) };
      } catch (error) {
        throw safeFailure(error, "upload");
      }
    },
    async get(ref, options) {
      try {
        const result = await client.get({ ref }, options);
        return { ref: result.ref, content: contentFor(result.ref, result.bytes) };
      } catch (error) {
        throw safeFailure(error, "restore");
      }
    },
    async delete(ref) {
      try {
        await client.delete({ ref });
      } catch (error) {
        throw safeFailure(error, "cleanup");
      }
    },
  };
}
