import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { EditComposer } from "./edit-composer";
import { createEditComposerHooks, type EditComposerSource } from "./hooks";

const source: EditComposerSource = {
  sourceMessageId: "message-1",
  text: "original text",
  images: [{ type: "image", data: "abc", mimeType: "image/png" }],
  attachmentRefs: [{ id: "ref-1", name: "notes.txt", mediaType: "text/plain" }],
};

afterEach(() => cleanup());

describe("U2.7 edit hooks", () => {
  test("loads and cancels with the exact source draft", () => {
    const onCancel = vi.fn();
    const hooks = createEditComposerHooks({ onSubmitReplacement: vi.fn(), onCancel });
    hooks.load(source);
    expect(hooks.snapshot()).toMatchObject({ ...source, isEditing: true, isSubmitting: false });

    hooks.cancel();
    expect(hooks.snapshot()).toMatchObject({ ...source, isEditing: false, isSubmitting: false });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  test("passes one replacement callback and permits retry after failure", async () => {
    const submitReplacement = vi
      .fn<(request: { sourceMessageId: string; text: string }) => Promise<void>>()
      .mockRejectedValueOnce(new Error("admission failed"))
      .mockResolvedValueOnce(undefined);
    const hooks = createEditComposerHooks({
      onSubmitReplacement: async (request) => submitReplacement(request),
    });
    hooks.load(source);

    await expect(
      hooks.submitReplacement({
        text: "replacement",
        images: source.images,
        attachmentRefs: source.attachmentRefs,
      }),
    ).rejects.toThrow("admission failed");
    expect(hooks.snapshot().isEditing).toBe(true);
    await hooks.submitReplacement({
      text: "replacement",
      images: source.images,
      attachmentRefs: source.attachmentRefs,
    });
    expect(submitReplacement).toHaveBeenCalledTimes(2);
    expect(submitReplacement).toHaveBeenLastCalledWith({
      sourceMessageId: source.sourceMessageId,
      text: "replacement",
      images: source.images,
      attachmentRefs: source.attachmentRefs,
    });
    expect(hooks.snapshot().isEditing).toBe(false);
  });
});

describe("U2.7 EditComposer", () => {
  test("loads exact source text and attachment refs into the inline composer", async () => {
    render(
      <EditComposer
        source={source}
        submitReplacement={async () => undefined}
        onCancel={() => undefined}
      />,
    );
    const input = screen.getByRole("textbox", { name: "Edit message" });
    await waitFor(() => expect((input as HTMLTextAreaElement).value).toBe("original text"));
    await waitFor(() => expect(screen.getByText("notes.txt")).toBeTruthy());
  });

  test("Escape cancels without submitting and restores the captured source", async () => {
    const cancel = vi.fn();
    const submitReplacement = vi.fn(async () => undefined);
    render(
      <EditComposer source={source} submitReplacement={submitReplacement} onCancel={cancel} />,
    );
    const input = screen.getByRole("textbox", { name: "Edit message" });
    await waitFor(() => expect((input as HTMLTextAreaElement).value).toBe("original text"));
    fireEvent.change(input, { target: { value: "draft replacement" } });
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect((input as HTMLTextAreaElement).value).toBe("original text"));
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(submitReplacement).not.toHaveBeenCalled();
  });

  test("submits one replacement with the source id and current attachments", async () => {
    const submitted: unknown[] = [];
    render(
      <EditComposer
        source={source}
        submitReplacement={async (request) => {
          submitted.push(request);
        }}
        onCancel={() => undefined}
      />,
    );
    const input = screen.getByRole("textbox", { name: "Edit message" });
    await waitFor(() => expect((input as HTMLTextAreaElement).value).toBe("original text"));
    fireEvent.change(input, { target: { value: "replacement" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]).toMatchObject({
      sourceMessageId: source.sourceMessageId,
      text: "replacement",
    });
    expect(submitted[0]).toHaveProperty("attachmentRefs", [
      { id: "edit-image-0", name: "Image 1", mediaType: "image/png" },
      ...source.attachmentRefs,
    ]);
    fireEvent.keyDown(input, { key: "Enter" });
    await Promise.resolve();
    expect(submitted).toHaveLength(1);
  });
});
