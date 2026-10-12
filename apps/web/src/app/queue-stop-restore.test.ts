import type { OmpWire } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import {
  composeRestoredDraft,
  restoredQueueImages,
  restoredQueueText,
  stopRestoreNotice,
} from "./queue-stop-restore";

const PNG: OmpWire.ImageContent = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };
const JPEG: OmpWire.ImageContent = { type: "image", data: "d29ybGQ=", mimeType: "image/jpeg" };

describe("restoredQueueText", () => {
  test("lists the steering messages first, then the follow-ups, oldest first", () => {
    const restored: OmpWire.AbortAndRestoreQueueResult = {
      steering: [{ text: "steer one" }],
      followUp: [{ text: "follow one" }, { text: "follow two" }],
    };
    expect(restoredQueueText(restored)).toBe("steer one\n\nfollow one\n\nfollow two");
  });
});

describe("composeRestoredDraft", () => {
  test("puts the restored text ahead of what was already typed", () => {
    expect(composeRestoredDraft("queued", "typed now")).toBe("queued\n\ntyped now");
  });

  test("leaves out a blank part", () => {
    expect(composeRestoredDraft("queued", "  ")).toBe("queued");
    expect(composeRestoredDraft("", "typed now")).toBe("typed now");
  });
});

describe("restoredQueueImages", () => {
  test("turns each restored image into a file of its type, in message order", async () => {
    const restored: OmpWire.AbortAndRestoreQueueResult = {
      steering: [],
      followUp: [
        { text: "look", images: [PNG] },
        { text: "and this", images: [JPEG] },
      ],
    };
    const files = restoredQueueImages(restored);
    expect(files.map((file) => file.type)).toEqual(["image/png", "image/jpeg"]);
    expect(await files[0]?.text()).toBe("hello");
  });

  test("returns no files when no restored message carried an image", () => {
    expect(restoredQueueImages({ steering: [{ text: "a" }], followUp: [] })).toEqual([]);
  });
});

describe("stopRestoreNotice", () => {
  test("says the messages are back in the message box", () => {
    expect(stopRestoreNotice({ steering: [], followUp: [{ text: "a" }] })).toBe(
      "Stopped. The queued messages are back in the message box.",
    );
  });

  test("says that images were left out when omp dropped them", () => {
    expect(
      stopRestoreNotice({ steering: [], followUp: [{ text: "a" }], imagesDropped: true }),
    ).toBe(
      "Stopped. The queued messages are back in the message box, but their images were too large to bring back.",
    );
  });

  test("says that the newest messages stayed behind when the result was truncated", () => {
    expect(stopRestoreNotice({ steering: [], followUp: [{ text: "a" }], truncated: true })).toBe(
      "Stopped. The oldest queued messages are back in the message box. The rest were too large to bring back.",
    );
  });
});
