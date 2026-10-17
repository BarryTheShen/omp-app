import { AppFailure } from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { PlanDocument } from "../contract";
import { AnnotationEditor } from "./editor";

afterEach(() => cleanup());
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
const annotation = {
  id: "annotation-1",
  sectionId: "section-1",
  text: "Review this step.",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("AnnotationEditor", () => {
  test("saves a refined annotation through the revision boundary", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const editor = { open: vi.fn().mockResolvedValue("Refined wording.") };
    render(
      <AnnotationEditor
        document={document}
        annotation={annotation}
        sectionId="section-1"
        expectedRevision={3}
        externalEditor={editor}
        onSave={onSave}
        clock={() => ({ id: "annotation-1", now: "2026-01-04T00:00:00.000Z" })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit in external editor" }));
    await waitFor(() =>
      expect(editor.open).toHaveBeenCalledWith("Review this step.", expect.anything()),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Annotation" }), {
      target: { value: "Refined wording." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save annotation" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]?.[0]).toEqual({
      id: "plan-1",
      threadId: document.threadId,
      markdown: "# Plan\n",
      sections: document.sections,
      annotations: [
        {
          ...annotation,
          text: "Refined wording.",
          updatedAt: "2026-01-04T00:00:00.000Z",
        },
      ],
      status: "review",
    });
    expect(onSave.mock.calls[0]?.[1]).toBe(3);
  });

  test("deletes and offers undo for an annotation", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <AnnotationEditor
        document={document}
        annotation={annotation}
        sectionId="section-1"
        expectedRevision={3}
        onSave={onSave}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete annotation" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Undo delete" })).toBeTruthy());
    expect(onSave.mock.calls[0]?.[0]).toEqual({
      id: "plan-1",
      threadId: document.threadId,
      markdown: "# Plan\n",
      sections: document.sections,
      annotations: [],
      status: "review",
    });
    fireEvent.click(screen.getByRole("button", { name: "Undo delete" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(onSave.mock.calls[1]?.[0]).toEqual({
      id: "plan-1",
      threadId: document.threadId,
      markdown: "# Plan\n",
      sections: document.sections,
      annotations: document.annotations,
      status: "review",
    });
  });

  test("keeps the typed text and shows no Undo when delete is refused", async () => {
    const onSave = vi
      .fn()
      .mockRejectedValue(new AppFailure({ code: "conflict", message: "changed", retryable: true }));
    render(
      <AnnotationEditor
        document={document}
        annotation={annotation}
        sectionId="section-1"
        expectedRevision={3}
        onSave={onSave}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete annotation" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("This plan changed elsewhere."),
    );
    expect(screen.queryByRole("button", { name: "Undo delete" })).toBeNull();
  });

  test("lets the person empty the field, and refuses to save it empty", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <AnnotationEditor
        document={document}
        annotation={annotation}
        sectionId="section-1"
        expectedRevision={3}
        onSave={onSave}
      />,
    );
    const field = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Annotation" });
    fireEvent.change(field, { target: { value: "" } });
    expect(field.value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Save annotation" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("Annotation text is required."),
    );
    expect(onSave).not.toHaveBeenCalled();
  });

  test("Retry save sends the same input again and clears the error once it works", async () => {
    const onSave = vi
      .fn()
      .mockRejectedValueOnce(new Error("The plan could not be saved."))
      .mockResolvedValue(undefined);
    render(
      <AnnotationEditor
        document={document}
        annotation={annotation}
        sectionId="section-1"
        expectedRevision={3}
        onSave={onSave}
      />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Annotation" }), {
      target: { value: "Changed wording." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save annotation" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("The plan could not be saved."),
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(onSave.mock.calls[1]?.[0]).toEqual(onSave.mock.calls[0]?.[0]);
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  test("offers no Retry after a conflict, because the plan has to be reloaded first", async () => {
    const onSave = vi
      .fn()
      .mockRejectedValue(new AppFailure({ code: "conflict", message: "changed", retryable: true }));
    render(
      <AnnotationEditor
        document={document}
        annotation={annotation}
        sectionId="section-1"
        expectedRevision={3}
        onSave={onSave}
      />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Annotation" }), {
      target: { value: "Changed wording." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save annotation" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("This plan changed elsewhere."),
    );
    expect(screen.queryByRole("button", { name: "Retry save" })).toBeNull();
  });

  test("disables the external editor and says why when the host has none", () => {
    render(
      <AnnotationEditor
        document={document}
        annotation={annotation}
        sectionId="section-1"
        expectedRevision={3}
        onSave={vi.fn()}
      />,
    );
    const button = screen.getByRole("button", { name: "Edit in external editor" });
    expect(button.hasAttribute("disabled")).toBe(true);
    const reason = screen.getByText("An external editor is not available in this host.");
    expect(button.getAttribute("aria-describedby")).toBe(reason.getAttribute("id"));
  });

  test("disables Save while a save is pending", async () => {
    const onSave = vi.fn().mockReturnValue(new Promise<void>(() => undefined));
    render(
      <AnnotationEditor
        document={document}
        annotation={annotation}
        sectionId="section-1"
        expectedRevision={3}
        onSave={onSave}
      />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Annotation" }), {
      target: { value: "Changed wording." },
    });
    const save = screen.getByRole("button", { name: "Save annotation" });
    fireEvent.click(save);
    await waitFor(() => expect(save.hasAttribute("disabled")).toBe(true));
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  test("adds an annotation to a section that has none", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <AnnotationEditor
        document={{ ...document, annotations: [] }}
        sectionId="section-1"
        line={4}
        expectedRevision={3}
        onSave={onSave}
        clock={() => ({ id: "annotation-new", now: "2026-01-05T00:00:00.000Z" })}
      />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Annotation" }), {
      target: { value: "  Add a test.  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save annotation" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]?.[0].annotations).toEqual([
      {
        id: "annotation-new",
        sectionId: "section-1",
        line: 4,
        text: "Add a test.",
        createdAt: "2026-01-05T00:00:00.000Z",
        updatedAt: "2026-01-05T00:00:00.000Z",
      },
    ]);
    expect(screen.queryByRole("button", { name: "Delete annotation" })).toBeNull();
  });
});
