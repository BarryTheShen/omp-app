import type {
  Attachment,
  CompleteAttachment,
  PendingAttachment,
  ThreadUserMessagePart,
} from "@assistant-ui/react";
import type { AttachmentRef } from "@omp-app/contracts";
import { AppFailure } from "@omp-app/contracts";
import type { AttachmentAdapter, AttachmentState } from "../contract";

export const DEFAULT_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const DEFAULT_LARGE_PASTE_LINE_THRESHOLD = 100;

export type LargePasteChoice = "attachment" | "inline";

export interface StoredAttachment {
  readonly ref: AttachmentRef;
  readonly content: readonly ThreadUserMessagePart[];
}

/** The host owns app-data blobs; drafts persist only the returned AttachmentRef. */
export interface AttachmentBlobStore {
  readonly put: (input: {
    readonly id: string;
    readonly file: File;
    readonly signal?: AbortSignal;
  }) => Promise<StoredAttachment>;
  readonly get: (
    ref: AttachmentRef,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<StoredAttachment>;
  readonly delete: (ref: AttachmentRef) => Promise<void>;
}

export interface AttachmentManagerOptions {
  readonly blobStore: AttachmentBlobStore;
  readonly accept?: string;
  readonly allowedMimeTypes?: readonly string[];
  readonly maxBytes?: number;
  readonly idPrefix?: string;
}

export interface LargePasteDecision {
  readonly kind: "inline" | "choose";
  readonly text: string;
  readonly lineCount: number;
  readonly threshold: number;
}

export interface LargePasteAttachmentResult {
  readonly kind: "attachment";
  readonly ref: AttachmentRef;
}

export interface LargePasteInlineResult {
  readonly kind: "inline";
  readonly text: string;
}

export type LargePasteResult = LargePasteAttachmentResult | LargePasteInlineResult;

function appFailure(
  code: "invalid_args" | "unavailable" | "cancelled" | "internal",
  message: string,
): AppFailure {
  return new AppFailure({
    code,
    message,
    retryable: code === "unavailable" || code === "internal",
  });
}

function isAbort(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function matchesMime(type: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => {
    if (pattern === "*/*") return true;
    if (pattern.endsWith("/*")) return type.startsWith(pattern.slice(0, -1));
    return type === pattern;
  });
}

function lineCount(text: string): number {
  return text.length === 0 ? 0 : text.split(/\r\n|\r|\n/).length;
}

function attachmentFromStored(stored: StoredAttachment, file: File): CompleteAttachment {
  return {
    id: stored.ref.id,
    type: file.type.startsWith("image/") ? "image" : "file",
    name: stored.ref.name,
    contentType: stored.ref.mediaType,
    status: { type: "complete" },
    content: [...stored.content],
  };
}

/**
 * Stateful adapter for assistant-ui's attachment primitives. Binary content never enters a draft;
 * `toDraftRefs()` is the only persistence projection.
 */
export class AttachmentManager implements AttachmentAdapter {
  public readonly accept: string;
  private readonly blobStore: AttachmentBlobStore;
  private readonly allowedMimeTypes: readonly string[];
  private readonly maxBytes: number;
  private readonly idPrefix: string;
  private readonly pending = new Map<string, PendingAttachment>();
  private readonly complete = new Map<string, CompleteAttachment>();
  private readonly refs = new Map<string, AttachmentRef>();
  private readonly listeners = new Set<(state: AttachmentState) => void>();
  private nextId = 0;
  private snapshot: AttachmentState = {
    pending: [],
    complete: [],
    error: null,
  };
  private error: AppFailure | null = null;

  public constructor(options: AttachmentManagerOptions) {
    this.blobStore = options.blobStore;
    this.allowedMimeTypes = options.allowedMimeTypes ?? ["image/*", "text/plain", "text/markdown"];
    this.accept = options.accept ?? this.allowedMimeTypes.join(",");
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;
    this.idPrefix = options.idPrefix ?? "attachment";
  }

  public getState(): AttachmentState {
    return this.snapshot;
  }

  public subscribe(listener: (state: AttachmentState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public toDraftRefs(): readonly AttachmentRef[] {
    return [...this.complete.keys()]
      .map((id) => this.refs.get(id))
      .filter((ref): ref is AttachmentRef => ref !== undefined);
  }

  public async add({ file }: { readonly file: File }): Promise<PendingAttachment> {
    try {
      this.validate(file);
    } catch (error) {
      this.error =
        error instanceof AppFailure ? error : appFailure("invalid_args", "Attachment is invalid");
      this.notify();
      throw this.error;
    }
    const id = `${this.idPrefix}-${++this.nextId}`;
    const pending: PendingAttachment = {
      id,
      type: file.type.startsWith("image/") ? "image" : "file",
      name: file.name,
      contentType: file.type,
      file,
      status: { type: "requires-action", reason: "composer-send" },
    };
    this.pending.set(id, pending);
    this.error = null;
    this.notify();
    return pending;
  }

  public async send(
    attachment: PendingAttachment,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<CompleteAttachment> {
    if (isAbort(options.signal)) throw appFailure("cancelled", "Attachment upload cancelled");
    const existing = this.complete.get(attachment.id);
    if (existing) return existing;
    const current = this.pending.get(attachment.id) ?? attachment;
    try {
      const stored = await this.blobStore.put({
        id: current.id,
        file: current.file,
        signal: options.signal,
      });
      if (isAbort(options.signal)) throw appFailure("cancelled", "Attachment upload cancelled");
      const complete = attachmentFromStored(stored, current.file);
      this.pending.delete(current.id);
      this.complete.set(complete.id, complete);
      this.refs.set(stored.ref.id, stored.ref);
      this.error = null;
      this.notify();
      return complete;
    } catch (error) {
      const failure =
        error instanceof AppFailure ? error : appFailure("internal", "Attachment upload failed");
      this.error = failure;
      this.pending.set(current.id, {
        ...current,
        status: { type: "incomplete", reason: "error", message: failure.message },
      });
      this.notify();
      throw failure;
    }
  }

  public async remove(attachment: Attachment): Promise<void> {
    this.pending.delete(attachment.id);
    const complete = this.complete.get(attachment.id);
    if (complete) {
      try {
        await this.blobStore.delete({
          id: complete.id,
          name: complete.name,
          mediaType: complete.contentType ?? "application/octet-stream",
        });
      } catch {
        this.error = appFailure("internal", "Attachment cleanup failed");
        this.notify();
        throw this.error;
      }
      this.complete.delete(attachment.id);
      this.refs.delete(attachment.id);
    }
    this.error = null;
    this.notify();
  }
  /**
   * Drops attachments after a successful admission without deleting their blobs.
   * The draft has been cleared, so the server's orphan cleanup owns their eventual reclamation.
   */
  public clearAfterSend(): void {
    this.pending.clear();
    this.complete.clear();
    this.refs.clear();
    this.error = null;
    this.notify();
  }

  public async restore(
    refs: readonly AttachmentRef[],
    options?: { readonly signal?: AbortSignal },
  ): Promise<void> {
    this.pending.clear();
    this.complete.clear();
    this.error = null;
    this.refs.clear();
    for (const ref of refs) {
      if (isAbort(options?.signal)) throw appFailure("cancelled", "Attachment restore cancelled");
      try {
        const stored = await this.blobStore.get(ref, options);
        const file = new File([], ref.name, { type: ref.mediaType });
        this.complete.set(ref.id, attachmentFromStored(stored, file));
        this.refs.set(ref.id, ref);
      } catch (error) {
        const failure =
          error instanceof AppFailure
            ? error
            : appFailure("unavailable", "Attachment restore failed");
        this.error = failure;
        this.notify();
        throw failure;
      }
    }
    this.notify();
  }

  public async addTextAttachment(text: string, name = "pasted-text.txt"): Promise<AttachmentRef> {
    const file = new File([text], name, { type: "text/plain" });
    const pending = await this.add({ file });
    const complete = await this.send(pending);
    const ref = this.toDraftRefs().find((candidate) => candidate.id === complete.id);
    if (!ref) throw appFailure("internal", "Text attachment was not retained");
    return ref;
  }

  private validate(file: File): void {
    if (!matchesMime(file.type, this.allowedMimeTypes)) {
      throw appFailure("invalid_args", `Attachment type ${file.type || "unknown"} is not allowed`);
    }
    if (file.size > this.maxBytes) {
      throw appFailure("invalid_args", `Attachment exceeds the ${this.maxBytes} byte limit`);
    }
  }

  private notify(): void {
    this.snapshot = {
      pending: [...this.pending.values()],
      complete: [...this.complete.values()],
      error: this.error,
    };
    for (const listener of this.listeners) listener(this.snapshot);
  }
}

/**
 * Why a message that holds an image is not sent yet: the image is still loading, or it could not be attached and the
 * person removes it. Undefined once every image is attached, so the message goes out with all of them.
 */
export function attachmentHoldReason(state: AttachmentState): string | undefined {
  if (state.pending.some((attachment) => attachment.status.type === "incomplete")) {
    return "An image could not be attached. Remove it to send the message.";
  }
  if (state.pending.length > 0)
    return "The image is still loading, so the message is not sent yet.";
  return undefined;
}

export function classifyLargePaste(
  text: string,
  threshold = DEFAULT_LARGE_PASTE_LINE_THRESHOLD,
): LargePasteDecision {
  const lines = lineCount(text);
  return {
    kind: lines >= threshold && threshold > 0 ? "choose" : "inline",
    text,
    lineCount: lines,
    threshold,
  };
}

export async function applyLargePaste(
  manager: AttachmentManager,
  text: string,
  choice: LargePasteChoice,
): Promise<LargePasteResult> {
  if (choice === "inline") return { kind: "inline", text };
  return { kind: "attachment", ref: await manager.addTextAttachment(text) };
}
