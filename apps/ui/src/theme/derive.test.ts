import { expect, test } from "vitest";
import css from "../styles/themes.css?raw";
import { PALETTE_THEMES_END, PALETTE_THEMES_START, paletteThemesCss } from "./derive";
import { PALETTES } from "./palettes";

test("themes.css holds the palette themes as the palettes give them now (else: bun run themes)", () => {
  const start = css.indexOf(PALETTE_THEMES_START);
  const end = css.indexOf(PALETTE_THEMES_END);
  expect(start).toBeGreaterThan(-1);
  expect(css.slice(start + PALETTE_THEMES_START.length, end).trim()).toBe(
    paletteThemesCss(PALETTES),
  );
});

test("every palette theme has an id of its own", () => {
  const ids = PALETTES.map((palette) => palette.id);
  expect(new Set(ids).size).toBe(ids.length);
});
