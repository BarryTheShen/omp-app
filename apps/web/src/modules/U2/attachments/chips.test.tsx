import { AppFailure } from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { type AttachmentBlobStore, AttachmentManager, attachmentHoldReason } from "./attachments";
import { AttachmentChips } from "./chips";

afterEach(() => cleanup());

const LOADING = "The image is still loading, so the message is not sent yet.";
const FAILED = "An image could not be attached. Remove it to send the message.";
const REMOVE_FAILED = "photo.png could not be removed. Try again.";

/** A blob store whose upload never answers (`hang`), or always fails (`fail`). */
function managerWith(upload: "hang" | "fail"): AttachmentManager {
  const blobStore: AttachmentBlobStore = {
    put: async () => {
      if (upload === "hang") return new Promise<never>(() => undefined);
      throw new AppFailure({
        code: "unavailable",
        message: "Attachment upload is unavailable.",
        retryable: true,
      });
    },
    get: async () => {
      throw new AppFailure({ code: "unavailable", message: "Not stored.", retryable: true });
    },
    delete: async () => undefined,
  };
  return new AttachmentManager({ blobStore });
}

function photo(): File {
  return new File(["pixels"], "photo.png", { type: "image/png" });
}

/** A blob store that keeps an upload but cannot delete it, as when the server is unreachable. */
function managerThatCannotDelete(): AttachmentManager {
  const blobStore: AttachmentBlobStore = {
    put: async ({ id, file }) => ({
      ref: { id, name: file.name, mediaType: file.type },
      content: [],
    }),
    get: async () => {
      throw new AppFailure({ code: "unavailable", message: "Not stored.", retryable: true });
    },
    delete: async () => {
      throw new AppFailure({
        code: "unavailable",
        message: "The server is unreachable.",
        retryable: true,
      });
    },
  };
  return new AttachmentManager({ blobStore });
}

describe("U2 attachment chips", () => {
  test("with no attachments nothing is drawn: no empty strip in the composer card", () => {
    const { container } = render(<AttachmentChips manager={managerWith("hang")} />);

    expect(container.querySelector('[data-slot="u2-composer-attachments"]')).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  test("an image that is still loading has no Remove button, and it holds the message", async () => {
    const attachments = managerWith("hang");
    const pending = await attachments.add({ file: photo() });
    void attachments.send(pending);
    render(<AttachmentChips manager={attachments} />);

    expect(screen.getByText("photo.png")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Remove photo.png" })).toBeNull();
    expect(attachmentHoldReason(attachments.getState())).toBe(LOADING);
  });

  test("an image that could not be attached keeps a Remove button, and removing it lets the message go", async () => {
    const attachments = managerWith("fail");
    const pending = await attachments.add({ file: photo() });
    await expect(attachments.send(pending)).rejects.toMatchObject({
      appError: { code: "unavailable" },
    });
    render(<AttachmentChips manager={attachments} />);

    expect(attachmentHoldReason(attachments.getState())).toBe(FAILED);
    fireEvent.click(screen.getByRole("button", { name: "Remove photo.png" }));
    await waitFor(() => expect(screen.queryByText("photo.png")).toBeNull());
    expect(attachmentHoldReason(attachments.getState())).toBeUndefined();
  });

  test("removing an image the server cannot delete keeps its chip and says so, with no unhandled rejection", async () => {
    const attachments = managerThatCannotDelete();
    const pending = await attachments.add({ file: photo() });
    await attachments.send(pending);
    render(<AttachmentChips manager={attachments} />);

    fireEvent.click(screen.getByRole("button", { name: "Remove photo.png" }));

    expect(await screen.findByText(REMOVE_FAILED)).toBeTruthy();
    expect(screen.getByText("photo.png")).toBeTruthy();
  });

  test("the removal message is still shown when the chips are shown again", async () => {
    const attachments = managerThatCannotDelete();
    const pending = await attachments.add({ file: photo() });
    await attachments.send(pending);
    const shown = render(<AttachmentChips manager={attachments} />);

    fireEvent.click(screen.getByRole("button", { name: "Remove photo.png" }));
    expect(await screen.findByText(REMOVE_FAILED)).toBeTruthy();

    shown.unmount();
    render(<AttachmentChips manager={attachments} />);
    expect(screen.getByText(REMOVE_FAILED)).toBeTruthy();
  });
});
