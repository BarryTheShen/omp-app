import type { ThreadId } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import {
  desktopAppLink,
  fullAppPlace,
  keepFullAppPlace,
  liteChat,
  liteChoices,
  liteHost,
} from "./lite";

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

describe("liteHost", () => {
  test("the framing app's name, when it is one", () => {
    expect(liteHost("?theme=dark&host=siyuan")).toBe("siyuan");
    expect(liteHost("?host=my-notes2")).toBe("my-notes2");
    expect(liteHost("?host=a".concat("b".repeat(31)))).toBe(`a${"b".repeat(31)}`);
  });

  test("none, or one that is not an app's name: none", () => {
    expect(liteHost("")).toBeNull();
    expect(liteHost("?host=")).toBeNull();
    expect(liteHost("?host=SiYuan")).toBeNull();
    expect(liteHost("?host=2notes")).toBeNull();
    expect(liteHost("?host=my%20notes")).toBeNull();
    expect(liteHost(`?host=a${"b".repeat(32)}`)).toBeNull();
  });
});

describe("liteChat", () => {
  test("the chat a host gives back opens first; none, or a value that is no chat's id, opens a new chat", () => {
    expect(liteChat("?embed=1&chat=01a18633-f642-75c0-b0bd-ad38cbbf851a")).toBe(
      "01a18633-f642-75c0-b0bd-ad38cbbf851a",
    );
    expect(liteChat("")).toBeNull();
    expect(liteChat("?chat=")).toBeNull();
    expect(liteChat("?chat=../etc")).toBeNull();
    expect(liteChat("?chat=a%20b")).toBeNull();
    expect(liteChat(`?chat=${"a".repeat(129)}`)).toBeNull();
  });
});

describe("the full app from the lite view", () => {
  test("the desktop app's link names the chat and the server; a chat with no id yet, the server alone", () => {
    const chat = "01a18633-f642-75c0-b0bd-ad38cbbf851a" as ThreadId;
    expect(desktopAppLink(chat, "https://devbox.tail1234.ts.net")).toBe(
      "omp-app://chat/01a18633-f642-75c0-b0bd-ad38cbbf851a?server=https%3A%2F%2Fdevbox.tail1234.ts.net",
    );
    expect(desktopAppLink(null, "http://127.0.0.1:4317")).toBe(
      "omp-app://open?server=http%3A%2F%2F127.0.0.1%3A4317",
    );
  });

  test("a browser tab until the panel chooses the desktop app, which it keeps; a storage that refuses keeps nothing", () => {
    const kept = new Map<string, string>();
    const storage = {
      getItem: (key: string) => kept.get(key) ?? null,
      setItem: (key: string, value: string) => void kept.set(key, value),
    };
    expect(fullAppPlace(storage)).toBe("browser");
    keepFullAppPlace(storage, "desktop");
    expect(fullAppPlace(storage)).toBe("desktop");
    keepFullAppPlace(storage, "browser");
    expect(fullAppPlace(storage)).toBe("browser");
    const refusing = {
      getItem: (): string | null => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(fullAppPlace(refusing)).toBe("browser");
    expect(fullAppPlace(null)).toBe("browser");
  });
});
