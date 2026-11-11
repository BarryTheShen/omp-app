import { describe, expect, test } from "bun:test";
import { EMBED_COPY_MAX } from "@omp-app/contracts";
import { COPY_MAX, copyAllowed, opensOutside } from "./index";

describe("what a host copies when the panel asks", () => {
  test("text only, no longer than a copy may be, and only while the person's click or key in the panel counts", () => {
    // The protocol's limit, which the library keeps a copy of.
    expect(COPY_MAX).toBe(EMBED_COPY_MAX);
    const acted = { isActive: true };
    expect(copyAllowed("const x = 1;", acted)).toBe(true);
    // The panel asking with no click or key behind it (a page filling the clipboard unasked).
    expect(copyAllowed("const x = 1;", { isActive: false })).toBe(false);
    expect(copyAllowed("x".repeat(COPY_MAX), acted)).toBe(true);
    expect(copyAllowed("x".repeat(COPY_MAX + 1), acted)).toBe(false);
    for (const other of [42, null, undefined, { text: "x" }])
      expect(copyAllowed(other, acted)).toBe(false);
    // A browser that does not say whether the person acted lets it, as its own clipboard does.
    expect(copyAllowed("const x = 1;", null)).toBe(true);
  });
});

describe("what a host opens when the panel asks", () => {
  test("the app's own pages and the desktop app's link, and nothing else", () => {
    const app = "https://omp.example.com";
    expect(opensOutside("https://omp.example.com/?chat=01a1", app)).toBe(true);
    expect(opensOutside("omp-app://chat/01a1?server=https%3A%2F%2Fomp.example.com", app)).toBe(
      true,
    );
    expect(opensOutside("omp-app://open?server=https%3A%2F%2Fomp.example.com", app)).toBe(true);
    for (const other of [
      "https://other.example/?chat=01a1",
      "http://omp.example.com/",
      "https://omp.example.com.evil.example/",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "vscode://settings",
      "not an address",
      42,
      null,
    ]) {
      expect(opensOutside(other, app)).toBe(false);
    }
  });
});
