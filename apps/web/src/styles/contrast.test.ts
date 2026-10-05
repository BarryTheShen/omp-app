/// <reference types="node" />
/**
 * The token file is deliberately parsed rather than duplicated here. If a future token change
 * weakens a text/surface pair, this test catches the actual CSS value that ships in both themes
 * (WCAG 2.2 AA: 4.5:1 for text; 3:1 for the input border).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const TOKENS_PATH = join(process.cwd(), "src/styles/tokens.css");
const CSS = readFileSync(TOKENS_PATH, "utf8");

type Oklch = { lightness: number; chroma: number; hue: number; alpha: number };
type Rgb = { red: number; green: number; blue: number; alpha: number };

type TokenMap = Map<string, string>;

function extractBlocks(selector: string): string[] {
  const blocks: string[] = [];
  let cursor = 0;
  while (cursor < CSS.length) {
    const start = CSS.indexOf(selector, cursor);
    if (start < 0) break;
    const open = CSS.indexOf("{", start);
    if (open < 0) break;
    let depth = 0;
    let close = open;
    for (; close < CSS.length; close += 1) {
      if (CSS[close] === "{") depth += 1;
      if (CSS[close] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    blocks.push(CSS.slice(open + 1, close));
    cursor = close + 1;
  }
  return blocks;
}

function declarations(blocks: string[]): TokenMap {
  const values: TokenMap = new Map();
  for (const block of blocks) {
    const declarationPattern = /(--[\w-]+)\s*:\s*([^;]+);/g;
    for (const match of block.matchAll(declarationPattern)) {
      const [, name, value] = match;
      if (name && value) values.set(name, value.trim());
    }
  }
  return values;
}

function themeTokens(theme: "light" | "dark"): TokenMap {
  const root = declarations(extractBlocks(":root"));
  if (theme === "light") return root;
  const dark = declarations(extractBlocks(".dark"));
  for (const [name, value] of dark) root.set(name, value);
  return root;
}

function resolve(name: string, tokens: TokenMap, stack: string[] = []): string {
  if (stack.includes(name))
    throw new Error(`Circular token reference: ${[...stack, name].join(" -> ")}`);
  const value = tokens.get(name);
  if (!value) throw new Error(`Missing token ${name}`);
  const reference = value.match(/^var\((--[\w-]+)\)$/)?.[1];
  return reference ? resolve(reference, tokens, [...stack, name]) : value;
}

function parseOklch(value: string): Oklch {
  const match = value.match(
    /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/,
  );
  if (!match) throw new Error(`Expected an oklch token, got ${value}`);
  const [, lightness, chroma, hue, alpha = "1"] = match;
  return {
    lightness: Number(lightness),
    chroma: Number(chroma),
    hue: Number(hue),
    alpha: alpha.endsWith("%") ? Number.parseFloat(alpha) / 100 : Number(alpha),
  };
}

function oklchToSrgb(color: Oklch): Rgb {
  const hueRadians = (color.hue * Math.PI) / 180;
  const a = color.chroma * Math.cos(hueRadians);
  const b = color.chroma * Math.sin(hueRadians);
  const lightnessCube = (color.lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mCube = (color.lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const sCube = (color.lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linearRed = 4.0767416621 * lightnessCube - 3.3077115913 * mCube + 0.2309699292 * sCube;
  const linearGreen = -1.2684380046 * lightnessCube + 2.6097574011 * mCube - 0.3413193965 * sCube;
  const linearBlue = -0.0041960863 * lightnessCube - 0.7034186147 * mCube + 1.707614701 * sCube;
  const toSrgb = (channel: number) => {
    const clamped = Math.max(0, Math.min(1, channel));
    return clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * clamped ** (1 / 2.4) - 0.055;
  };
  return {
    red: toSrgb(linearRed),
    green: toSrgb(linearGreen),
    blue: toSrgb(linearBlue),
    alpha: color.alpha,
  };
}

function composite(foreground: Rgb, background: Rgb): Rgb {
  if (foreground.alpha >= 1) return foreground;
  const alpha = foreground.alpha;
  return {
    red: foreground.red * alpha + background.red * (1 - alpha),
    green: foreground.green * alpha + background.green * (1 - alpha),
    blue: foreground.blue * alpha + background.blue * (1 - alpha),
    alpha: 1,
  };
}

function luminance(color: Rgb): number {
  const linear = (channel: number) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  return 0.2126 * linear(color.red) + 0.7152 * linear(color.green) + 0.0722 * linear(color.blue);
}

function contrast(foreground: string, background: string, tokens: TokenMap): number {
  const bg = oklchToSrgb(parseOklch(resolve(background, tokens)));
  const fg = composite(oklchToSrgb(parseOklch(resolve(foreground, tokens))), bg);
  const foregroundLum = luminance(fg);
  const backgroundLum = luminance(bg);
  return (
    (Math.max(foregroundLum, backgroundLum) + 0.05) /
    (Math.min(foregroundLum, backgroundLum) + 0.05)
  );
}

const TEXT_PAIRS = [
  ["--foreground", "--background"],
  ["--muted-foreground", "--background"],
  ["--primary-foreground", "--primary"],
  ["--success-surface-foreground", "--success-surface"],
  ["--warning-surface-foreground", "--warning-surface"],
  ["--danger-surface-foreground", "--danger-surface"],
  ["--info-surface-foreground", "--info-surface"],
  ["--diff-add-foreground", "--diff-add-surface"],
  ["--diff-remove-foreground", "--diff-remove-surface"],
] as const;

for (const theme of ["light", "dark"] as const) {
  describe(`${theme} theme contrast`, () => {
    const tokens = themeTokens(theme);
    for (const [foreground, background] of TEXT_PAIRS) {
      test(`${foreground} on ${background} is WCAG AA`, () => {
        expect(
          contrast(foreground, background, tokens),
          `${foreground} on ${background}`,
        ).toBeGreaterThanOrEqual(4.5);
      });
    }

    test("input border has at least 3:1 contrast against the page", () => {
      expect(contrast("--input", "--background", tokens)).toBeGreaterThanOrEqual(3);
    });
  });
}
