import type { ShortcutDescriptor } from "@omp-app/contracts";

/** The app registers Alt+Up's action under this id (app/queue-dequeue-shortcut.ts). */
export const P6_DEQUEUE_SHORTCUT_ID = "P6.message.dequeue" as const;

/** Alt+Up also fires while focus is in the message box, so its descriptor opts in. */
type EditableShortcutDescriptor = ShortcutDescriptor & { readonly allowInEditable: true };

/**
 * Browser-local queue controls from omp's v18.12.6 input grammar:
 * `Ctrl/Cmd+Enter` queues a follow-up and `Alt+Up` restores a queued message. The browser app
 * registers the descriptors; P6.3/U2 owns the actual composer action wiring.
 * Sources: research/omp-feature-inventory.md:436-440 and omp v18.12.6's `app.message.followUp` and `app.message.dequeue`
 * keybindings (packages/tui/src/app-keybindings.ts:157-175: Ctrl+Q or Ctrl+Enter, and Alt+Up or Shift+Up).
 */
export const P6_SHORTCUT_DESCRIPTORS = [
  {
    id: "P6.message.followUp",
    owner: "P6",
    title: "Queue follow-up",
    kind: "shortcut",
    chord: "Mod+Enter",
    scope: "composer",
    covers: ["P5.follow-up-on-ctrl-enter-ctrl-q", "P5.app-message-followup"],
    requires: [],
  },
  {
    id: P6_DEQUEUE_SHORTCUT_ID,
    owner: "P6",
    title: "Restore queued message",
    kind: "shortcut",
    chord: "Alt+ArrowUp",
    scope: "composer",
    allowInEditable: true,
    covers: ["P5.dequeue-queued-message", "P5.app-message-dequeue"],
    requires: [],
  },
] as const satisfies readonly (ShortcutDescriptor | EditableShortcutDescriptor)[];

export type P6ShortcutDescriptor = (typeof P6_SHORTCUT_DESCRIPTORS)[number];
