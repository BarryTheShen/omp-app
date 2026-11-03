import { describe, expect, test } from "bun:test";
import { typeForUntyped, unknownType } from "./sniff";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("the type a browser gives a reply without one (#2788)", () => {
  test("HTML by its first tag: after whitespace, in either case, ended by a space or >", () => {
    expect(unknownType(bytes("\n  <!DOCTYPE html>\n<p>x"))).toBe("text/html");
    expect(unknownType(bytes("<!doctype HTML>"))).toBe("text/html");
    expect(unknownType(bytes("<a href=x>link</a>"))).toBe("text/html");
    expect(unknownType(bytes("<!-- a note -->"))).toBe("text/html");
    // A tag that only starts like one of the list's is no sign of HTML, nor is a tag cut off at the end.
    expect(unknownType(bytes("<abbr>x</abbr>"))).toBe("text/plain");
    expect(unknownType(bytes("<html"))).toBe("text/plain");
  });

  test("XML (its <?xml in lower case only), PDF and images by their signatures", () => {
    expect(unknownType(bytes(' <?xml version="1.0"?><svg/>'))).toBe("text/xml");
    expect(unknownType(bytes("<?XML version"))).toBe("text/plain");
    expect(unknownType(bytes("%PDF-1.7\n"))).toBe("application/pdf");
    expect(
      unknownType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01])),
    ).toBe("image/png");
    expect(unknownType(bytes("GIF89a\u0001\u0000"))).toBe("image/gif");
  });

  test("text without binary bytes is plain text; with them, or a byte order mark aside, a download", () => {
    expect(unknownType(bytes("hello from the service"))).toBe("text/plain");
    expect(unknownType(new Uint8Array(0))).toBe("text/plain");
    expect(unknownType(new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69]))).toBe("text/plain");
    expect(unknownType(new Uint8Array([0x68, 0x00, 0x69]))).toBe("application/octet-stream");
  });

  test("a stylesheet or a script asked for as one gets its own type, whatever it holds", () => {
    expect(typeForUntyped(bytes("body { color: red }"), "style")).toBe("text/css");
    expect(typeForUntyped(bytes("<html>"), "script")).toBe("text/javascript");
    expect(typeForUntyped(bytes("export {}"), "worker")).toBe("text/javascript");
    expect(typeForUntyped(bytes("<html>"), "document")).toBe("text/html");
    expect(typeForUntyped(bytes("<html>"), null)).toBe("text/html");
  });
});
