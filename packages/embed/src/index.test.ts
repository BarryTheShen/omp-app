import { describe, expect, test } from "bun:test";
import { opensOutside } from "./index";

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
