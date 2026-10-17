import { AppFailure } from "@omp-app/contracts";
import { useEffect, useId, useRef, useState } from "react";
import { InlineError } from "../../../components/blocks";
import { Button } from "../../../components/ui/button";
import { Textarea } from "../../../components/ui/textarea";
import type { PlanAnnotation, PlanDocument, PlanDocumentInput } from "../contract";
import { type AnnotationExternalEditor, refineInExternalEditor } from "./external-editor";
import {
  type AnnotationClock,
  type AnnotationDeletion,
  type AnnotationDraft,
  addAnnotation,
  deleteAnnotation,
  undoAnnotationDeletion,
  updateAnnotation,
} from "./model";

export type AnnotationEditorProps = {
  readonly document: PlanDocument;
  readonly annotation?: PlanAnnotation;
  readonly sectionId: string;
  readonly line?: number;
  readonly expectedRevision: number;
  readonly externalEditor?: AnnotationExternalEditor;
  readonly onSave: (document: PlanDocumentInput, expectedRevision: number) => Promise<void>;
  readonly onError?: (message: string) => void;
  readonly clock?: () => AnnotationClock;
};

function AnnotationEditor({
  document,
  annotation,
  sectionId,
  line,
  expectedRevision,
  externalEditor,
  onSave,
  onError,
  clock = () => ({ id: crypto.randomUUID(), now: new Date().toISOString() }),
}: AnnotationEditorProps) {
  const activeAnnotation =
    annotation ?? document.annotations.find((candidate) => candidate.sectionId === sectionId);
  const [text, setText] = useState(activeAnnotation?.text ?? "");
  const [edited, setEdited] = useState(false);
  const [deleted, setDeleted] = useState<AnnotationDeletion | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingSave, setPendingSave] = useState<PlanDocumentInput | null>(null);
  const annotationTextId = useId();
  const externalEditorReasonId = useId();

  const annotationRef = useRef(activeAnnotation);
  useEffect(() => {
    if (annotationRef.current === activeAnnotation) return;
    annotationRef.current = activeAnnotation;
    setText(activeAnnotation?.text ?? "");
    setEdited(false);
    setDeleted(null);
    setError(null);
    setPendingSave(null);
  }, [activeAnnotation]);

  const displayText = edited ? text : (activeAnnotation?.text ?? text);
  const isConflict = (failure: unknown): boolean =>
    failure instanceof AppFailure && failure.appError.code === "conflict";
  const reportError = (failure: unknown): void => {
    const message = isConflict(failure)
      ? "This plan changed elsewhere. Reload it, then save again."
      : failure instanceof Error
        ? failure.message
        : "The annotation could not be saved.";
    setError(message);
    onError?.(message);
  };

  const save = async (next: PlanDocumentInput): Promise<boolean> => {
    setBusy(true);
    setPendingSave(next);
    try {
      await onSave(next, expectedRevision);
      setDeleted(null);
      setError(null);
      setPendingSave(null);
      return true;
    } catch (failure) {
      // A conflict needs the plan reloaded first: sending the same input again cannot work, so no Retry.
      if (isConflict(failure)) setPendingSave(null);
      reportError(failure);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const saveText = async (): Promise<void> => {
    try {
      const next =
        activeAnnotation === undefined
          ? addAnnotation(
              document,
              { sectionId, line, text: displayText } satisfies AnnotationDraft,
              clock(),
            )
          : updateAnnotation(document, activeAnnotation.id, displayText, clock().now);
      await save(next);
    } catch (failure) {
      reportError(failure);
    }
  };

  const remove = async (): Promise<void> => {
    if (activeAnnotation === undefined) return;
    try {
      const result = deleteAnnotation(document, activeAnnotation.id);
      if (await save(result.document)) setDeleted(result.deletion);
    } catch (failure) {
      reportError(failure);
    }
  };

  const undo = async (): Promise<void> => {
    if (deleted === null) return;
    await save(undoAnnotationDeletion(document, deleted));
  };

  const refine = async (): Promise<void> => {
    try {
      const refined = await refineInExternalEditor(externalEditor, displayText);
      setText(refined);
      setEdited(true);
      setError(null);
    } catch (failure) {
      reportError(failure);
    }
  };
  return (
    <section
      aria-label="Plan annotation editor"
      className="border-border bg-card rounded-lg border p-4"
    >
      <label
        className="text-foreground flex flex-col gap-2 text-sm font-medium"
        htmlFor={annotationTextId}
      >
        Annotation
        <Textarea
          id={annotationTextId}
          value={displayText}
          onChange={(event) => {
            setEdited(true);
            setText(event.target.value);
            setError(null);
          }}
        />
      </label>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button type="button" onClick={() => void saveText()} disabled={busy}>
          Save annotation
        </Button>
        <Button
          type="button"
          variant="outline"
          aria-describedby={externalEditorReasonId}
          onClick={() => void refine()}
          disabled={busy || externalEditor === undefined}
        >
          Edit in external editor
        </Button>
        {activeAnnotation !== undefined ? (
          <Button type="button" variant="outline" onClick={() => void remove()} disabled={busy}>
            Delete annotation
          </Button>
        ) : null}
        {deleted !== null ? (
          <Button type="button" variant="ghost" onClick={() => void undo()} disabled={busy}>
            Undo delete
          </Button>
        ) : null}
        <span id={externalEditorReasonId} className="text-muted-foreground w-full text-xs">
          {externalEditor === undefined
            ? "An external editor is not available in this host."
            : "Open the annotation in the host editor."}
        </span>
        {error ? (
          <InlineError
            message={error}
            onRetry={pendingSave === null ? undefined : () => void save(pendingSave)}
            retryLabel="Retry save"
            variant="message"
          />
        ) : null}
      </div>
    </section>
  );
}

export { AnnotationEditor };
