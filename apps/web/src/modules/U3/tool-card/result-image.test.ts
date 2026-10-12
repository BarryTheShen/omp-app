import { describe, expect, test } from "vitest";
import { hideImageData, RESULT_IMAGE_MAX_BYTES, resultImagePreviews } from "./result-image";

const PNG = "iVBORw0KGgo=";

function result(...content: unknown[]) {
  return { content, details: {} };
}

describe("resultImagePreviews", () => {
  test("draws a picture omp returned as a data URL of its own base64 and type", () => {
    expect(
      resultImagePreviews(result({ type: "image", data: PNG, mimeType: "image/png" })),
    ).toEqual([{ kind: "shown", src: `data:image/png;base64,${PNG}` }]);
  });

  test("accepts the raster types a browser draws, ignoring MIME parameters and case", () => {
    expect(
      resultImagePreviews(result({ type: "image", data: PNG, mimeType: "image/webp" })),
    ).toEqual([{ kind: "shown", src: `data:image/webp;base64,${PNG}` }]);
    expect(
      resultImagePreviews(result({ type: "image", data: PNG, mimeType: "image/jpeg; charset=x" })),
    ).toEqual([{ kind: "shown", src: `data:image/jpeg;base64,${PNG}` }]);
    expect(
      resultImagePreviews(result({ type: "image", data: PNG, mimeType: "IMAGE/GIF" })),
    ).toEqual([{ kind: "shown", src: `data:image/gif;base64,${PNG}` }]);
  });

  test("refuses picture types a browser would run code from, and any other type", () => {
    expect(
      resultImagePreviews(result({ type: "image", data: PNG, mimeType: "image/svg+xml" })),
    ).toEqual([{ kind: "unsupported" }]);
    expect(
      resultImagePreviews(result({ type: "image", data: PNG, mimeType: "text/html" })),
    ).toEqual([{ kind: "unsupported" }]);
    expect(
      resultImagePreviews(result({ type: "image", data: PNG, mimeType: "constructor" })),
    ).toEqual([{ kind: "unsupported" }]);
  });

  test("never draws data that is not canonical base64 of omp's bytes", () => {
    const notBase64 = [
      "",
      "https://example.com/pixel.png",
      "iVBO Rw0K",
      "iVBORw0KGgo",
      "iVBORw0KGgo=\n",
    ];
    for (const data of notBase64) {
      expect(resultImagePreviews(result({ type: "image", data, mimeType: "image/png" }))).toEqual([
        { kind: "unreadable" },
      ]);
    }
  });

  test("says a saved reference was not loaded, rather than that its data is bad", () => {
    expect(
      resultImagePreviews(
        result({ type: "image", data: `blob:sha256:${"a".repeat(64)}`, mimeType: "image/png" }),
      ),
    ).toEqual([{ kind: "not-loaded" }]);
  });

  test("draws a picture of exactly the cap, and says so for one byte more", () => {
    // 5,592,408 characters decode to 4,194,306 bytes less the padding: the last group sets it.
    const atCap = `${"A".repeat(5_592_404)}AA==`;
    expect(
      resultImagePreviews(result({ type: "image", data: atCap, mimeType: "image/png" })),
    ).toEqual([{ kind: "shown", src: `data:image/png;base64,${atCap}` }]);
    const overCap = `${"A".repeat(5_592_404)}AAA=`;
    expect(
      resultImagePreviews(result({ type: "image", data: overCap, mimeType: "image/png" })),
    ).toEqual([{ kind: "too-large", bytes: RESULT_IMAGE_MAX_BYTES + 1 }]);
  });

  test("ignores results that hold no content and parts that are not images", () => {
    expect(resultImagePreviews("a streamed string")).toEqual([]);
    expect(resultImagePreviews({ details: {} })).toEqual([]);
    expect(
      resultImagePreviews(result({ type: "text", text: "Read image file [image/png]" })),
    ).toEqual([]);
  });
});

describe("hideImageData", () => {
  test("replaces a picture's base64 and keeps the rest of the result as omp sent it", () => {
    expect(
      hideImageData({
        content: [{ type: "image", data: PNG, mimeType: "image/png" }],
        details: { width: 24 },
      }),
    ).toEqual({
      content: [{ type: "image", data: "[picture data not shown]", mimeType: "image/png" }],
      details: { width: 24 },
    });
  });

  test("leaves data that is not part of a picture as it is", () => {
    expect(hideImageData({ type: "text", data: PNG })).toEqual({ type: "text", data: PNG });
    expect(hideImageData("a streamed string")).toBe("a streamed string");
  });
});
