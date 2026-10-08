import { useAui } from "@assistant-ui/react";
import type { EntryId } from "@omp-app/contracts";
import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import type { OmpRuntimeStore } from "@/modules/R0/store";
import type { EditComposerReplacementRequest } from "@/modules/U2/edit";
import { P3EditComposerHandoff, type P3EditSelection } from "../edit";
import { runFailure } from "./failure";
import { captureP3EditSource, isImageContent } from "./source";

/** The message being edited, and the row button that opened the editor, which focus returns to on cancel. */
export interface P3EditTarget {
  readonly entryId: EntryId;
  readonly trigger: HTMLButtonElement;
}

export interface P3EditSurfaceProps {
  readonly store: OmpRuntimeStore;
  readonly target: P3EditTarget | null;
  /** Closes the editor: after a cancel, or after a submit has been handed to the runtime. */
  readonly onClose: () => void;
}

/** A replacement image as the runtime's append carries it: an image part with its data URL. */
function imagePart(image: unknown): { readonly type: "image"; readonly image: string } {
  if (isImageContent(image)) {
    return { type: "image", image: `data:${image.mimeType};base64,${image.data}` };
  }
  if (
    typeof image === "object" &&
    image !== null &&
    "type" in image &&
    image.type === "image" &&
    "image" in image &&
    typeof image.image === "string"
  ) {
    return { type: "image", image: image.image };
  }
  throw runFailure("invalid_args", "An attached image could not be read. Attach it again.", false);
}

/** The append that edits `entryId`: the replacement text, its images, and its attachment refs. */
function editAppend(entryId: EntryId, replacement: EditComposerReplacementRequest) {
  return {
    role: "user" as const,
    sourceId: String(entryId),
    content: [
      ...(replacement.text.length > 0 ? [{ type: "text" as const, text: replacement.text }] : []),
      ...replacement.images.map(imagePart),
    ],
    attachments: replacement.attachmentRefs.map((ref) => ({
      id: ref.id,
      type: "file" as const,
      name: ref.name,
      contentType: ref.mediaType,
      content: [],
      status: { type: "complete" as const },
    })),
  };
}

/**
 * The composer-footer surface that edits an earlier message: U2's composer, loaded with the message's exact
 * text and images. Submitting hands the edit to the runtime as an append with the message as its source,
 * which R0 receives through its edit handler.
 */
export function P3EditSurface({ store, target, onClose }: P3EditSurfaceProps) {
  const aui = useAui();
  const entryId = target?.entryId ?? null;
  const selection = useMemo<P3EditSelection | null>(() => {
    if (entryId === null) return null;
    const source = captureP3EditSource(store, entryId);
    if (source === null) return null;
    return { message: { entryId, text: source.editSource.originalText }, ...source };
  }, [entryId, store]);
  if (target === null) return null;
  const restoreFocus = (): void => {
    if (target.trigger.isConnected) target.trigger.focus();
  };
  if (selection === null) {
    return (
      <section
        aria-label="Editing an earlier message"
        className="flex min-w-0 flex-col gap-2 text-sm"
        data-slot="p3-edit-surface"
      >
        <p className="text-danger" role="alert">
          That message is no longer in this chat.
        </p>
        <div>
          <Button
            onClick={() => {
              restoreFocus();
              onClose();
            }}
            size="sm"
            type="button"
            variant="outline"
          >
            Close
          </Button>
        </div>
      </section>
    );
  }
  return (
    <section
      aria-label="Editing an earlier message"
      className="flex min-w-0 flex-col gap-2"
      data-slot="p3-edit-surface"
    >
      <p className="text-muted-foreground text-sm">Editing an earlier message</p>
      <P3EditComposerHandoff
        onCancel={onClose}
        onSubmitReplacement={(submission) => {
          // Built before the editor closes: a refused image keeps the editor and the text open.
          const append = editAppend(
            submission.selection.editSource.entryId,
            submission.replacement,
          );
          onClose();
          aui.thread.append(append);
        }}
        restoreFocus={restoreFocus}
        selection={selection}
      />
    </section>
  );
}
