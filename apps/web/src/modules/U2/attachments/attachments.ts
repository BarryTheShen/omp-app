import type {
  Attachment,
  CompleteAttachment,
  PendingAttachment,
  ThreadUserMessagePart,
} from "@assistant-ui/react";
import type { AttachmentRef } from "@omp-app/contracts";
import { AppFailure, MAX_ATTACHMENT_BYTES } from "@omp-app/contracts";
import type { AttachmentAdapter, AttachmentState } from "../contract";

export const DEFAULT_LARGE_PASTE_LINE_THRESHOLD = 100;

const KIND_WORDS: Readonly<Record<string, string>> = {
  "image/*": "images",
  "text/plain": "plain text",
  "text/markdown": "Markdown files",
};

/** The sentence that says which kinds of file an accept list takes, in words a person reads. */
export function acceptedKindsText(accept: string): string {
  const words = accept.split(",").map((type) => KIND_WORDS[type.trim()] ?? type.trim());
  const last = words.pop();
  const kinds = words.length > 0 ? `${words.join(", ")} and ${last}` : last;
  return `Only ${kinds} can be attached.`;
}

/** A size in words for a refusal: "700 KB", "5 MB". */
export function sizeInWords(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}

/** What a person reads when the composer does not take a file: which file, and why. */
export function notAttachedMessage(name: string, reason: string): string {
  return `${name} was not attached. ${reason}`;
}

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
    this.maxBytes = options.maxBytes ?? MAX_ATTACHMENT_BYTES;
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
      // Dropped while it uploaded (see `dropPending`): its answer adds nothing.
      if (!this.pending.has(current.id)) {
        throw appFailure("cancelled", "Attachment was dropped before it finished attaching");
      }
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
      // A picture dropped while it uploaded is not shown again, and its failure is not reported.
      if (!this.pending.has(current.id)) throw failure;
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

  /**
   * Drops the pictures still being attached. A chat the person has left takes them with it, and an upload that answers
   * later adds nothing (see `send`). The pictures already attached stay.
   */
  public dropPending(): void {
    this.pending.clear();
    this.error = null;
    this.notify();
  }

  /**
   * Replaces the draft's attachments with `refs`, each loaded from its blob. A picture still being attached, or one
   * that failed, is not on the draft yet: it stays in the list, so loading a draft never drops it. A restore whose
   * `signal` is aborted has been replaced by a newer one (the chat moved on): it adds nothing and reports nothing,
   * even when its picture arrives after the newer restore has started.
   */
  public async restore(
    refs: readonly AttachmentRef[],
    options?: { readonly signal?: AbortSignal },
  ): Promise<void> {
    if (isAbort(options?.signal)) return;
    this.complete.clear();
    this.error = null;
    this.refs.clear();
    this.notify();
    for (const ref of refs) {
      try {
        const stored = await this.blobStore.get(ref, options);
        if (isAbort(options?.signal)) return;
        const file = new File([], ref.name, { type: ref.mediaType });
        this.complete.set(ref.id, attachmentFromStored(stored, file));
        this.refs.set(ref.id, ref);
      } catch (error) {
        if (isAbort(options?.signal)) return;
        const failure =
          error instanceof AppFailure
            ? error
            : appFailure("unavailable", "Attachment restore failed");
        this.error = failure;
        this.notify();
        throw failure;
      }
    }
    if (isAbort(options?.signal)) return;
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
      throw appFailure(
        "invalid_args",
        notAttachedMessage(file.name, acceptedKindsText(this.allowedMimeTypes.join(","))),
      );
    }
    if (file.size > this.maxBytes) {
      throw appFailure(
        "invalid_args",
        notAttachedMessage(
          file.name,
          `Files over ${sizeInWords(this.maxBytes)} can't be attached.`,
        ),
      );
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

/** omp collapses only a "marker-sized" paste: more than this many lines, or more than the characters below. */
const MARKER_LINES = 10;
const MARKER_CHARACTERS = 1000;

/**
 * Whether a paste is offered the choice of where it goes, as omp decides it: the paste is marker-sized and reaches the
 * threshold in lines. A threshold that is not above 0 turns the choice off, so the paste is left to the box.
 */
export function classifyLargePaste(
  text: string,
  threshold = DEFAULT_LARGE_PASTE_LINE_THRESHOLD,
): LargePasteDecision {
  const lines = lineCount(text);
  const markerSized = lines > MARKER_LINES || text.length > MARKER_CHARACTERS;
  return {
    kind: threshold > 0 && lines >= threshold && markerSized ? "choose" : "inline",
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

/** The name of a pasted-text chip: its number and line count, so two pastes never share a name. */
export function pastedTextName(sequence: number, lineCount: number): string {
  return `Pasted text ${sequence} (${lineCount} lines).txt`;
}

/** The name `pastedTextName` gives. Any other attachment is a file the person chose, and is sent as it always was. */
const PASTED_TEXT_NAME = /^Pasted text \d+ \(\d+ lines\)\.txt$/;

/** Wraps pasted text as omp does (omp v18.9.1 input-controller.ts:216-218): one quoted block for the model. */
function wrappedBlock(text: string): string {
  return `<attachment>\n${text}\n</attachment>`;
}

function unreadablePaste(): AppFailure {
  return new AppFailure({
    code: "internal",
    message: "The pasted text could not be read. Remove it and paste it again.",
    retryable: false,
  });
}

/** The text a `data:` URL carries, decoded as UTF-8: the bytes the manager stored for the chip's file. */
function textOfDataUrl(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  if (!dataUrl.startsWith("data:") || comma < 0) throw unreadablePaste();
  const bytes = Uint8Array.from(atob(dataUrl.slice(comma + 1)), (character) =>
    character.charCodeAt(0),
  );
  return new TextDecoder().decode(bytes);
}

/** The full text of a pasted-text chip, read from the file the chip holds. Undefined for any other attachment. */
function pastedText(attachment: CompleteAttachment): string | undefined {
  if (!PASTED_TEXT_NAME.test(attachment.name)) return undefined;
  for (const part of attachment.content) {
    if (part.type === "file") return textOfDataUrl(part.data);
  }
  throw unreadablePaste();
}

/**
 * The typed text, then the full text of each pasted-text chip in `attachments`, in chip order, each as omp's wrapped
 * block. The text is read from the chip's own file, which the manager keeps with the chip, so a chip restored from a
 * saved draft after a reload still sends its text.
 */
export function withPastedText(text: string, attachments: readonly CompleteAttachment[]): string {
  const blocks: string[] = [];
  for (const attachment of attachments) {
    const pasted = pastedText(attachment);
    if (pasted !== undefined) blocks.push(wrappedBlock(pasted));
  }
  return [text, ...blocks].filter((part) => part.length > 0).join("\n\n");
}
