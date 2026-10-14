import { describe, expect, test } from "vitest";
import { type KeptBlock, placeBlock, removeBlock } from "./composer-block";

describe("placeBlock", () => {
  test("an empty box holds the text alone", () => {
    const placed = placeBlock("", "Ship the parser", null);
    expect(placed).toEqual({
      value: "Ship the parser",
      kept: { text: "Ship the parser", start: 0, written: "Ship the parser" },
      write: true,
    });
  });

  test("text already typed is kept, and the block follows after a blank line", () => {
    const placed = placeBlock("Draft line  \n", "Ship", null);
    expect(placed.value).toBe("Draft line\n\nShip");
    expect(placed.kept.start).toBe("Draft line\n\n".length);
    expect(placed.write).toBe(true);
  });

  test("a box that already ends with the text is not written again", () => {
    const first = placeBlock("Draft", "Ship", null);
    const again = placeBlock(first.value, "Ship", first.kept);
    expect(again.write).toBe(false);
    expect(again.value).toBe("Draft\n\nShip");
  });

  test("the block kept last is replaced where it still is, and the person's text around it stays", () => {
    const first = placeBlock("Mine", "Old goal", null);
    const typed = `${first.value}\n\nAfter my block`;
    const replaced = placeBlock(typed, "New goal", { ...first.kept, written: typed });
    expect(replaced.write).toBe(true);
    expect(replaced.value).toBe("Mine\n\nNew goal\n\nAfter my block");
  });

  test("a block that is no longer in the box is added again, not replaced", () => {
    const first = placeBlock("", "Old goal", null);
    const cleared = placeBlock("Something else", "New goal", first.kept);
    expect(cleared.value).toBe("Something else\n\nNew goal");
  });

  test("writing the same text in turn never stacks two copies", () => {
    let box = "";
    let kept: KeptBlock | null = null;
    for (const text of ["Goal one", "Goal one", "Goal two", "Goal two"]) {
      const placed = placeBlock(box, text, kept);
      box = placed.value;
      kept = placed.kept;
    }
    expect(box).toBe("Goal two");
  });
});

describe("removeBlock", () => {
  test("removes the block the box still holds exactly, with the blank line it came with", () => {
    const placed = placeBlock("Draft", "Ship", null);
    expect(removeBlock(placed.value, placed.kept)).toBe("Draft");
  });

  test("an empty box that held only the block becomes empty", () => {
    const placed = placeBlock("", "Ship", null);
    expect(removeBlock(placed.value, placed.kept)).toBe("");
  });

  test("leaves the box alone when the person has changed it since the interview wrote it", () => {
    const placed = placeBlock("", "Ship", null);
    expect(removeBlock(`${placed.value} and more`, placed.kept)).toBeNull();
  });
});
