import { describe, expect, test } from "vitest";
import { checkShareLink } from "./link";

describe("checkShareLink", () => {
  test("accepts one https link and reports the host it points at", () => {
    expect(checkShareLink("https://my.omp.sh/s/abc1234567#key")).toEqual({
      ok: true,
      link: "https://my.omp.sh/s/abc1234567#key",
      host: "my.omp.sh",
    });
  });

  test("trims the spaces around the link before checking it", () => {
    expect(checkShareLink("  https://my.omp.sh/s/abc1234567  ")).toMatchObject({
      ok: true,
      link: "https://my.omp.sh/s/abc1234567",
    });
  });

  test("refuses an empty or blank link as empty", () => {
    expect(checkShareLink("")).toEqual({ ok: false, why: "empty-link" });
    expect(checkShareLink("   ")).toEqual({ ok: false, why: "empty-link" });
  });

  test("refuses a link with a space or a line break inside it", () => {
    expect(checkShareLink("https://my.omp.sh/s/abc 1234567")).toEqual({
      ok: false,
      why: "bad-link",
    });
    expect(checkShareLink("https://my.omp.sh/s/abc\n1234567")).toEqual({
      ok: false,
      why: "bad-link",
    });
  });

  test("refuses plain http, other schemes and text that is not a link", () => {
    for (const value of [
      "http://my.omp.sh/s/abc",
      "file:///home/a.jsonl",
      "my.omp.sh/s/abc",
      "https://",
    ]) {
      expect(checkShareLink(value)).toEqual({ ok: false, why: "bad-link" });
    }
  });

  test("refuses a link longer than the 2048 characters a share link can have", () => {
    const long = `https://my.omp.sh/s/${"a".repeat(2_040)}`;
    expect(checkShareLink(long)).toEqual({ ok: false, why: "bad-link" });
  });
});
