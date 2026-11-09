import { describe, expect, test } from "bun:test";
import { parseFrameAncestors } from "./frame-ancestors";

describe("parseFrameAncestors", () => {
  test("lets no page frame the app when the variable is unset or blank", () => {
    expect(parseFrameAncestors(undefined)).toEqual([]);
    expect(parseFrameAncestors("  ")).toEqual([]);
  });

  test("takes HTTPS addresses, with a port, and loopback addresses with theirs, each once", () => {
    expect(
      parseFrameAncestors(
        " https://notes.example.com:8443  https://NOTES.example.com:8443/ http://127.0.0.1:9000 http://localhost:9001 https://box.tail1234.ts.net:443 https://10.1.2.3",
      ),
    ).toEqual([
      "https://notes.example.com:8443",
      "http://127.0.0.1:9000",
      "http://localhost:9001",
      "https://box.tail1234.ts.net",
      "https://10.1.2.3",
    ]);
  });

  test("takes browser-extension and editor panels: a kind, or one extension by its own address", () => {
    expect(
      parseFrameAncestors(
        "moz-extension: chrome-extension: vscode-webview: vscode-file: moz-extension://0123abcd-0000-4111-8222-0123456789ab chrome-extension://abcdefghijklmnopabcdefghijklmnop",
      ),
    ).toEqual([
      "moz-extension:",
      "chrome-extension:",
      "vscode-webview:",
      "vscode-file:",
      "moz-extension://0123abcd-0000-4111-8222-0123456789ab",
      "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
    ]);
  });

  test("refuses plain HTTP from another computer, wildcard hosts, anything after an address, and anything else", () => {
    for (const value of [
      "*",
      "'self'",
      "https://*",
      "https://*.example.com",
      "https://%2A.example.com",
      "http://notes.example.com",
      "http://notes.example.com:8443",
      "http://10.0.0.4:9000",
      "http://127.0.0.1",
      "https://notes.example.com:8443/app",
      "https://notes.example.com:8443/?x=1",
      "https://user@notes.example.com",
      "notes.example.com",
      "moz-extension://not-a-uuid",
      "chrome-extension://short",
      "moz-extension://0123abcd-0000-4111-8222-0123456789ab/panel.html",
      "https:",
      "file:",
      "https://notes.example.com:8443 http://evil.example.com",
    ]) {
      expect(() => parseFrameAncestors(value)).toThrow("OMP_APP_FRAME_ANCESTORS takes");
    }
  });
});
