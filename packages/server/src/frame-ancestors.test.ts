import { describe, expect, test } from "bun:test";
import { parseFrameAncestors } from "./frame-ancestors";

describe("parseFrameAncestors", () => {
  test("lets no page frame the app when the variable is unset or blank", () => {
    expect(parseFrameAncestors(undefined)).toEqual([]);
    expect(parseFrameAncestors("  ")).toEqual([]);
  });

  test("takes Tailscale addresses over HTTPS, with a port, and loopback addresses with theirs, each once", () => {
    expect(
      parseFrameAncestors(
        " https://notes.tail1234.ts.net:8443  https://NOTES.tail1234.ts.net:8443/ http://127.0.0.1:9000 http://localhost:9001 https://box.tail1234.ts.net:443",
      ),
    ).toEqual([
      "https://notes.tail1234.ts.net:8443",
      "http://127.0.0.1:9000",
      "http://localhost:9001",
      "https://box.tail1234.ts.net",
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

  test("refuses any page that is not one of this computer's or the tailnet's, and anything after an address", () => {
    for (const value of [
      "*",
      "'self'",
      "https://notes.example.com",
      "http://notes.tail1234.ts.net:8443",
      "https://ts.net",
      "http://127.0.0.1",
      "http://10.0.0.4:9000",
      "https://notes.tail1234.ts.net:8443/app",
      "https://notes.tail1234.ts.net:8443/?x=1",
      "https://user@notes.tail1234.ts.net",
      "notes.tail1234.ts.net",
      "moz-extension://not-a-uuid",
      "chrome-extension://short",
      "moz-extension://0123abcd-0000-4111-8222-0123456789ab/panel.html",
      "https:",
      "file:",
      "https://notes.tail1234.ts.net:8443 https://evil.example.com",
    ]) {
      expect(() => parseFrameAncestors(value)).toThrow("OMP_APP_FRAME_ANCESTORS takes");
    }
  });
});
