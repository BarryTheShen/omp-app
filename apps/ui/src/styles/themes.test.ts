import { describe, expect, test } from "vitest";
import { PALETTES } from "../theme/palettes";
import css from "./themes.css?raw";

type Rgba = readonly [number, number, number, number];

/** The `--name: value` declarations of a theme's block in themes.css. */
function themeTokens(theme: string): ReadonlyMap<string, string> {
  const block = new RegExp(`\\[data-theme="${theme}"\\]\\s*\\{([^}]*)\\}`).exec(css)?.[1];
  if (block === undefined) throw new Error(`themes.css has no block for ${theme}`);
  return new Map(
    [...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((match) => [
      match[1] ?? "",
      (match[2] ?? "").trim(),
    ]),
  );
}

function parseColor(value: string): Rgba {
  const hex = /^#([0-9a-f]{6})$/i.exec(value)?.[1];
  if (hex !== undefined) {
    const n = Number.parseInt(hex, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const rgb = /^rgb\((\d+) (\d+) (\d+)(?: \/ ([\d.]+)%)?\)$/.exec(value);
  if (rgb !== null) {
    return [
      Number(rgb[1]),
      Number(rgb[2]),
      Number(rgb[3]),
      rgb[4] === undefined ? 1 : Number(rgb[4]) / 100,
    ];
  }
  throw new Error(`not a colour this test reads: ${value}`);
}

/** A translucent colour painted over an opaque one. */
function over(top: Rgba, base: Rgba): Rgba {
  const a = top[3];
  return [
    top[0] * a + base[0] * (1 - a),
    top[1] * a + base[1] * (1 - a),
    top[2] * a + base[2] * (1 - a),
    1,
  ];
}

/** WCAG 2 relative luminance and contrast ratio. */
function luminance([r, g, b]: Rgba): number {
  const channel = (value: number): number => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: Rgba, b: Rgba): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

/** Text tokens and the surfaces text sits on; rows paint the hover and selection fills over the page or a panel. */
const TEXT = ["--t1", "--t2", "--t3", "--accent-ink", "--ok-ink", "--warn-ink", "--bad-ink"];
const SURFACES = ["--page", "--panel", "--card", "--raise", "--code-bg", "--tbl-head", "--pop-bg"];
const ROW_FILLS = ["--l1", "--l2"];
const ROW_TEXT = ["--t1", "--t2"];
const FILLS_UNDER_WHITE = ["--accent-fill", "--ok-fill", "--bad-fill", "--live-fill"];
/** Badges and chips: a colour's text on a 14% tint of itself. */
const TINTED = ["--accent-ink", "--ok-ink", "--warn-ink", "--bad-ink"];
const TINT = 0.14;
const WHITE: Rgba = [255, 255, 255, 1];
/**
 * Code's colours, and the surfaces code is shown on: the page, a panel, a card (inline code) and a code block, and the
 * Files editor's current line (`--l1` over a panel).
 */
const CODE = [
  "--syn-keyword",
  "--syn-string",
  "--syn-number",
  "--syn-comment",
  "--syn-function",
  "--syn-type",
  "--syn-property",
  "--syn-variable",
  "--syn-operator",
];
const CODE_SURFACES = ["--page", "--panel", "--card", "--code-bg"];

describe.each(["tern-dark", "tern-light", ...PALETTES.map((palette) => palette.id)])(
  "%s",
  (theme) => {
    const tokens = themeTokens(theme);
    const color = (name: string): Rgba => {
      const value = tokens.get(name);
      if (value === undefined) throw new Error(`${theme} does not set ${name}`);
      return parseColor(value);
    };

    test.each(TEXT.flatMap((text) => SURFACES.map((surface) => [text, surface] as const)))(
      "%s on %s reads at 4.5:1 or more",
      (text, surface) => {
        expect(contrast(color(text), color(surface))).toBeGreaterThanOrEqual(4.5);
      },
    );

    test.each(CODE.flatMap((code) => CODE_SURFACES.map((surface) => [code, surface] as const)))(
      "%s on %s reads at 4.5:1 or more",
      (code, surface) => {
        expect(contrast(color(code), color(surface))).toBeGreaterThanOrEqual(4.5);
      },
    );

    test.each(CODE)(
      "%s on the editor's current line (--l1 over --panel) reads at 4.5:1 or more",
      (code) => {
        expect(contrast(color(code), over(color("--l1"), color("--panel")))).toBeGreaterThanOrEqual(
          4.5,
        );
      },
    );

    test.each(
      ROW_TEXT.flatMap((text) =>
        ROW_FILLS.flatMap((fill) =>
          ["--page", "--panel"].map((surface) => [text, fill, surface] as const),
        ),
      ),
    )("%s on %s over %s reads at 4.5:1 or more", (text, fill, surface) => {
      expect(contrast(color(text), over(color(fill), color(surface)))).toBeGreaterThanOrEqual(4.5);
    });

    test.each(FILLS_UNDER_WHITE)("white text on %s reads at 4.5:1 or more", (fill) => {
      expect(contrast(WHITE, color(fill))).toBeGreaterThanOrEqual(4.5);
    });

    test.each(TINTED.flatMap((ink) => SURFACES.map((surface) => [ink, surface] as const)))(
      "%s on its own tint over %s reads at 4.5:1 or more",
      (ink, surface) => {
        const [r, g, b] = color(ink);
        const tint = over([r, g, b, TINT], color(surface));
        expect(contrast(color(ink), tint)).toBeGreaterThanOrEqual(4.5);
      },
    );

    test("the focus ring stands out from the page and panels at 3:1 or more", () => {
      for (const surface of ["--page", "--panel", "--card"]) {
        expect(contrast(color("--accent"), color(surface))).toBeGreaterThanOrEqual(3);
      }
    });
  },
);
