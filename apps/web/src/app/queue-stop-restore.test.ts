import type { Omp } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { composeRestoredDraft, restoredQueueImages, restoredQueueText } from "./queue-stop-restore";

const PNG: Omp.ImageContent = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };
const JPEG: Omp.ImageContent = { type: "image", data: "d29ybGQ=", mimeType: "image/jpeg" };

describe("restoredQueueText", () => {
  test("lists the steering messages first, then the follow-ups, oldest first", () => {
    const restored: Omp.AbortAndRestoreQueueResult = {
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
    const restored: Omp.AbortAndRestoreQueueResult = {
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
