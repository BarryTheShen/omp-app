import { describe, expect, test } from "vitest";
import { hostLook, type LookChecks } from "./hostLook";

/** The browser's parser, as far as these tests need it: hex colours and named fonts. */
const checks: LookChecks = {
  color: (value) => /^#[0-9a-f]{3,8}$/i.test(value),
  fontFamily: (value) => /^[\w\s",-]+$/.test(value),
};

const look = (query: string) => hostLook(query, checks);

describe("hostLook", () => {
  test("a host's look sets the theme's tokens, and the shades drawn from each", () => {
    expect(
      look(
        "?theme=dark&bg=%231e1e1e&surface=%232c2c2c&fg=%23dadada&muted=%239aa0a6&border=%23484848&accent=%233575f0&font=Inter,%20sans-serif&fontSize=16",
      ),
    ).toEqual({
      "--page": "#1e1e1e",
      "--panel": "#1e1e1e",
      "--code-bg": "color-mix(in srgb, #1e1e1e 94%, var(--t1))",
      "--card": "#2c2c2c",
      "--pop-bg": "#2c2c2c",
      "--tbl-head": "#2c2c2c",
      "--raise": "color-mix(in srgb, #2c2c2c 90%, var(--t1))",
      "--t1": "#dadada",
      "--ink": "#dadada",
      "--t2": "#9aa0a6",
      "--t3": "#9aa0a6",
      "--t4": "color-mix(in srgb, #9aa0a6 55%, var(--panel))",
      "--l1": "color-mix(in srgb, #484848 55%, transparent)",
      "--l2": "#484848",
      "--l3": "#484848",
      "--l4": "color-mix(in srgb, #484848 70%, var(--t1))",
      "--accent": "#3575f0",
      "--accent-fill": "#3575f0",
      "--accent-ink": "color-mix(in srgb, #3575f0 75%, var(--t1))",
      "--sans": "Inter, sans-serif",
      "--host-text-size": "16px",
    });
  });

  test("no look: the app's own theme stays whole", () => {
    expect(look("")).toEqual({});
    expect(look("?theme=light")).toEqual({});
  });

  test("a value that is not one is ignored on its own, and the rest still apply", () => {
    expect(look("?bg=red%3B%7D&fg=%23dadada")).toEqual({ "--t1": "#dadada", "--ink": "#dadada" });
    expect(look("?font=Inter%3B%20color:red&accent=%233575f0")).toEqual({
      "--accent": "#3575f0",
      "--accent-fill": "#3575f0",
      "--accent-ink": "color-mix(in srgb, #3575f0 75%, var(--t1))",
    });
    expect(look(`?bg=%23${"1".repeat(300)}`)).toEqual({});
  });

  test("a text size counts from 10 to 24 px; anything else is ignored", () => {
    for (const [given, taken] of [
      ["10", "10px"],
      ["24", "24px"],
      ["15.5", "15.5px"],
    ])
      expect(look(`?fontSize=${given}`)).toEqual({ "--host-text-size": taken });
    for (const given of ["9", "25", "40", "16px", "-16", "1e1", "abc"])
      expect(look(`?fontSize=${given}`)).toEqual({});
  });
});
