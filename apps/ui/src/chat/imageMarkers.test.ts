import { describe, expect, test } from "vitest";
import {
  compactImageMarkers,
  imageMarker,
  markedImages,
  renumberImageMarkers,
} from "./imageMarkers";

describe("pictures named in a message, as omp's terminal names them", () => {
  test("a marker is omp's, with the picture's size when it is known", () => {
    expect(imageMarker(1, { width: 800, height: 600 })).toBe("[Image #1, 800x600]");
    expect(imageMarker(2)).toBe("[Image #2]");
    expect(markedImages("compare [Image #2, 1x1] with [Image #1] and [Image #2]")).toEqual([2, 1]);
  });

  test("taking one picture out removes its marker and the one space before it; later ones move down", () => {
    const text = "left [Image #1, 4x4] middle [Image #2, 5x5] right [Image #3]";
    expect(renumberImageMarkers(text, (n) => (n === 2 ? null : n > 2 ? n - 1 : n))).toBe(
      "left [Image #1, 4x4] middle right [Image #2]",
    );
  });

  test("a message sends only the pictures its text still names, numbered 1..K in their order", () => {
    expect(compactImageMarkers("see [Image #3] and [Image #1, 2x2]", 3)).toEqual({
      text: "see [Image #2] and [Image #1, 2x2]",
      keep: [0, 2],
    });
  });

  test("a text that names none of its pictures sends them all, as before markers", () => {
    expect(compactImageMarkers("just look", 2)).toEqual({ text: "just look", keep: [0, 1] });
  });

  test("a marker past the message's pictures is text the person wrote, left as it is", () => {
    expect(compactImageMarkers("[Image #1] and [Image #9]", 1)).toEqual({
      text: "[Image #1] and [Image #9]",
      keep: [0],
    });
  });
});
