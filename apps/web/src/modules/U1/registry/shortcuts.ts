import type { ShortcutDescriptor } from "@omp-app/contracts";

/** F6 transcript shortcuts; U0 owns normalization, rebinding, conflicts, and the shortcut sheet. */
export const U1ShortcutDescriptors = [
  {
    id: "U1.appDisplayReset",
    owner: "U1",
    title: "Jump to latest message",
    kind: "shortcut",
    chord: "Alt+L",
    scope: "transcript",
    covers: ["F6.app-display-reset"],
    requires: [],
  },
  /** Alt+T stays available in the browser, which reserves Ctrl+T for opening a tab. */
  {
    id: "U1.thinking.toggle",
    owner: "U1",
    title: "Toggle thinking",
    kind: "shortcut",
    chord: "Alt+T",
    scope: "transcript",
    covers: ["F6.app-thinking-toggle"],
    requires: [],
  },
  {
    id: "U1.appToolsExpand",
    owner: "U1",
    title: "Expand or collapse all tool calls",
    kind: "shortcut",
    chord: "Mod+O",
    scope: "transcript",
    covers: ["F6.app-tools-expand"],
    requires: [],
  },
  {
    id: "U1.appToolsToggleVisibility",
    owner: "U1",
    title: "Show or hide tool activity",
    kind: "shortcut",
    chord: "Mod+Shift+O",
    scope: "transcript",
    covers: ["F6.app-tools-togglevisibility"],
    requires: [],
  },
] as const satisfies readonly ShortcutDescriptor[];
