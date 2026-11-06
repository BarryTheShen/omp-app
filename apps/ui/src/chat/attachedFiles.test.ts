import { describe, expect, test } from "vitest";
import { pastesCopiedFiles } from "./attachedFiles";

describe("a paste of files a file manager copied (#2833)", () => {
  test("is known by its files' addresses", () => {
    expect(pastesCopiedFiles("file:///home/me/notes%20one.txt\r\n", "")).toBe(true);
    expect(pastesCopiedFiles("# copied\nfile:///home/me/a.txt\nfile:///home/me/b.txt", "")).toBe(
      true,
    );
  });

  test("is known by their paths as its only text, as GNOME Files gives a page its copied files", () => {
    expect(pastesCopiedFiles("", "/home/me/notes one.txt")).toBe(true);
    expect(pastesCopiedFiles("", "/home/me/a.txt\n/home/me/b.txt\n")).toBe(true);
    expect(pastesCopiedFiles("", "file:///home/me/a.txt")).toBe(true);
  });

  test("text copied from a page or a program is not, nor is a copied link", () => {
    expect(pastesCopiedFiles("", "Fix the build in /home/me/app")).toBe(false);
    expect(pastesCopiedFiles("", "/home/me/a.txt\nand some words")).toBe(false);
    expect(pastesCopiedFiles("https://example.com/page", "https://example.com/page")).toBe(false);
    expect(pastesCopiedFiles("", "")).toBe(false);
  });
});
