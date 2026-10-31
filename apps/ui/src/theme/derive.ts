import type { Palette, PaletteColors } from "./palettes";

/** A colour's red, green and blue, 0 to 255. */
export type Rgb = readonly [number, number, number];

export function parseHex(hex: string): Rgb {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex(rgb: Rgb): string {
  return `#${rgb
    .map((channel) =>
      Math.round(Math.min(255, Math.max(0, channel)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

const linear = (channel: number): number => {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

const encoded = (value: number): number =>
  255 * (value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055);

/** WCAG 2 relative luminance and contrast ratio, as `styles/themes.test.ts` computes them. */
export function luminance([r, g, b]: Rgb): number {
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

export function contrast(a: Rgb, b: Rgb): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

/** `top` at `alpha` painted over an opaque `base`. */
export function over(top: Rgb, alpha: number, base: Rgb): Rgb {
  return [
    top[0] * alpha + base[0] * (1 - alpha),
    top[1] * alpha + base[1] * (1 - alpha),
    top[2] * alpha + base[2] * (1 - alpha),
  ];
}

/** OKLab (Björn Ottosson, https://bottosson.github.io/posts/oklab/) from and to sRGB. */
function toOklab([r, g, b]: Rgb): readonly [number, number, number] {
  const [lr, lg, lb] = [linear(r), linear(g), linear(b)];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** Linear sRGB of an OKLab colour; out of 0..1 when the colour is outside sRGB. */
function fromOklab(lightness: number, a: number, b: number): readonly [number, number, number] {
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** The colour at OKLCH (`lightness`, `chroma`, `hue`), its chroma cut back until it fits in sRGB. */
function inGamut(lightness: number, chroma: number, hue: number): Rgb {
  const fits = (c: number) => {
    const rgb = fromOklab(lightness, c * Math.cos(hue), c * Math.sin(hue));
    return rgb.every((channel) => channel >= -1e-6 && channel <= 1 + 1e-6) ? rgb : null;
  };
  let rgb = fits(chroma);
  if (rgb === null) {
    let low = 0;
    let high = chroma;
    for (let step = 0; step < 24; step += 1) {
      const middle = (low + high) / 2;
      if (fits(middle) === null) high = middle;
      else low = middle;
    }
    rgb = fits(low) ?? [lightness, lightness, lightness];
  }
  return rgb.map((channel) => encoded(Math.min(1, Math.max(0, channel)))) as unknown as Rgb;
}

/**
 * `start` if it passes; otherwise the nearest colour of its hue and chroma, lighter or darker, that does (OKLCH
 * lightness in steps of 0.005). White or black when none does.
 */
export function seek(
  start: string,
  passes: (color: Rgb) => boolean,
  direction: "lighter" | "darker",
): string {
  const from = parseHex(start);
  if (passes(from)) return start.toLowerCase();
  const [lightness, a, b] = toOklab(from);
  const chroma = Math.hypot(a, b);
  const hue = Math.atan2(b, a);
  for (let step = 1; step <= 200; step += 1) {
    const next = lightness + (direction === "lighter" ? step : -step) * 0.005;
    if (next < 0 || next > 1) break;
    const hex = toHex(inGamut(next, chroma, hue));
    if (passes(parseHex(hex))) return hex;
  }
  return direction === "lighter" ? "#ffffff" : "#000000";
}

const WHITE: Rgb = [255, 255, 255];
/** A status colour's badge: its text on a 14% tint of itself. */
const TINT = 0.14;

const rgba = ([r, g, b]: Rgb, percent: number): string =>
  `rgb(${Math.round(r)} ${Math.round(g)} ${Math.round(b)} / ${percent}%)`;

/**
 * A palette theme's 33 variables, in the order of the Tern blocks in `styles/themes.css`. Surfaces, the faintest text and
 * the status dots are the palette's; text, focus ring, status text and fills move in lightness where they would miss the
 * checks of `styles/themes.test.ts` (text 4.5:1 on every surface and on row fills, a status's text on its own tint, white
 * on a fill, the focus ring 3:1).
 */
export function themeTokens(palette: Palette): readonly (readonly [string, string])[] {
  const c: PaletteColors = palette.colors;
  const dark = palette.mode === "dark";
  const away = dark ? "lighter" : "darker";
  const surfaces = [c.page, c.panel, c.card, c.raise, c.codeBg, c.tblHead, c.popBg].map(parseHex);
  const readsOnSurfaces = (color: Rgb): boolean =>
    surfaces.every((surface) => contrast(color, surface) >= 4.5);
  const lineAlphas = dark ? [7, 10, 15, 24] : [6, 9, 14, 22];
  const rowSurfaces = [parseHex(c.page), parseHex(c.panel)];
  const readsOnRows = (color: Rgb, lines: Rgb): boolean =>
    lineAlphas
      .slice(0, 2)
      .every((alpha) =>
        rowSurfaces.every((surface) => contrast(color, over(lines, alpha / 100, surface)) >= 4.5),
      );
  const readsOnOwnTint = (color: Rgb): boolean =>
    surfaces.every((surface) => contrast(color, over(color, TINT, surface)) >= 4.5);
  const ink = (start: string): string =>
    seek(start, (color) => readsOnSurfaces(color) && readsOnOwnTint(color), away);
  const fill = (start: string): string =>
    seek(start, (color) => contrast(WHITE, color) >= 4.5, "darker");

  const t1 = seek(c.t1, (color) => readsOnSurfaces(color) && readsOnRows(color, color), away);
  const lines = parseHex(t1);
  const t2 = seek(c.t2, (color) => readsOnSurfaces(color) && readsOnRows(color, lines), away);
  const t3 = seek(c.t3, readsOnSurfaces, away);
  const focusSurfaces = [c.page, c.panel, c.card].map(parseHex);
  const accent = seek(
    c.accent,
    (color) => focusSurfaces.every((surface) => contrast(color, surface) >= 3),
    away,
  );
  return [
    ["--t1", t1],
    ["--t2", t2],
    ["--t3", t3],
    ["--t4", c.t4.toLowerCase()],
    ["--ink", t1],
    ...lineAlphas.map((alpha, index) => [`--l${index + 1}`, rgba(lines, alpha)] as const),
    ["--accent", accent],
    ["--accent-ink", ink(c.accent)],
    ["--accent-fill", fill(c.accent)],
    ["--ok", c.ok.toLowerCase()],
    ["--warn", c.warn.toLowerCase()],
    ["--bad", c.bad.toLowerCase()],
    ["--live", c.live.toLowerCase()],
    ["--ok-ink", ink(c.ok)],
    ["--warn-ink", ink(c.warn)],
    ["--bad-ink", ink(c.bad)],
    ["--ok-fill", fill(c.ok)],
    ["--bad-fill", fill(c.bad)],
    ["--live-fill", fill(c.live)],
    ["--ink-pen", c.inkPen.toLowerCase()],
    ["--ink-pen-fill", fill(c.inkPen)],
    ["--page", c.page.toLowerCase()],
    ["--panel", c.panel.toLowerCase()],
    ["--card", c.card.toLowerCase()],
    ["--raise", c.raise.toLowerCase()],
    ["--code-bg", c.codeBg.toLowerCase()],
    ["--tbl-head", c.tblHead.toLowerCase()],
    ["--chip-bg", rgba(lines, dark ? 7 : 5.5)],
    ["--pop-bg", c.popBg.toLowerCase()],
    ["--dim", dark ? "rgb(0 0 0 / 55%)" : rgba(parseHex(c.page), 50)],
  ];
}

/** Where the palette themes sit in `styles/themes.css`: `bun run themes` rewrites what is between the two lines. */
export const PALETTE_THEMES_START =
  "/* palette themes: start (written by `bun run themes`; do not edit) */";
export const PALETTE_THEMES_END = "/* palette themes: end */";

/** The palette themes' CSS blocks, as they stand between the two lines in `styles/themes.css`. */
export function paletteThemesCss(palettes: readonly Palette[]): string {
  return palettes
    .map((palette) => {
      const body = themeTokens(palette)
        .map(([name, value]) => `  ${name}: ${value};`)
        .join("\n");
      return `/* ${palette.name}: ${palette.source} */\n[data-theme="${palette.id}"] {\n  color-scheme: ${palette.mode};\n\n${body}\n}`;
    })
    .join("\n\n");
}
