/**
 * What a person reads for a stored chord. The stored form ("Mod+Shift+H") is what the registry keeps, matches,
 * and checks for conflicts; this turns it into the names on the person's own keyboard: Ctrl or Cmd for Mod,
 * Alt or Option, Shift, and arrow glyphs. Only the text shown changes; the stored form does not.
 */

export interface ChordLabelOptions {
  /** True on Apple platforms, where Mod is Cmd and Alt is Option. */
  readonly mac: boolean;
}

const ARROW_GLYPHS: Readonly<Record<string, string>> = {
  arrowup: "↑",
  up: "↑",
  arrowdown: "↓",
  down: "↓",
  arrowleft: "←",
  left: "←",
  arrowright: "→",
  right: "→",
};

const NAMED_KEYS: Readonly<Record<string, string>> = {
  esc: "Esc",
  escape: "Esc",
  enter: "Enter",
  space: "Space",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Delete",
};

/** The name of a modifier on this keyboard, or undefined when the token is not a modifier. */
function modifierLabel(token: string, mac: boolean): string | undefined {
  switch (token) {
    case "mod":
      return mac ? "Cmd" : "Ctrl";
    case "ctrl":
      return "Ctrl";
    case "alt":
      return mac ? "Option" : "Alt";
    case "shift":
      return "Shift";
    case "meta":
      return mac ? "Cmd" : "Meta";
    default:
      return undefined;
  }
}

function keyLabel(key: string): string {
  const lower = key.toLowerCase();
  const named = ARROW_GLYPHS[lower] ?? NAMED_KEYS[lower];
  if (named !== undefined) return named;
  return key.length === 1 ? key.toUpperCase() : key;
}

function stepLabel(step: string, mac: boolean): string {
  return step
    .split("+")
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .map((part) => modifierLabel(part.toLowerCase(), mac) ?? keyLabel(part))
    .join("+");
}

/**
 * The chord as a person reads it on their keyboard: "Mod+Shift+H" is "Cmd+Shift+H" on a Mac and
 * "Ctrl+Shift+H" elsewhere. Steps of a multi-step chord ("Mod+K Mod+C") keep their spaces.
 */
export function chordLabel(chord: string, { mac }: ChordLabelOptions): string {
  return chord
    .trim()
    .split(/\s+/)
    .map((step) => stepLabel(step, mac))
    .join(" ");
}

/** Whether the page runs on an Apple platform (macOS, iPadOS or iOS), from the browser's user agent. */
export function isApplePlatform(userAgent: string = navigator.userAgent): boolean {
  return /Macintosh|iPhone|iPad|iPod/.test(userAgent);
}

/** The stored name of a key the field may show, where the stored name differs: the arrows and a few named keys. */
const STORED_KEYS: Readonly<Record<string, string>> = {
  "↑": "ArrowUp",
  up: "ArrowUp",
  arrowup: "ArrowUp",
  "↓": "ArrowDown",
  down: "ArrowDown",
  arrowdown: "ArrowDown",
  "←": "ArrowLeft",
  left: "ArrowLeft",
  arrowleft: "ArrowLeft",
  "→": "ArrowRight",
  right: "ArrowRight",
  arrowright: "ArrowRight",
  esc: "Esc",
  escape: "Esc",
  space: "Space",
};

/** The stored modifier for a modifier name: Ctrl and Cmd are Mod, Option is Alt. */
function storedModifier(token: string): string | undefined {
  switch (token) {
    case "mod":
    case "ctrl":
    case "cmd":
      return "Mod";
    case "alt":
    case "option":
      return "Alt";
    case "shift":
      return "Shift";
    default:
      return undefined;
  }
}

function storedStep(step: string): string {
  return step
    .split("+")
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .map((part) => {
      const lower = part.toLowerCase();
      const modifier = storedModifier(lower);
      if (modifier !== undefined) return modifier;
      const named = STORED_KEYS[lower];
      if (named !== undefined) return named;
      return part.length === 1 ? part.toUpperCase() : part;
    })
    .join("+");
}

/**
 * The stored form of a chord a person typed. The names the field shows (Ctrl or Cmd, Option, arrow glyphs) and the
 * stored names (Mod, Alt, ArrowUp) both work; the stored form is what the registry keeps and matches.
 */
export function storedChord(typed: string): string {
  return typed.trim().split(/\s+/).map(storedStep).join(" ");
}
