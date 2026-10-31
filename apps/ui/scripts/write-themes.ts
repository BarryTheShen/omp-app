/**
 * Writes the palette themes (`src/theme/palettes.ts`, shades from `src/theme/derive.ts`) into `src/styles/themes.css`,
 * between its two palette-theme lines: `bun run themes`. `src/theme/derive.test.ts` fails while the file and the
 * palettes disagree.
 */
import { readFile, writeFile } from "node:fs/promises";
import { PALETTE_THEMES_END, PALETTE_THEMES_START, paletteThemesCss } from "../src/theme/derive";
import { PALETTES } from "../src/theme/palettes";

const file = new URL("../src/styles/themes.css", import.meta.url);
const css = await readFile(file, "utf8");
const section = `${PALETTE_THEMES_START}\n\n${paletteThemesCss(PALETTES)}\n\n${PALETTE_THEMES_END}`;
const start = css.indexOf(PALETTE_THEMES_START);
const end = css.indexOf(PALETTE_THEMES_END);
const next =
  start === -1
    ? `${css.trimEnd()}\n\n${section}\n`
    : `${css.slice(0, start)}${section}${css.slice(end + PALETTE_THEMES_END.length)}`;
await writeFile(file, next);
console.log(`themes.css: ${PALETTES.length} palette themes written`);
