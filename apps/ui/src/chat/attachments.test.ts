import { describe, expect, test } from "vitest";
import { MAX_IMAGE_BYTES, readImages } from "./attachments";

const png = (name: string, size = 4) =>
  new File([new Uint8Array(size).fill(7)], name, { type: "image/png" });

describe("readImages", () => {
  test("an image becomes base64 in omp's image shape; other files are refused by name", async () => {
    const { added, refused } = await readImages(
      [png("shot.png"), new File(["notes"], "notes.txt", { type: "text/plain" })],
      0,
    );
    expect(added.map(({ name, bytes, image }) => ({ name, bytes, image }))).toEqual([
      {
        name: "shot.png",
        bytes: 4,
        image: { type: "image", data: "BwcHBw==", mimeType: "image/png" },
      },
    ]);
    expect(refused).toEqual([
      "notes.txt is not attached: only PNG, JPEG, GIF and WebP images go with a message.",
    ]);
  });

  test("images over the message's limit, with those already in the box, are refused; smaller ones still fit", async () => {
    const { added, refused } = await readImages(
      [png("big.png", 2 * 1024 * 1024), png("small.png", 1024)],
      MAX_IMAGE_BYTES - 1024 * 1024,
    );
    expect(added.map((attachment) => attachment.name)).toEqual(["small.png"]);
    expect(refused).toEqual([
      "big.png is not attached: a message takes 10 MB of images, and this one is 2.0 MB.",
    ]);
  });
});
