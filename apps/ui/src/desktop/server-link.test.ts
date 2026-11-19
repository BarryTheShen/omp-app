import { describe, expect, test } from "vitest";
import { serverLink } from "./server-link";

describe("Add a server's link", () => {
  test("an address without a scheme is https, at the app's root", () => {
    expect(serverLink(" lab.tail1234.ts.net ", "")).toBe("https://lab.tail1234.ts.net/");
    expect(serverLink("lab.tail1234.ts.net:8445", "")).toBe("https://lab.tail1234.ts.net:8445/");
  });

  test("a one-time code rides in the fragment the pairing screen reads, cleaned of spaces", () => {
    expect(serverLink("https://lab.tail1234.ts.net", " k7f3 qx9m ")).toBe(
      "https://lab.tail1234.ts.net/#pair=K7F3QX9M",
    );
    expect(serverLink("https://lab.tail1234.ts.net/?x=1#token=old", "AB12-CD34")).toBe(
      "https://lab.tail1234.ts.net/#pair=AB12-CD34",
    );
  });

  test("what is not an address gives nothing; plain http is left for the window to refuse with its reason", () => {
    expect(serverLink("", "AB12")).toBeNull();
    expect(serverLink("   ", "")).toBeNull();
    expect(serverLink("http://lab.tail1234.ts.net", "")).toBe("http://lab.tail1234.ts.net/");
  });
});
