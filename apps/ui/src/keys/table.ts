/**
 * Every key of the app, in one table: the workspace's (kitty's), a pane's and the message box's (Tern's). The shortcuts
 * sheet and the palette show them from here, the workspace binds its keys from here, and a unit test checks that no two
 * bindings that can act at once share a key.
 */

/**
 * Where a key acts: anywhere in the app, in the focused pane, in its message box, or in an open menu, which takes its
 * own keys first.
 */
export type KeyScope = "workspace" | "pane" | "box" | "menu";

export interface KeyBinding {
  readonly id: string;
  /** As react-hotkeys-hook reads it, by key code: modifiers first, `,` between alternatives. */
  readonly hotkey: string;
  readonly scope: KeyScope;
  readonly group: "Windows" | "Workspaces" | "Message box" | "Transcript" | "App";
  readonly label: string;
  /** A key of the desktop window only: a browser keeps its own use of it, so the app neither binds nor lists it there. */
  readonly desktopOnly?: true;
  /**
   * A key of an app window only (the desktop window, an installed web app, a Home Screen app): in a browser tab it is the
   * browser's own (Ctrl+1…9 go to its tabs), so the app neither binds nor lists it there (#2831).
   */
  readonly appWindowOnly?: true;
}

/**
 * Whether this is Apple's device (a Mac, an iPad, an iPhone with a keyboard): there ⌘ does what Ctrl does (#2775).
 * iPadOS's Safari reports a Mac, which is right here too.
 */
export const APPLE =
  typeof navigator !== "undefined" &&
  (/Mac|iPhone|iPad|iPod/.test(navigator.platform) ||
    /Macintosh|iPhone|iPad|iPod/.test(navigator.userAgent));

const TABLE = {
  splitRight: {
    hotkey: "ctrl+shift+o",
    scope: "workspace",
    group: "Windows",
    label: "Split right into a blank window",
  },
  splitDown: {
    hotkey: "ctrl+shift+e",
    scope: "workspace",
    group: "Windows",
    label: "Split down into a blank window",
  },
  zoom: {
    hotkey: "ctrl+shift+enter",
    scope: "workspace",
    group: "Windows",
    label: "Zoom the window, or back",
  },
  focusPane: {
    hotkey: "meta+ctrl+left, meta+ctrl+right, meta+ctrl+up, meta+ctrl+down",
    scope: "workspace",
    group: "Windows",
    label: "Go to the window in that direction",
  },
  cyclePane: {
    hotkey: "meta+ctrl+bracketleft, meta+ctrl+bracketright",
    scope: "workspace",
    group: "Windows",
    label: "Go to the previous or next window",
  },
  resizePane: {
    hotkey: "meta+ctrl+shift+left, meta+ctrl+shift+right, meta+ctrl+shift+up, meta+ctrl+shift+down",
    scope: "workspace",
    group: "Windows",
    label: "Make the window narrower, wider, taller or shorter",
  },
  equalize: {
    hotkey: "meta+ctrl+equal",
    scope: "workspace",
    group: "Windows",
    label: "Share the space equally",
  },
  paneMode: {
    hotkey: "ctrl+shift+space",
    scope: "workspace",
    group: "Windows",
    label:
      "Window mode, without Super: arrows go, Shift+arrows resize, = shares, [ ] cycle, Esc ends",
  },
  swapPane: {
    hotkey: "ctrl+shift+f8",
    scope: "workspace",
    group: "Windows",
    label: "Swap with the next window",
  },
  closePane: {
    hotkey: "ctrl+shift+w",
    scope: "workspace",
    group: "Windows",
    label: "Close the window",
  },
  newTab: {
    hotkey: "ctrl+t",
    scope: "workspace",
    group: "Workspaces",
    label: "New workspace",
  },
  newChat: {
    hotkey: "ctrl+o",
    scope: "workspace",
    group: "Workspaces",
    label: "New chat",
  },
  closeTab: {
    hotkey: "ctrl+w, ctrl+shift+q",
    scope: "workspace",
    group: "Workspaces",
    label: "Close the workspace",
  },
  reopenTab: {
    hotkey: "ctrl+shift+t",
    scope: "workspace",
    group: "Workspaces",
    label: "Reopen the workspace closed last",
  },
  nextTab: {
    hotkey: "ctrl+tab, ctrl+pagedown, ctrl+shift+right",
    scope: "workspace",
    group: "Workspaces",
    label: "Next workspace",
  },
  previousTab: {
    hotkey: "ctrl+shift+tab, ctrl+pageup, ctrl+shift+left",
    scope: "workspace",
    group: "Workspaces",
    label: "Previous workspace",
  },
  goToTab: {
    hotkey: "ctrl+1, ctrl+2, ctrl+3, ctrl+4, ctrl+5, ctrl+6, ctrl+7, ctrl+8, ctrl+9",
    scope: "workspace",
    group: "Workspaces",
    label: "Go to workspace 1 to 8; 9: the last one",
    appWindowOnly: true,
  },
  renameTab: {
    hotkey: "ctrl+shift+alt+t",
    scope: "workspace",
    group: "Workspaces",
    label: "Rename the workspace",
  },
  moveTabRight: {
    hotkey: "ctrl+shift+period",
    scope: "workspace",
    group: "Workspaces",
    label: "Move the workspace right",
  },
  moveTabLeft: {
    hotkey: "ctrl+shift+comma",
    scope: "workspace",
    group: "Workspaces",
    label: "Move the workspace left",
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
  dashboard: {
    hotkey: "ctrl+shift+d, meta+shift+d",
    scope: "workspace",
    group: "App",
    label: "Open the dashboard",
  },
  sidePanel: {
    hotkey: "ctrl+alt+b",
    scope: "workspace",
    group: "App",
    label: "Show or hide the side panel",
  },
  chatList: {
    hotkey: "ctrl+b",
    scope: "workspace",
    group: "App",
    label: "Show or hide the chat list",
  },
  newWindow: {
    hotkey: "ctrl+shift+n",
    scope: "workspace",
    group: "App",
    label: "New app window",
    desktopOnly: true,
  },
  zoomIn: {
    hotkey: "ctrl+equal, ctrl+shift+equal, ctrl+add",
    scope: "workspace",
    group: "App",
    label: "Zoom the app in",
    desktopOnly: true,
  },
  zoomOut: {
    hotkey: "ctrl+minus, ctrl+subtract",
    scope: "workspace",
    group: "App",
    label: "Zoom the app out",
    desktopOnly: true,
  },
  zoomReset: {
    hotkey: "ctrl+0",
    scope: "workspace",
    group: "App",
    label: "The app at 100%",
    desktopOnly: true,
  },

  foldTools: {
    hotkey: "alt+o",
    scope: "pane",
    group: "Transcript",
    label: "Open or fold every tool card",
  },
  foldThinking: {
    hotkey: "alt+t",
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
  starModel: {
    hotkey: "alt+s",
    scope: "menu",
    group: "Message box",
    label: "In the model menu: star or unstar the highlighted model",
  },
  hideModel: {
    hotkey: "alt+h",
    scope: "menu",
    group: "Message box",
    label: "In the model menu: hide or show the highlighted model",
  },
  // omp's own key for its question dialog (`app.ask.hide`).
  askHide: {
    hotkey: "alt+h",
    scope: "pane",
    group: "Message box",
    label: "Hide or show the questions omp asks",
  },
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

export type KeyId = keyof typeof TABLE;

/**
 * A hotkey with ⌘ beside each of its Ctrl chords, for an Apple device (#2775): `ctrl+shift+o` gains `meta+shift+o`. A
 * chord that holds ⌘ already (the pane keys hold Super) stays as it is, and one listed with ⌘ already is not repeated.
 */
export function withCommand(hotkey: string): string {
  const alternatives = hotkey.split(",").map((chord) => chord.trim());
  const listed = new Set(alternatives.map(normalize));
  const added = alternatives.flatMap((chord) => {
    const parts = chord.split("+");
    const named = parts.map((part) => ALIASES[part.toLowerCase()] ?? part.toLowerCase());
    if (!named.includes("ctrl") || named.includes("meta")) return [];
    const command = parts.map((part, index) => (named[index] === "ctrl" ? "meta" : part)).join("+");
    if (listed.has(normalize(command))) return [];
    listed.add(normalize(command));
    return [command];
  });
  return [...alternatives, ...added].join(", ");
}

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

/**
 * The keys a browser tab keeps for its own tabs and windows: the page never gets them (Chromium's reserved commands,
 * `chrome/browser/ui/accelerator_table.cc` `kReservedCommandIds`; Firefox since version 48, Mozilla bug 1291706). They
 * reach the app in the desktop window, an installed app's window (Chromium reserves no key there,
 * `browser_command_controller.cc` `IsReservedCommandOrKey`) and a full-screen tab (#2831). ⌘⇧Q is macOS's Log Out,
 * which its menu takes first.
 */
const BROWSER_KEEPS = new Set(
  [
    "ctrl+t",
    "ctrl+w",
    "ctrl+n",
    "ctrl+shift+t",
    "ctrl+shift+w",
    "ctrl+shift+n",
    "ctrl+tab",
    "ctrl+shift+tab",
    "ctrl+pagedown",
    "ctrl+pageup",
    "meta+t",
    "meta+w",
    "meta+n",
    "meta+shift+t",
    "meta+shift+w",
    "meta+shift+n",
    "meta+shift+q",
  ].map((chord) => normalize(chord)),
);

/** Whether a browser tab keeps this chord for itself (`BROWSER_KEEPS`). */
export const browserKeeps = (chord: string): boolean => BROWSER_KEEPS.has(normalize(chord));

/** Whether a browser tab leaves at least one of a binding's keys to the page. */
export const reachesTab = (binding: Pick<KeyBinding, "hotkey">): boolean =>
  chords(binding).some((chord) => !browserKeeps(chord));

let appWindow: boolean | undefined;

/**
 * Whether this page is an app window, which gets every key (#2831): the desktop window, an installed web app's window,
 * or a Home Screen app. Not a browser tab, which keeps its tab keys (`BROWSER_KEEPS`). A page's window stays what it
 * is, so this is read once.
 */
export function inAppWindow(): boolean {
  if (typeof window === "undefined") return false;
  appWindow ??=
    (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== undefined ||
    window.matchMedia?.("(display-mode: standalone)").matches === true ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return appWindow;
}

/** Every key of the app as this device takes it: on an Apple device each Ctrl chord also with ⌘. */
export const KEYS: { readonly [Id in KeyId]: Omit<KeyBinding, "id"> } = APPLE
  ? (Object.fromEntries(
      Object.entries(TABLE).map(([id, binding]) => [
        id,
        { ...binding, hotkey: withCommand(binding.hotkey) },
      ]),
    ) as { readonly [Id in KeyId]: Omit<KeyBinding, "id"> })
  : TABLE;

export const BINDINGS: readonly KeyBinding[] = Object.entries(KEYS).map(([id, binding]) => ({
  id,
  ...binding,
}));

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
  minus: "-",
  space: "Space",
  pagedown: "PgDn",
  pageup: "PgUp",
};

/** On an Apple keyboard, the keycaps' own signs. */
const SHOWN_APPLE: Record<string, string> = {
  meta: "⌘",
  ctrl: "⌃",
  alt: "⌥",
  shift: "⇧",
  enter: "↩",
  tab: "⇥",
};

/**
 * How a binding reads on a keycap: its first alternative, `Ctrl+Shift+O`. On an Apple device its first alternative with
 * ⌘, in Apple's signs: `⌘⇧O`. In a browser tab (`tab`), of the alternatives the browser leaves to the page when it
 * leaves any, so nothing ever names a key that closes the tab (#2831).
 */
export function keycap(
  binding: Pick<KeyBinding, "hotkey">,
  apple = APPLE,
  tab = !inAppWindow(),
): string {
  const every = chords(binding);
  const reaching = tab ? every.filter((chord) => !browserKeeps(chord)) : every;
  const all = reaching.length > 0 ? reaching : every;
  const shown =
    (apple ? all.find((chord) => chord.split("+").includes("meta")) : undefined) ?? all[0] ?? "";
  return shown
    .split("+")
    .map((part) => (apple ? SHOWN_APPLE[part] : undefined) ?? SHOWN[part] ?? part.toUpperCase())
    .join(apple ? "" : "+");
}

/**
 * Which scopes act together: a workspace key acts in a pane, its box and an open menu too, a pane's key in its box. An
 * open menu takes its keys first (`preventDefault`), so a pane's key on the same chord does not act there.
 */
const REACHES: Record<KeyScope, readonly KeyScope[]> = {
  workspace: ["workspace", "pane", "box", "menu"],
  pane: ["pane", "box"],
  box: ["box"],
  menu: ["menu"],
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
