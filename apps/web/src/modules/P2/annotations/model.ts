import type { PlanAnnotation, PlanDocument, PlanDocumentInput } from "../contract";

export type AnnotationDraft = {
  readonly sectionId: string;
  readonly line?: number;
  readonly text: string;
};

export type AnnotationClock = {
  readonly id: string;
  readonly now: string;
};

export type PlanDocumentLike = PlanDocument | PlanDocumentInput;
export type AnnotationDeletion = {
  readonly annotation: PlanAnnotation;
  readonly index: number;
};

export function toInput(document: PlanDocumentLike): PlanDocumentInput {
  return {
    id: document.id,
    threadId: document.threadId,
    markdown: document.markdown,
    sections: document.sections,
    annotations: document.annotations,
    status: document.status,
  };
}

export function addAnnotation(
  document: PlanDocumentLike,
  draft: AnnotationDraft,
  clock: AnnotationClock,
): PlanDocumentInput {
  const text = draft.text.trim();
  if (text.length === 0) throw new Error("Annotation text is required.");
  if (!document.sections.some((section) => section.id === draft.sectionId)) {
    throw new Error("Choose a plan section for this annotation.");
  }
  const annotation: PlanAnnotation = {
    id: clock.id,
    sectionId: draft.sectionId,
    ...(draft.line === undefined ? {} : { line: draft.line }),
    text,
    createdAt: clock.now,
    updatedAt: clock.now,
  };
  return toInput({ ...document, annotations: [...document.annotations, annotation] });
}

export function updateAnnotation(
  document: PlanDocumentLike,
  annotationId: string,
  text: string,
  now: string,
): PlanDocumentInput {
  const nextText = text.trim();
  if (nextText.length === 0) throw new Error("Annotation text is required.");
  let found = false;
  const annotations = document.annotations.map((annotation) => {
    if (annotation.id !== annotationId) return annotation;
    found = true;
    return { ...annotation, text: nextText, updatedAt: now };
  });
  if (!found) throw new Error("Annotation was not found.");
  return toInput({ ...document, annotations });
}

export function deleteAnnotation(
  document: PlanDocumentLike,
  annotationId: string,
): { readonly document: PlanDocumentInput; readonly deletion: AnnotationDeletion } {
  const index = document.annotations.findIndex((annotation) => annotation.id === annotationId);
  if (index < 0) throw new Error("Annotation was not found.");
  const annotation = document.annotations[index];
  if (!annotation) throw new Error("Annotation was not found.");
  return {
    document: toInput({
      ...document,
      annotations: document.annotations.filter((candidate) => candidate.id !== annotationId),
    }),
    deletion: { annotation, index },
  };
}

export function undoAnnotationDeletion(
  document: PlanDocumentInput,
  deletion: AnnotationDeletion,
): PlanDocumentInput {
  if (document.annotations.some((annotation) => annotation.id === deletion.annotation.id)) {
    return toInput(document);
  }
  const annotations = [...document.annotations];
  annotations.splice(Math.min(deletion.index, annotations.length), 0, deletion.annotation);
  return toInput({ ...document, annotations });
}
