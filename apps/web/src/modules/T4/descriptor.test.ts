import { describe, expect, test } from "vitest";
import { T4_TOOL_DESCRIPTORS } from "./descriptor";

describe("T4 tool descriptors", () => {
  test("registers exactly browser, GitHub and web search without a competing read descriptor", () => {
    expect(T4_TOOL_DESCRIPTORS.map((descriptor) => descriptor.match)).toEqual([
      { by: "name", name: "browser" },
      { by: "name", name: "github" },
      { by: "name", name: "web_search" },
    ]);
    expect(T4_TOOL_DESCRIPTORS.map((descriptor) => descriptor.covers)).toEqual([
      ["T4.browser"],
      ["T4.github"],
      ["T4.web-search"],
    ]);
    expect(T4_TOOL_DESCRIPTORS.map((descriptor) => descriptor.id)).not.toContain("T1.read");
    expect(T4_TOOL_DESCRIPTORS.flatMap((descriptor) => descriptor.covers)).not.toContain(
      "T4.fetch-read-url-path",
    );
  });

  test("keeps the URL renderer as a structural seam rather than a second descriptor", () => {
    expect(T4_TOOL_DESCRIPTORS.every((descriptor) => descriptor.renderer !== undefined)).toBe(true);
  });
});
