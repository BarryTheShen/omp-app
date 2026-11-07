import { describe, expect, test } from "vitest";
import { signInHref } from "./signInHref";

describe("signInHref", () => {
  test("opens a web page's address", () => {
    expect(signInHref("https://auth.example.com/authorize?state=1")).toBe(
      "https://auth.example.com/authorize?state=1",
    );
    expect(signInHref("http://127.0.0.1:8123/callback")).toBe("http://127.0.0.1:8123/callback");
  });

  test("opens nothing else: script, data, file, credentials in the address, or no address", () => {
    for (const url of [
      "javascript:alert(document.cookie)",
      " JavaScript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "file:///etc/passwd",
      "https://user:secret@auth.example.com/",
      "not an address",
    ]) {
      expect(signInHref(url)).toBeNull();
    }
  });
});
