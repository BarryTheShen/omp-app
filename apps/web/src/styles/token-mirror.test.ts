/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { colorTokens, fontTokens, radiusTokens, shadowTokens, typeScaleTokens } from "../tokens";

const CSS = readFileSync(join(process.cwd(), "src/styles/tokens.css"), "utf8");
type TokenMap = Map<string, string>;

function block(selector: string, source = CSS): string {
  const start =
    selector === ":root" ? source.lastIndexOf(`${selector} {`) : source.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`Missing ${selector} token block`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  throw new Error(`Unclosed ${selector} token block`);
}

function declarations(source: string): TokenMap {
  const values = new Map<string, string>();
  for (const match of source.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    const [, name, value] = match;
    if (name && value) values.set(name, value.trim());
  }
  return values;
}

function resolve(name: string, tokens: TokenMap, stack: string[] = []): string {
  if (stack.includes(name))
    throw new Error(`Circular token reference: ${[...stack, name].join(" -> ")}`);
  const value = tokens.get(name);
  if (!value) throw new Error(`Missing token ${name}`);
  const reference = /^var\((--[\w-]+)\)$/.exec(value)?.[1];
  return reference ? resolve(reference, tokens, [...stack, name]) : value;
}

const light = declarations(block(":root"));
const darkOverrides = declarations(block(".dark"));
const dark = new Map([...light, ...darkOverrides]);
const themes = { light, dark } as const;

function cssTypeScale(): TokenMap {
  const values = new Map<string, string>();
  for (const match of CSS.matchAll(/(--text-[\w-]+(?:--line-height)?)\s*:\s*([^;]+);/g)) {
    const [, name, value] = match;
    if (name && value) values.set(name, value.trim());
  }
  return values;
}

const typeScale = cssTypeScale();

const fontTheme = declarations(block("@theme"));
const inlineTheme = declarations(block("@theme inline"));

const COLOR_PROPERTIES = {
  background: "--background",
  foreground: "--foreground",
  card: "--card",
  cardForeground: "--card-foreground",
  popover: "--popover",
  popoverForeground: "--popover-foreground",
  primary: "--primary",
  primaryForeground: "--primary-foreground",
  secondary: "--secondary",
  secondaryForeground: "--secondary-foreground",
  muted: "--muted",
  mutedForeground: "--muted-foreground",
  accent: "--accent",
  accentForeground: "--accent-foreground",
  border: "--border",
  input: "--input",
  ring: "--ring",
  info: "--info",
  success: "--success",
  warning: "--warning",
  danger: "--danger",
  successSurface: "--success-surface",
  successSurfaceForeground: "--success-surface-foreground",
  warningSurface: "--warning-surface",
  warningSurfaceForeground: "--warning-surface-foreground",
  dangerSurface: "--danger-surface",
  dangerSurfaceForeground: "--danger-surface-foreground",
  infoSurface: "--info-surface",
  infoSurfaceForeground: "--info-surface-foreground",
  diffAdd: "--diff-add",
  diffAddSurface: "--diff-add-surface",
  diffAddForeground: "--diff-add-foreground",
  diffRemove: "--diff-remove",
  diffRemoveSurface: "--diff-remove-surface",
  diffRemoveForeground: "--diff-remove-foreground",
} as const satisfies Record<keyof typeof colorTokens, string>;

describe("typed design-token mirror", () => {
  test("every color token references an oklch property declared in both themes", () => {
    expect(CSS).not.toMatch(/color-mix\(/);
    expect(CSS).not.toMatch(/oklch\([^)]*var\(/);
    for (const [name, value] of Object.entries(colorTokens)) {
      const property = /^var\((--[\w-]+)\)$/.exec(value)?.[1];
      expect(property, `${name} should reference one CSS custom property`).toBeDefined();
      for (const [theme, tokens] of Object.entries(themes)) {
        expect(tokens.has(property ?? ""), `${name} is missing from ${theme} tokens`).toBe(true);
        expect(resolve(property ?? "", tokens), `${name} needs an oklch source`).toMatch(
          /^oklch\([^()]+\)$/,
        );
      }
    }
  });
  test("names each semantic token property in the typed mirror", () => {
    for (const [name, property] of Object.entries(COLOR_PROPERTIES)) {
      expect(colorTokens[name as keyof typeof colorTokens], `${name} property`).toBe(
        `var(${property})`,
      );
    }
  });
  test("every font token references an @theme declaration", () => {
    for (const [name, value] of Object.entries(fontTokens)) {
      const property = /^var\((--[\w-]+)\)$/.exec(value)?.[1];
      expect(property, `${name} should reference one CSS custom property`).toBeDefined();
      expect(fontTheme.has(property ?? ""), `${name} is missing from @theme`).toBe(true);
    }
  });

  test("every radius and shadow token references an @theme inline declaration", () => {
    for (const [group, tokens] of Object.entries({ radiusTokens, shadowTokens })) {
      for (const [name, value] of Object.entries(tokens)) {
        const property = /^var\((--[\w-]+)\)$/.exec(value)?.[1];
        expect(property, `${group}.${name} should reference one CSS custom property`).toBeDefined();
        expect(
          inlineTheme.has(property ?? ""),
          `${group}.${name} is missing from @theme inline`,
        ).toBe(true);
      }
    }
  });

  test("every type scale entry matches the CSS size and line height", () => {
    for (const [name, scale] of Object.entries(typeScaleTokens)) {
      expect(typeScale.get(`--text-${name}`), `${name} size`).toBe(scale.fontSize);
      expect(typeScale.get(`--text-${name}--line-height`), `${name} line height`).toBe(
        scale.lineHeight,
      );
    }
  });
});
