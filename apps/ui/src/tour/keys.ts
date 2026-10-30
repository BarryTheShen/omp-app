const MODIFIERS = ["ctrl", "meta", "alt", "shift"] as const;
type Modifier = (typeof MODIFIERS)[number];

/** The `event.code` of each key name the key table writes that is not a single letter or digit. */
const CODES: Readonly<Record<string, string>> = {
  enter: "Enter",
  escape: "Escape",
  tab: "Tab",
  slash: "Slash",
  comma: "Comma",
  period: "Period",
  equal: "Equal",
  bracketleft: "BracketLeft",
  bracketright: "BracketRight",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  f8: "F8",
};

const isModifier = (part: string): part is Modifier =>
  (MODIFIERS as readonly string[]).includes(part);

/** The `event.code` a key name stands for: `o` is `KeyO`, `1` is `Digit1`, `enter` is `Enter`; null if unknown. */
function codeOf(name: string): string | null {
  const named = CODES[name];
  if (named !== undefined) return named;
  if (/^[a-z]$/.test(name)) return `Key${name.toUpperCase()}`;
  if (/^[0-9]$/.test(name)) return `Digit${name}`;
  return null;
}

function matchesChord(event: KeyboardEvent, chord: string): boolean {
  const parts = chord.trim().toLowerCase().split("+");
  const modifiers = parts.filter(isModifier);
  const keys = parts.filter((part) => !isModifier(part));
  const [name] = keys;
  if (keys.length !== 1 || name === undefined) return false;
  if (codeOf(name) !== event.code) return false;
  const held: Readonly<Record<Modifier, boolean>> = {
    ctrl: event.ctrlKey,
    meta: event.metaKey,
    alt: event.altKey,
    shift: event.shiftKey,
  };
  // Exactly the listed modifiers: one more held, or one fewer, is another key.
  return MODIFIERS.every((modifier) => held[modifier] === modifiers.includes(modifier));
}

/**
 * Whether a key event is one of a binding's keys. `hotkey` is a `KEYS[...].hotkey` string: alternatives separated by
 * `, `, each its modifiers and one key name joined with `+`. The key is read by `event.code`, so it does not depend on
 * the keyboard layout or on what Shift makes of it, and the modifiers must be exactly those listed.
 */
export function matchesHotkey(event: KeyboardEvent, hotkey: string): boolean {
  return hotkey.split(",").some((chord) => matchesChord(event, chord));
}
