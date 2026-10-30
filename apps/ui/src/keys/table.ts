/**
 * Every key of the app, in one table: the workspace's (kitty's), a pane's and the message box's (Tern's). The shortcuts
 * sheet and the palette show them from here, the workspace binds its keys from here, and a unit test checks that no two
 * bindings that can act at once share a key.
 */

/** Where a key acts: anywhere in the app, in the focused pane, or in its message box. */
export type KeyScope = "workspace" | "pane" | "box";

export interface KeyBinding {
  readonly id: string;
  /** As react-hotkeys-hook reads it, by key code: modifiers first, `,` between alternatives. */
  readonly hotkey: string;
  readonly scope: KeyScope;
  readonly group: "Panes" | "Tabs" | "Message box" | "Transcript" | "App";
  readonly label: string;
}

export const KEYS = {
  splitRight: {
    hotkey: "ctrl+shift+o",
    scope: "workspace",
    group: "Panes",
    label: "Split right with a new chat",
  },
  splitDown: {
    hotkey: "ctrl+shift+e",
    scope: "workspace",
    group: "Panes",
    label: "Split down with a new chat",
  },
  zoom: {
    hotkey: "ctrl+shift+enter",
    scope: "workspace",
    group: "Panes",
    label: "Zoom the pane, or back",
  },
  focusPane: {
    hotkey: "meta+ctrl+left, meta+ctrl+right, meta+ctrl+up, meta+ctrl+down",
    scope: "workspace",
    group: "Panes",
    label: "Go to the pane in that direction",
  },
  cyclePane: {
    hotkey: "meta+ctrl+bracketleft, meta+ctrl+bracketright",
    scope: "workspace",
    group: "Panes",
    label: "Go to the previous or next pane",
  },
  resizePane: {
    hotkey: "meta+ctrl+shift+left, meta+ctrl+shift+right, meta+ctrl+shift+up, meta+ctrl+shift+down",
    scope: "workspace",
    group: "Panes",
    label: "Make the pane narrower, wider, taller or shorter",
  },
  equalize: {
    hotkey: "meta+ctrl+equal",
    scope: "workspace",
    group: "Panes",
    label: "Share the space equally",
  },
  swapPane: {
    hotkey: "ctrl+shift+f8",
    scope: "workspace",
    group: "Panes",
    label: "Swap with the next pane",
  },
  closePane: {
    hotkey: "ctrl+shift+w",
    scope: "workspace",
    group: "Panes",
    label: "Close the pane",
  },
  newTab: {
    hotkey: "ctrl+shift+t",
    scope: "workspace",
    group: "Tabs",
    label: "New tab with a new chat",
  },
  nextTab: {
    hotkey: "ctrl+tab, ctrl+shift+right",
    scope: "workspace",
    group: "Tabs",
    label: "Next tab",
  },
  previousTab: {
    hotkey: "ctrl+shift+tab, ctrl+shift+left",
    scope: "workspace",
    group: "Tabs",
    label: "Previous tab",
  },
  closeTab: { hotkey: "ctrl+shift+q", scope: "workspace", group: "Tabs", label: "Close the tab" },
  renameTab: {
    hotkey: "ctrl+shift+alt+t",
    scope: "workspace",
    group: "Tabs",
    label: "Rename the tab",
  },
  moveTabRight: {
    hotkey: "ctrl+shift+period",
    scope: "workspace",
    group: "Tabs",
    label: "Move the tab right",
  },
  moveTabLeft: {
    hotkey: "ctrl+shift+comma",
    scope: "workspace",
    group: "Tabs",
    label: "Move the tab left",
  },
  palette: {
    hotkey: "ctrl+k, meta+k",
    scope: "workspace",
    group: "App",
    label: "Open the palette",
  },
  shortcuts: {
    hotkey: "ctrl+slash, meta+slash",
    scope: "workspace",
    group: "App",
    label: "Show the keys",
  },
  settings: {
    hotkey: "ctrl+comma, meta+comma",
    scope: "workspace",
    group: "App",
    label: "Open the settings",
  },
  sidePanel: {
    hotkey: "ctrl+alt+b",
    scope: "workspace",
    group: "App",
    label: "Show or hide the side panel",
  },

  foldTools: {
    hotkey: "ctrl+o",
    scope: "pane",
    group: "Transcript",
    label: "Open or fold every tool card",
  },
  foldThinking: {
    hotkey: "ctrl+t",
    scope: "pane",
    group: "Transcript",
    label: "Show or hide thinking",
  },
  agentHub: {
    hotkey: "alt+a",
    scope: "pane",
    group: "Transcript",
    label: "Open or close the Agent Hub",
  },
  planMode: {
    hotkey: "alt+shift+p",
    scope: "pane",
    group: "Message box",
    label: "Plan mode on or off",
  },

  send: {
    hotkey: "enter",
    scope: "box",
    group: "Message box",
    label: "Send (while omp works: steer)",
  },
  newline: {
    hotkey: "shift+enter, alt+enter",
    scope: "box",
    group: "Message box",
    label: "New line",
  },
  followUp: {
    hotkey: "ctrl+enter",
    scope: "box",
    group: "Message box",
    label: "Queue a follow-up; approve when an approval waits",
  },
  stop: {
    hotkey: "escape",
    scope: "box",
    group: "Message box",
    label: "Stop omp; deny when an approval waits",
  },
  history: {
    hotkey: "up, down",
    scope: "box",
    group: "Message box",
    label: "Go through what was sent",
  },
  thinkingLevel: {
    hotkey: "shift+tab",
    scope: "box",
    group: "Message box",
    label: "Next thinking level",
  },
  model: { hotkey: "alt+p", scope: "box", group: "Message box", label: "Choose the model" },
  nextRole: {
    hotkey: "ctrl+p",
    scope: "pane",
    group: "Message box",
    label: "Next role's model (smol, default, slow)",
  },
  previousRole: {
    hotkey: "ctrl+shift+p",
    scope: "pane",
    group: "Message box",
    label: "Previous role's model",
  },
  modelHub: {
    hotkey: "alt+m",
    scope: "pane",
    group: "Message box",
    label: "Models: give each role its model",
  },
  retry: { hotkey: "alt+r", scope: "box", group: "Message box", label: "Retry the failed turn" },
  takeBack: {
    hotkey: "alt+up",
    scope: "box",
    group: "Message box",
    label: "Take the last queued message back",
  },
} as const satisfies Record<string, Omit<KeyBinding, "id">>;

export type KeyId = keyof typeof KEYS;

export const BINDINGS: readonly KeyBinding[] = Object.entries(KEYS).map(([id, binding]) => ({
  id,
  ...binding,
}));

const MODIFIERS = ["meta", "ctrl", "alt", "shift"] as const;
const ALIASES: Record<string, string> = {
  up: "arrowup",
  down: "arrowdown",
  left: "arrowleft",
  right: "arrowright",
  esc: "escape",
  return: "enter",
  control: "ctrl",
};

/** One alternative of a hotkey with its modifiers in a fixed order, so equal keys compare equal. */
export function normalize(chord: string): string {
  const parts = chord
    .trim()
    .toLowerCase()
    .split("+")
    .map((part) => ALIASES[part] ?? part);
  const modifiers = MODIFIERS.filter((modifier) => parts.includes(modifier));
  const keys = parts.filter((part) => !(MODIFIERS as readonly string[]).includes(part));
  return [...modifiers, ...keys].join("+");
}

/** A binding's alternatives, normalized. */
export const chords = (binding: Pick<KeyBinding, "hotkey">): readonly string[] =>
  binding.hotkey.split(",").map(normalize);

const SHOWN: Record<string, string> = {
  meta: "Super",
  ctrl: "Ctrl",
  alt: "Alt",
  shift: "Shift",
  enter: "Enter",
  escape: "Esc",
  tab: "Tab",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  bracketleft: "[",
  bracketright: "]",
  period: ".",
  comma: ",",
  slash: "/",
  equal: "=",
};

/** How a binding's first alternative reads on a keycap: `Ctrl+Shift+O`. */
export function keycap(binding: Pick<KeyBinding, "hotkey">): string {
  const [first] = chords(binding);
  return (first ?? "")
    .split("+")
    .map((part) => SHOWN[part] ?? part.toUpperCase())
    .join("+");
}

/** Which scopes act together: a workspace key acts in a pane and in its box too, a pane's key in its box. */
const REACHES: Record<KeyScope, readonly KeyScope[]> = {
  workspace: ["workspace", "pane", "box"],
  pane: ["pane", "box"],
  box: ["box"],
};

/** Pairs of bindings that share a key where both act; empty when the table is sound. */
export function collisions(bindings: readonly KeyBinding[]): readonly string[] {
  const found: string[] = [];
  bindings.forEach((a, index) => {
    for (const b of bindings.slice(index + 1)) {
      const together = REACHES[a.scope].some((scope) => REACHES[b.scope].includes(scope));
      if (!together) continue;
      for (const chord of chords(a))
        if (chords(b).includes(chord)) found.push(`${a.id} and ${b.id}: ${chord}`);
    }
  });
  return found;
}
