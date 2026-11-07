import { describe, expect, test } from "vitest";
import { liteChoices } from "./lite";

describe("liteChoices", () => {
  test("the framing app's greeting, suggestions and placeholder, as the issue gives them", () => {
    expect(
      liteChoices(
        "?greeting=How%20can%20I%20help%3F&suggest=Summarize%20this%20page|Find%20related%20notes&placeholder=Ask%20your%20notes",
      ),
    ).toEqual({
      greeting: "How can I help?",
      suggestions: ["Summarize this page", "Find related notes"],
      placeholder: "Ask your notes",
    });
  });

  test("none given: the app's own greeting and placeholder, and no suggestions", () => {
    expect(liteChoices("")).toEqual({ greeting: null, suggestions: [], placeholder: null });
    expect(liteChoices("?greeting=%20%20&placeholder=&suggest=||")).toEqual({
      greeting: null,
      suggestions: [],
      placeholder: null,
    });
  });

  test("a text is trimmed, and one longer than its limit is ignored", () => {
    expect(liteChoices(`?greeting=${"g".repeat(120)}`).greeting).toBe("g".repeat(120));
    expect(liteChoices(`?greeting=${"g".repeat(121)}`).greeting).toBeNull();
    expect(liteChoices(`?placeholder=${"p".repeat(80)}`).placeholder).toBe("p".repeat(80));
    expect(liteChoices(`?placeholder=${"p".repeat(81)}`).placeholder).toBeNull();
    expect(liteChoices("?placeholder=%20Ask%20your%20notes%20").placeholder).toBe("Ask your notes");
  });

  test("at most the first five different suggestions of up to 60 characters", () => {
    const long = "s".repeat(61);
    expect(
      liteChoices(`?suggest=${["a", " b ", "a", long, "c", "d", "e", "f"].join("|")}`).suggestions,
    ).toEqual(["a", "b", "c", "d", "e"]);
    expect(liteChoices(`?suggest=${"s".repeat(60)}`).suggestions).toEqual(["s".repeat(60)]);
  });
});
