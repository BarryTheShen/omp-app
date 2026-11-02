import { describe, expect, test } from "vitest";
import {
  chooseViewer,
  decodeText,
  HTML_BYTES,
  IMAGE_BYTES,
  MEDIA_BYTES,
  TEXT_EDIT_BYTES,
  TEXT_VIEW_BYTES,
} from "./viewer";

describe("the Files panel's viewer for each type and size (#2782)", () => {
  test("text is editable up to 2 MiB, read-only in part up to 20 MiB, then download only", () => {
    expect(chooseViewer("text/x-python", TEXT_EDIT_BYTES)).toMatchObject({
      kind: "text",
      editable: true,
    });
    expect(chooseViewer("text/x-python", TEXT_EDIT_BYTES + 1)).toMatchObject({
      kind: "text",
      editable: false,
      partial: true,
    });
    expect(chooseViewer("application/json", TEXT_VIEW_BYTES + 1).kind).toBe("other");
  });

  test("Markdown, HTML, images, PDF, audio and video each get their viewer within their limits", () => {
    expect(chooseViewer("text/markdown", 10).kind).toBe("markdown");
    expect(chooseViewer("text/html", HTML_BYTES).kind).toBe("html");
    expect(chooseViewer("text/html", HTML_BYTES + 1).kind).toBe("other");
    expect(chooseViewer("image/svg+xml", 10).kind).toBe("image");
    expect(chooseViewer("image/png", IMAGE_BYTES + 1).kind).toBe("other");
    expect(chooseViewer("application/pdf", MEDIA_BYTES).kind).toBe("pdf");
    expect(chooseViewer("audio/mpeg", 10).kind).toBe("audio");
    expect(chooseViewer("video/mp4", MEDIA_BYTES + 1).kind).toBe("other");
  });

  test("an unknown type is tried as text up to 2 MiB, and shown as text only when it is UTF-8", () => {
    expect(chooseViewer("application/octet-stream", 100)).toMatchObject({
      kind: "text",
      sniff: true,
    });
    expect(chooseViewer("application/octet-stream", TEXT_EDIT_BYTES + 1).kind).toBe("other");
    expect(decodeText(new TextEncoder().encode("Makefile: all\n"))).toBe("Makefile: all\n");
    expect(decodeText(new Uint8Array([0xff, 0xfe, 0x00, 0xc3]))).toBeNull();
  });
});
