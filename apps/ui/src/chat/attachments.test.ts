import { describe, expect, test } from "vitest";
import { MAX_IMAGE_BYTES, readImages } from "./attachments";

const png = (name: string, size = 4) =>
  new File([new Uint8Array(size).fill(7)], name, { type: "image/png" });

describe("readImages", () => {
  test("an image becomes base64 in omp's image shape; any other file comes back to be uploaded", async () => {
    const notes = new File(["notes"], "notes.txt", { type: "text/plain" });
    const { added, others } = await readImages([png("shot.png"), notes], 0);
    expect(added.map(({ name, bytes, image }) => ({ name, bytes, image }))).toEqual([
      {
        name: "shot.png",
        bytes: 4,
        image: { type: "image", data: "BwcHBw==", mimeType: "image/png" },
      },
    ]);
    expect(others).toEqual([notes]);
  });

  test("an image past the message's limit, with those already in the box, comes back as a file; a smaller one still fits", async () => {
    const big = png("big.png", 2 * 1024 * 1024);
    const { added, others } = await readImages(
      [big, png("small.png", 1024)],
      MAX_IMAGE_BYTES - 1024 * 1024,
    );
    expect(added.map((attachment) => attachment.name)).toEqual(["small.png"]);
    expect(others).toEqual([big]);
  });
});
