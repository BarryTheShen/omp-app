/**
 * The host app's look in the lite view (#2844): the page that frames `/lite` puts its own colours, font and text size
 * in the address, and the lite view takes them once, at load (the host reloads the frame when its theme changes).
 * Each becomes one of the app's theme tokens (`styles/themes.css`) on this page only, with the shades the app draws
 * from it worked out from it. A value that is not one is ignored on its own: the app's theme keeps that part. The full
 * app never reads them.
 */

/** Whether a value is a CSS colour, or a font-family list: the page's own CSS parser decides (`CSS.supports`). */
export interface LookChecks {
  readonly color: (value: string) => boolean;
  readonly fontFamily: (value: string) => boolean;
}

/** The theme tokens to set on the page's root, by name. */
export type HostLook = Readonly<Record<string, string>>;

/** The text sizes taken, in px: a size outside them is ignored. */
export const HOST_TEXT_SIZES = { min: 10, max: 24 } as const;

/** Longer than any colour or font list a host sends: anything longer is ignored unread. */
const MAX_LENGTH = 200;

/** `a` with `share` percent of it, the rest `b`: a shade between two colours, as the browser mixes them. */
const mix = (a: string, share: number, b: string): string =>
  `color-mix(in srgb, ${a} ${share}%, ${b})`;

/**
 * The tokens the address's look sets: `bg` (the page), `surface` (the message box, cards, menus), `fg` (text), `muted`
 * (secondary text, icons), `border` (borders and dividers), `accent` (Send and the other primary buttons, links, the
 * focus ring), `font` (a font-family list) and `fontSize` (the transcript's text, in px). A shade the app draws from a
 * token (a hover fill, a raised chip, faint text) follows the host's value, mixed toward its text colour or its
 * background, so it reads on the host's colours as the app's own shades read on its own.
 */
export function hostLook(search: string, checks: LookChecks): HostLook {
  const params = new URLSearchParams(search);
  const given = (name: string): string | null => {
    const value = params.get(name)?.trim() ?? "";
    return value === "" || value.length > MAX_LENGTH ? null : value;
  };
  const color = (name: string): string | null => {
    const value = given(name);
    return value !== null && checks.color(value) ? value : null;
  };
  const tokens: Record<string, string> = {};
  const bg = color("bg");
  if (bg !== null) {
    tokens["--page"] = bg;
    tokens["--panel"] = bg;
    tokens["--code-bg"] = mix(bg, 94, "var(--t1)");
  }
  const surface = color("surface");
  if (surface !== null) {
    tokens["--card"] = surface;
    tokens["--pop-bg"] = surface;
    tokens["--tbl-head"] = surface;
    // Your message's bubble and the box's chips: a step off the surface they sit on.
    tokens["--raise"] = mix(surface, 90, "var(--t1)");
  }
  const fg = color("fg");
  if (fg !== null) {
    tokens["--t1"] = fg;
    tokens["--ink"] = fg;
  }
  const muted = color("muted");
  if (muted !== null) {
    tokens["--t2"] = muted;
    tokens["--t3"] = muted;
    tokens["--t4"] = mix(muted, 55, "var(--panel)");
  }
  const border = color("border");
  if (border !== null) {
    // The hover fill is the border's colour, half seen; the strongest line a step toward the text.
    tokens["--l1"] = mix(border, 55, "transparent");
    tokens["--l2"] = border;
    tokens["--l3"] = border;
    tokens["--l4"] = mix(border, 70, "var(--t1)");
  }
  const accent = color("accent");
  if (accent !== null) {
    tokens["--accent"] = accent;
    tokens["--accent-fill"] = accent;
    // Links and the focus ring are accent drawn on the page: a step toward the text keeps them readable.
    tokens["--accent-ink"] = mix(accent, 75, "var(--t1)");
  }
  const font = given("font");
  if (font !== null && !/[;{}]/.test(font) && checks.fontFamily(font)) tokens["--sans"] = font;
  const size = given("fontSize");
  if (size !== null && /^\d+(\.\d+)?$/.test(size)) {
    const px = Number(size);
    if (px >= HOST_TEXT_SIZES.min && px <= HOST_TEXT_SIZES.max)
      tokens["--host-text-size"] = `${px}px`;
  }
  return tokens;
}

/** The page's own checks. */
export const BROWSER_CHECKS: LookChecks = {
  color: (value) => CSS.supports("color", value),
  fontFamily: (value) => CSS.supports("font-family", value),
};

/** Sets the look's tokens on the page's root, where they outrank the theme's (`[data-theme]`). */
export function applyHostLook(look: HostLook, root: HTMLElement = document.documentElement): void {
  for (const [name, value] of Object.entries(look)) root.style.setProperty(name, value);
}
