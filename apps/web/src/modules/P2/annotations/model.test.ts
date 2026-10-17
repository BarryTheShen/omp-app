import { PlanDocumentInput } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import type { PlanDocument } from "../contract";
import {
  addAnnotation,
  deleteAnnotation,
  toInput,
  undoAnnotationDeletion,
  updateAnnotation,
} from "./model";

const document: PlanDocument = {
  id: "plan-1",
  threadId: "thread-1" as PlanDocument["threadId"],
  markdown: "# Plan\n",
  sections: [{ id: "section-1", heading: "Plan", start: 0, end: 1 }],
  annotations: [
    {
      id: "annotation-1",
      sectionId: "section-1",
      text: "Review this step.",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ],
  status: "review",
  revision: 3,
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("P2.4 annotations", () => {
  test("adds and updates section annotations and returns strict PlanDocumentInput payloads", () => {
    const added = addAnnotation(
      { ...document, annotations: [] },
      { sectionId: "section-1", line: 2, text: "  Add a test. " },
      { id: "annotation-2", now: "2026-01-02T00:00:00.000Z" },
    );
    expect(PlanDocumentInput.parse(added)).toEqual({
      id: "plan-1",
      threadId: document.threadId,
      markdown: "# Plan\n",
      sections: document.sections,
      annotations: [
        {
          id: "annotation-2",
          sectionId: "section-1",
          line: 2,
          text: "Add a test.",
          createdAt: "2026-01-02T00:00:00.000Z",
          updatedAt: "2026-01-02T00:00:00.000Z",
        },
      ],
      status: "review",
    });
    const updated = updateAnnotation(
      document,
      "annotation-1",
      "  Updated. ",
      "2026-01-03T00:00:00.000Z",
    );
    expect(PlanDocumentInput.parse(updated).annotations).toEqual([
      { ...document.annotations[0], text: "Updated.", updatedAt: "2026-01-03T00:00:00.000Z" },
    ]);
  });

  test("deletes and restores an annotation without changing other order", () => {
    const deleted = deleteAnnotation(document, "annotation-1");
    expect(PlanDocumentInput.parse(deleted.document).annotations).toEqual([]);
    const restored = undoAnnotationDeletion(deleted.document, deleted.deletion);
    expect(PlanDocumentInput.parse(restored).annotations).toEqual(document.annotations);
  });

  test("undo puts a deleted first, middle or last annotation back in its place", () => {
    const entry = (id: string) => ({
      id,
      sectionId: "section-1",
      text: id,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const three = { ...document, annotations: [entry("a"), entry("b"), entry("c")] };
    for (const id of ["a", "b", "c"]) {
      const deleted = deleteAnnotation(three, id);
      const restored = undoAnnotationDeletion(deleted.document, deleted.deletion);
      expect(restored.annotations.map((annotation) => annotation.id)).toEqual(["a", "b", "c"]);
    }
  });

  test("rejects empty text, unknown sections, and unknown annotation ids", () => {
    expect(() =>
      addAnnotation(
        document,
        { sectionId: "section-1", text: "  " },
        { id: "annotation-2", now: "2026-01-02T00:00:00.000Z" },
      ),
    ).toThrow("Annotation text is required.");
    expect(() =>
      addAnnotation(
        document,
        { sectionId: "missing", text: "Note" },
        { id: "annotation-2", now: "2026-01-02T00:00:00.000Z" },
      ),
    ).toThrow("Choose a plan section");
    expect(() => updateAnnotation(document, "missing", "Note", "2026-01-02T00:00:00.000Z")).toThrow(
      "Annotation was not found.",
    );
    expect(() => deleteAnnotation(document, "missing")).toThrow("Annotation was not found.");
    expect(PlanDocumentInput.parse(toInput(document))).toEqual({
      id: document.id,
      threadId: document.threadId,
      markdown: document.markdown,
      sections: document.sections,
      annotations: document.annotations,
      status: document.status,
    });
  });
});
