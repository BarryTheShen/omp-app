import {
  AssistantRuntimeProvider,
  type AttachmentAdapter,
  type ThreadMessage,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { MAX_ATTACHMENT_BYTES } from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { type AttachmentBlobStore, AttachmentManager } from "../attachments/attachments";
import { createAttachmentBlobStore } from "../attachments/blob-store";
import { ComposerSurface } from "./composer";

afterEach(() => cleanup());

/** The composer's notices are what these tests read, so the blob store keeps nothing. */
const blobs: AttachmentBlobStore = {
  put: async ({ id, file }) => ({
    ref: { id, name: file.name, mediaType: file.type },
    content: [],
  }),
  get: async () => {
    throw new Error("These tests never restore an attachment.");
  },
  delete: async () => undefined,
};

/** The adapter the app gives the runtime (use-thread-runtime.ts): add validates and uploads, through this manager. */
function adapterFor(manager: AttachmentManager): AttachmentAdapter {
  return {
    accept: manager.accept,
    add: async ({ file }) => {
      const pending = await manager.add({ file });
      const complete = await manager.send(pending);
      return { ...pending, content: complete.content };
    },
    send: (attachment, options) => manager.send(attachment, options),
    remove: (attachment) => manager.remove(attachment),
  };
}

function AttachmentRuntime({
  attachments,
  children,
}: PropsWithChildren<{ readonly attachments: AttachmentAdapter }>) {
  const runtime = useExternalStoreRuntime({
    messages: [] as readonly ThreadMessage[],
    onNew: async () => undefined,
    onCancel: async () => undefined,
    adapters: { attachments },
  });
  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}

/** Renders the composer with a real attachment manager and returns its message box. */
function renderComposer(manager: AttachmentManager): HTMLElement {
  render(
    <AttachmentRuntime attachments={adapterFor(manager)}>
      <ComposerSurface submitPrompt={vi.fn(async () => undefined)} cancel={() => undefined} />
    </AttachmentRuntime>,
  );
  return screen.getByRole("textbox", { name: "Message input" });
}

/** A file dropped on the composer, the way a browser delivers it. */
function drop(target: HTMLElement, file: File): void {
  fireEvent.drop(target, { dataTransfer: { files: [file], types: ["Files"] } });
}

describe("U2.2 ComposerSurface: a file the composer will not take", () => {
  test("a dropped PDF is named in the composer, with the reason, and nothing is attached", async () => {
    const manager = new AttachmentManager({ blobStore: blobs });
    const input = renderComposer(manager);

    drop(input, new File(["%PDF-1.4"], "report.pdf", { type: "application/pdf" }));

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        "report.pdf was not attached. Only images, plain text and Markdown files can be attached.",
      ),
    );
    expect(manager.getState()).toMatchObject({ pending: [], complete: [] });
  });

  test("a pasted picture over the limit is named with the limit, and nothing is attached", async () => {
    const manager = new AttachmentManager({ blobStore: blobs, maxBytes: 3 });
    const input = renderComposer(manager);

    fireEvent.paste(input, {
      clipboardData: { files: [new File(["1234"], "shot.png", { type: "image/png" })] },
    });

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        "shot.png was not attached. Files over 3 bytes can't be attached.",
      ),
    );
    expect(manager.getState()).toMatchObject({ pending: [], complete: [] });
  });

  test("a dropped picture over the limit is named with the limit, and nothing is attached", async () => {
    const manager = new AttachmentManager({ blobStore: blobs, maxBytes: 3 });
    const input = renderComposer(manager);

    drop(input, new File(["1234"], "photo.png", { type: "image/png" }));

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        "photo.png was not attached. Files over 3 bytes can't be attached.",
      ),
    );
    expect(manager.getState()).toMatchObject({ pending: [], complete: [] });
  });

  test("a picture too big to upload is named with the upload limit, and the port is never called", async () => {
    const port = {
      put: vi.fn(async () => {
        throw new Error("The port must not be called for a picture over the upload limit.");
      }),
    };
    const blobStore = createAttachmentBlobStore(
      port as unknown as Parameters<typeof createAttachmentBlobStore>[0],
    );
    // The manager's own limit is raised so the file gets as far as the upload, the refusal this test is about.
    const manager = new AttachmentManager({ blobStore, maxBytes: 2 * MAX_ATTACHMENT_BYTES });
    const input = renderComposer(manager);

    drop(
      input,
      new File([new Uint8Array(MAX_ATTACHMENT_BYTES + 1)], "photo.png", { type: "image/png" }),
    );

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        "photo.png was not attached. Files over 700 KB can't be attached.",
      ),
    );
    expect(port.put).not.toHaveBeenCalled();
  });

  test("the notice goes away once a file the composer takes is attached", async () => {
    const manager = new AttachmentManager({ blobStore: blobs });
    const input = renderComposer(manager);
    drop(input, new File(["%PDF-1.4"], "report.pdf", { type: "application/pdf" }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());

    drop(input, new File(["ok"], "ok.png", { type: "image/png" }));

    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });
});
