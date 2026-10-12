import { AppFailure } from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { type AttachmentBlobStore, AttachmentManager, attachmentHoldReason } from "./attachments";
import { AttachmentChips } from "./chips";

afterEach(() => cleanup());

const LOADING = "The image is still loading, so the message is not sent yet.";
const FAILED = "An image could not be attached. Remove it to send the message.";

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

describe("U2 attachment chips", () => {
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
});
