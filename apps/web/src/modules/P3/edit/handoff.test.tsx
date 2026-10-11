import { EntryId as EntryIdSchema, ThreadId as ThreadIdSchema } from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { P3EditSelection, P3EditSubmission } from "./handoff";
import { P3EditComposerHandoff } from "./handoff";

afterEach(cleanup);

function selectionFor(thread: string, text: string): P3EditSelection {
  const threadId = ThreadIdSchema.parse(thread);
  const entryId = EntryIdSchema.parse("entry-shared");
  const image = { type: "image", mimeType: "image/png", data: "c2NyYXRjaA==" };
  const attachmentRefs = [{ id: "notes-ref", name: "notes.txt", mediaType: "text/plain" }];
  return {
    message: { entryId, text },
    editSource: {
      threadId,
      entryId,
      parentId: null,
      originalText: text,
      originalImages: [image],
      sourceHeadId: "head-1",
    },
    composerSource: {
      text,
      images: [image],
      attachmentRefs,
      sourceMessageId: String(entryId),
    },
  };
}

describe("P3 edit composer handoff", () => {
  test("loads and restores the exact selected source on cancel", async () => {
    const selection = selectionFor("thread-a", "Original prompt");
    const submitReplacement = vi.fn(async (_submission: P3EditSubmission) => undefined);
    const onCancel = vi.fn();
    render(
      <P3EditComposerHandoff
        selection={selection}
        onSubmitReplacement={submitReplacement}
        onCancel={onCancel}
        restoreFocus={() => undefined}
      />,
    );

    const input = screen.getByRole("textbox", { name: "Edit message" });
    await waitFor(() => expect(input).toHaveProperty("value", "Original prompt"));
    expect(screen.getByText("notes.txt")).toBeTruthy();
    fireEvent.change(input, { target: { value: "Unsent change" } });
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(input).toHaveProperty("value", "Original prompt"));
    expect(screen.getByText("notes.txt")).toBeTruthy();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(submitReplacement).not.toHaveBeenCalled();
    expect(selection.editSource.originalImages).toHaveLength(1);
    expect(selection.composerSource.images).toHaveLength(1);
    expect(selection.composerSource.attachmentRefs).toEqual([
      { id: "notes-ref", name: "notes.txt", mediaType: "text/plain" },
    ]);
  });

  test("moves focus back to the opener before cancelling", async () => {
    const selection = selectionFor("thread-focus", "Original prompt");
    const opener = "Edit an earlier message";
    render(
      <>
        <button type="button">{opener}</button>
        <P3EditComposerHandoff
          selection={selection}
          onSubmitReplacement={async () => undefined}
          onCancel={() => undefined}
          restoreFocus={() => screen.getByRole("button", { name: opener }).focus()}
        />
      </>,
    );

    const input = screen.getByRole("textbox", { name: "Edit message" });
    await waitFor(() => expect(input).toHaveProperty("value", "Original prompt"));
    fireEvent.keyDown(input, { key: "Escape" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: opener }));
  });

  test("returns replacement text and attachments with the selected source identity", async () => {
    const selection = selectionFor("thread-a", "Original prompt");
    const submissions: P3EditSubmission[] = [];
    const submitReplacement = vi.fn(async (submission: P3EditSubmission) => {
      submissions.push(submission);
    });
    render(
      <P3EditComposerHandoff
        selection={selection}
        onSubmitReplacement={submitReplacement}
        onCancel={() => undefined}
        restoreFocus={() => undefined}
      />,
    );

    const input = screen.getByRole("textbox", { name: "Edit message" });
    await waitFor(() => expect(input).toHaveProperty("value", "Original prompt"));
    expect(screen.getByText("notes.txt")).toBeTruthy();
    fireEvent.change(input, { target: { value: "Replacement prompt" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(submissions).toHaveLength(1));
    expect(submissions[0]?.selection).toBe(selection);
    expect(submissions[0]?.replacement).toMatchObject({
      sourceMessageId: String(selection.editSource.entryId),
      text: "Replacement prompt",
    });
    expect(submissions[0]?.replacement.attachmentRefs).toContainEqual({
      id: "notes-ref",
      name: "notes.txt",
      mediaType: "text/plain",
    });
    expect(selection.editSource.originalImages).toHaveLength(1);
    expect(selection.composerSource.images).toHaveLength(1);
  });

  test("uses the new source when two threads share an entry id", async () => {
    const first = selectionFor("thread-first", "First thread prompt");
    const second = selectionFor("thread-second", "Second thread prompt");
    const submissions: P3EditSubmission[] = [];
    const submitReplacement = vi.fn(async (submission: P3EditSubmission) => {
      submissions.push(submission);
    });
    const props = {
      onSubmitReplacement: submitReplacement,
      onCancel: () => undefined,
      restoreFocus: () => undefined,
    };
    const { rerender } = render(<P3EditComposerHandoff {...props} selection={first} />);
    const input = screen.getByRole("textbox", { name: "Edit message" });
    await waitFor(() => expect(input).toHaveProperty("value", "First thread prompt"));

    rerender(<P3EditComposerHandoff {...props} selection={second} />);
    const updatedInput = screen.getByRole("textbox", { name: "Edit message" });
    await waitFor(() => expect(updatedInput).toHaveProperty("value", "Second thread prompt"));
    fireEvent.change(updatedInput, { target: { value: "Updated second thread" } });
    fireEvent.keyDown(updatedInput, { key: "Enter" });

    await waitFor(() => expect(submissions).toHaveLength(1));
    expect(submissions[0]?.selection).toBe(second);
    expect(submissions[0]?.replacement).toMatchObject({ text: "Updated second thread" });
  });
  test("uses the latest callback while the selected source stays the same", async () => {
    const selection = selectionFor("thread-current-callback", "Original prompt");
    const firstSubmit = vi.fn(async (_submission: P3EditSubmission) => undefined);
    const latestSubmit = vi.fn(async (_submission: P3EditSubmission) => undefined);
    const props = { onCancel: () => undefined, restoreFocus: () => undefined, selection };
    const { rerender } = render(
      <P3EditComposerHandoff {...props} onSubmitReplacement={firstSubmit} />,
    );
    const input = screen.getByRole("textbox", { name: "Edit message" });
    await waitFor(() => expect(input).toHaveProperty("value", "Original prompt"));

    rerender(<P3EditComposerHandoff {...props} onSubmitReplacement={latestSubmit} />);
    fireEvent.change(input, { target: { value: "Current callback" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(latestSubmit).toHaveBeenCalledTimes(1));
    expect(firstSubmit).not.toHaveBeenCalled();
  });
});
