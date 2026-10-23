import { describe, expect, test } from "vitest";
import { otherFolderOf } from "./other-folder";

describe("the Other folder field", () => {
  test("a trailing separator is dropped, so the path opens as the folder it names", () => {
    expect(otherFolderOf("/live/x/")).toEqual({ ok: true, folder: "/live/x" });
    expect(otherFolderOf("/live/x//")).toEqual({ ok: true, folder: "/live/x" });
  });

  test("spaces around the path are not part of it", () => {
    expect(otherFolderOf("  /live/x/  ")).toEqual({ ok: true, folder: "/live/x" });
  });

  test("a root keeps its separator", () => {
    expect(otherFolderOf("/")).toEqual({ ok: true, folder: "/" });
    expect(otherFolderOf("C:\\")).toEqual({ ok: true, folder: "C:\\" });
  });

  test("a relative path is refused with the sentence that says what to type", () => {
    expect(otherFolderOf("projects/x")).toEqual({
      ok: false,
      message: "Type the full path to the folder, for example /home/you/project.",
    });
  });

  test("a path that starts with ~ is refused with its own sentence", () => {
    expect(otherFolderOf("~/projects/x")).toEqual({
      ok: false,
      message: "~ is not expanded here. Type the full path, for example /home/you/project.",
    });
  });

  test("an empty field is refused with its own sentence", () => {
    expect(otherFolderOf("   ")).toEqual({ ok: false, message: "Type a folder path." });
  });

  test("each refusal has a different sentence", () => {
    const sentences = ["projects/x", "~/x", "   "].map((typed) => {
      const result = otherFolderOf(typed);
      return result.ok ? "" : result.message;
    });
    expect(sentences).not.toContain("");
    expect(new Set(sentences).size).toBe(3);
  });
});
