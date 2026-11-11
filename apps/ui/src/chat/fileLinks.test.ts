import { describe, expect, test } from "vitest";
import { isFileHref } from "../vendor/collab-web/components/transcript/fileHref";
import { resolveFileLink } from "./fileLinks";

const folder = "/home/user/work";

describe("a reply's links to files (#17)", () => {
  test("paths and file: name files; pages, mail, anchors and //host do not", () => {
    for (const href of [
      "report.md",
      "./a/b.csv",
      "/home/user/work/x.md",
      "file:///home/user/work/x.md",
      "dir/",
    ]) {
      expect(isFileHref(href)).toBe(true);
    }
    for (const href of [
      "https://example.com/a.md",
      "mailto:a@b.c",
      "#part",
      "//cdn.example.com/x.js",
      "javascript:alert(1)",
      "",
    ]) {
      expect(isFileHref(href)).toBe(false);
    }
  });

  test("a link opens its file in the chat's folder, its escapes, fragment and line dropped", () => {
    expect(resolveFileLink("career/quantitative/report.md", folder)).toEqual({
      kind: "file",
      path: "career/quantitative/report.md",
    });
    expect(resolveFileLink("./a/../b/My%20File.csv#L10", folder)).toEqual({
      kind: "file",
      path: "b/My File.csv",
    });
    expect(resolveFileLink("src/app.ts:42:7", folder)).toEqual({
      kind: "file",
      path: "src/app.ts",
    });
    expect(resolveFileLink("/home/user/work/notes/x.md?raw=1", folder)).toEqual({
      kind: "file",
      path: "notes/x.md",
    });
    expect(resolveFileLink("file:///home/user/work/a%20b.md", folder)).toEqual({
      kind: "file",
      path: "a b.md",
    });
  });

  test("a link out of the chat's folder is outside, wherever it points", () => {
    expect(resolveFileLink("../secrets.txt", folder)).toEqual({
      kind: "outside",
      path: "/home/user/secrets.txt",
    });
    expect(resolveFileLink("/etc/passwd", folder)).toEqual({
      kind: "outside",
      path: "/etc/passwd",
    });
    expect(resolveFileLink("/home/user/workshop/x.md", folder)).toEqual({
      kind: "outside",
      path: "/home/user/workshop/x.md",
    });
    expect(resolveFileLink("~/.ssh/id_rsa", folder)).toEqual({
      kind: "outside",
      path: "~/.ssh/id_rsa",
    });
    expect(resolveFileLink("/home/user/work", folder)).toEqual({
      kind: "outside",
      path: "/home/user/work",
    });
  });
});
