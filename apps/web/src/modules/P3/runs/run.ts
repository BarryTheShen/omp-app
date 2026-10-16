import type { EntryId, OmpWire } from "@omp-app/contracts";
import type { PromptIntent } from "@/modules/R0/runtime";
import type {
  EditRequest,
  EditRunDecorator,
  EditRunPort,
  EditRunResult,
  ReloadRunPort,
} from "../contract";
import { runFailure } from "./failure";
import type { P3ThreadHandoff } from "./handoff";
import { isImageContent } from "./source";
import type { P3RunReplacement } from "./status";

/** The part of R0.4's branching controller a run calls: it branches from a user entry, then sends through R0.3. */
export interface P3BranchHandler {
  editFrom(entryId: EntryId, intent: PromptIntent): Promise<void>;
  regenerateFrom(entryId: EntryId): Promise<void>;
  reconcileAfterBranch(): Promise<void>;
}

export interface P3EditRunOptions {
  readonly branching: P3BranchHandler;
  readonly handoff: P3ThreadHandoff;
  /** P5's hook: a decorator may restore the workspace before the send and reports what it found. */
  readonly decorator?: EditRunDecorator | undefined;
}

/** Edit, regenerate and resend. Branching stays in R0.4; this layer captures the source and reports the result. */
export interface P3EditRun extends EditRunPort, ReloadRunPort {
  /** Sends a replacement again on the chat a run already opened, without branching again. */
  resend(replacement: P3RunReplacement): Promise<EditRunResult>;
}

/** Converts the images a replacement carries to omp's wire type, before any branch is made. */
function ompImages(images: readonly unknown[]): readonly OmpWire.ImageContent[] {
  return images.map((image) => {
    if (!isImageContent(image)) {
      throw runFailure(
        "invalid_args",
        "An attached image could not be read. Attach it again.",
        false,
      );
    }
    return image;
  });
}

function admittedResult(handoff: P3ThreadHandoff): EditRunResult {
  const threadId = handoff.target;
  if (threadId === null) {
    throw runFailure("internal", "omp did not open a new chat for the message.", true);
  }
  return { threadId, admitted: true, settled: false, workspaceGuarantee: "not-managed" };
}

function cancelIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw runFailure("cancelled", "The edit was cancelled before omp branched the chat.", false);
  }
}

export function createP3EditRun(options: P3EditRunOptions): P3EditRun {
  const { branching, handoff, decorator } = options;

  // R0.4 branches from the entry, then sends the replacement on the chat omp opened.
  const branchAndSend = async (request: EditRequest): Promise<EditRunResult> => {
    cancelIfAborted(request.signal);
    handoff.beginRun();
    const images = ompImages(request.replacementImages);
    await branching.editFrom(request.source.entryId, {
      mode: "prompt",
      text: request.replacementText,
      ...(images.length > 0 ? { images } : {}),
      delivery: "new",
    });
    return admittedResult(handoff);
  };

  // An answer asked again branches from its user entry and sends that entry's text again.
  const branchAndRegenerate = async (request: EditRequest): Promise<EditRunResult> => {
    cancelIfAborted(request.signal);
    handoff.beginRun();
    await branching.regenerateFrom(request.source.entryId);
    return admittedResult(handoff);
  };

  return {
    edit: (request) => (decorator ? decorator(request, branchAndSend) : branchAndSend(request)),
    reload: (request) => {
      // A regeneration sends the original text and images, so it goes through the same decorator.
      const asEdit: EditRequest = {
        source: request.source,
        replacementText: request.source.originalText,
        replacementImages: request.source.originalImages,
        ...(request.signal ? { signal: request.signal } : {}),
      };
      return decorator ? decorator(asEdit, branchAndRegenerate) : branchAndRegenerate(asEdit);
    },
    resend: async (replacement) => {
      await branching.reconcileAfterBranch();
      const images = ompImages(replacement.images);
      const threadId = await handoff.submit({
        mode: "prompt",
        text: replacement.text,
        ...(images.length > 0 ? { images } : {}),
        delivery: "new",
      });
      return { threadId, admitted: true, settled: false, workspaceGuarantee: "not-managed" };
    },
  };
}
