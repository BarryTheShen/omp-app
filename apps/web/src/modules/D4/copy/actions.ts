import { AppFailure, type ThreadId } from "@omp-app/contracts";
import type { RawTranscriptPart } from "@/modules/U1/copy";
import {
  type ClipboardPort,
  type TranscriptActionPort,
  TranscriptCopyResultSchema,
  type TranscriptCopyTarget,
  TranscriptCopyTargetSchema,
} from "../contract";
import { buildCopyTargets, type CopySourceMessage } from "./targets";
import { refusal, textForTarget } from "./text";

export interface TranscriptActionsOptions {
  readonly threadId: ThreadId;
  /** The chat's messages as they are now, read at every call so a copy never uses earlier text. */
  readonly messages: () => readonly CopySourceMessage[];
  /** The clipboard, injected: the browser's, or a stand-in in tests and the check page. */
  readonly clipboard: ClipboardPort;
}

/**
 * D4's TranscriptActionPort over one chat. Targets and text come from U1.7's raw parts only; nothing is
 * read from rendered DOM. A clipboard refusal is a `permission` failure, so the picker can offer recovery.
 */
export function createTranscriptActions(options: TranscriptActionsOptions): TranscriptActionPort {
  return {
    async getCopyTargets(threadId, signal) {
      throwIfCancelled(signal);
      if (threadId !== options.threadId) {
        throw refusal("not_found", "That copy source is for another chat.");
      }
      return buildCopyTargets(options.messages());
    },
    async readParts(target, signal) {
      throwIfCancelled(signal);
      return partsFor(checkedTarget(target));
    },
    async copy(target, signal) {
      throwIfCancelled(signal);
      const checked = checkedTarget(target);
      const text = textForTarget(checked, partsFor(checked));
      try {
        await options.clipboard.writeText(text);
      } catch (error) {
        throw new AppFailure(
          {
            code: "permission",
            message: "The clipboard did not accept the text.",
            retryable: true,
          },
          { cause: error },
        );
      }
      return TranscriptCopyResultSchema.parse({ chars: text.length });
    },
  };

  function partsFor(target: TranscriptCopyTarget): readonly RawTranscriptPart[] {
    const message = options
      .messages()
      .find((candidate) => candidate.raw.messageKey === target.messageKey);
    if (message === undefined) {
      throw refusal("not_found", "That message is no longer in this chat.");
    }
    if (target.kind === "message") return message.raw.parts;
    const part = message.raw.parts.find((candidate) => candidate.index === target.partIndex);
    if (part === undefined) {
      throw refusal("not_found", "That part of the message is no longer here.");
    }
    return [part];
  }
}

function checkedTarget(target: TranscriptCopyTarget): TranscriptCopyTarget {
  const parsed = TranscriptCopyTargetSchema.safeParse(target);
  if (!parsed.success) throw refusal("invalid_args", "That copy target is not valid.");
  return parsed.data;
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new AppFailure({
      code: "cancelled",
      message: "The copy was cancelled.",
      retryable: false,
    });
  }
}
