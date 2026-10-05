import type { AttachmentRef } from "@omp-app/contracts";

export interface EditComposerSource {
  readonly text: string;
  readonly images: readonly unknown[];
  readonly attachmentRefs: readonly AttachmentRef[];
  readonly sourceMessageId: string;
}

export interface EditComposerReplacement {
  readonly text: string;
  readonly images: readonly unknown[];
  readonly attachmentRefs: readonly AttachmentRef[];
}

export interface EditComposerSnapshot extends EditComposerSource {
  readonly isEditing: boolean;
  readonly isSubmitting: boolean;
}

export interface EditComposerReplacementRequest extends EditComposerReplacement {
  readonly sourceMessageId: string;
}

export interface EditComposerHookOptions {
  readonly onSubmitReplacement: (request: EditComposerReplacementRequest) => Promise<void> | void;
  readonly onCancel?: () => void;
}

export interface EditComposerHooks {
  load(source: EditComposerSource): void;
  cancel(): void;
  snapshot(): EditComposerSnapshot;
  submitReplacement(replacement: EditComposerReplacement): Promise<void>;
}

/**
 * Keeps the captured source and replacement draft independent from the serving host.
 * The caller owns focus and decides how the replacement is ultimately submitted.
 */
export function createEditComposerHooks(options: EditComposerHookOptions): EditComposerHooks {
  let source: EditComposerSource = {
    text: "",
    images: [],
    attachmentRefs: [],
    sourceMessageId: "",
  };
  let draft: EditComposerReplacement = {
    text: "",
    images: [],
    attachmentRefs: [],
  };
  let isEditing = false;
  let isSubmitting = false;

  return {
    load(nextSource) {
      source = nextSource;
      draft = {
        text: nextSource.text,
        images: nextSource.images,
        attachmentRefs: nextSource.attachmentRefs,
      };
      isEditing = true;
      isSubmitting = false;
    },
    cancel() {
      if (!isEditing) return;
      draft = {
        text: source.text,
        images: source.images,
        attachmentRefs: source.attachmentRefs,
      };
      isEditing = false;
      isSubmitting = false;
      options.onCancel?.();
    },
    snapshot() {
      return {
        text: draft.text,
        images: draft.images,
        attachmentRefs: draft.attachmentRefs,
        sourceMessageId: source.sourceMessageId,
        isEditing,
        isSubmitting,
      };
    },
    async submitReplacement(replacement) {
      if (!isEditing || isSubmitting) return;
      draft = replacement;
      isSubmitting = true;
      try {
        await options.onSubmitReplacement({
          ...replacement,
          sourceMessageId: source.sourceMessageId,
        });
        isEditing = false;
      } catch (error) {
        isSubmitting = false;
        throw error;
      }
      isSubmitting = false;
    },
  };
}
