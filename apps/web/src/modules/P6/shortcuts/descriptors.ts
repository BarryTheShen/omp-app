import type { ShortcutDescriptor } from "@omp-app/contracts";

/**
 * Browser-local queue controls from omp's v18.6.1 input grammar:
 * `Ctrl/Cmd+Enter` queues a follow-up and `Alt+Up` restores a queued message. The browser app
 * registers the descriptors; P6.3/U2 owns the actual composer action wiring.
 * Sources: research/omp-feature-inventory.md:436-440 and omp's v18.6.1 input-controller keybindings.
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
    id: "P6.message.dequeue",
    owner: "P6",
    title: "Restore queued message",
    kind: "shortcut",
    chord: "Alt+Up",
    scope: "composer",
    covers: ["P5.dequeue-queued-message", "P5.app-message-dequeue"],
    requires: [],
  },
] as const satisfies readonly ShortcutDescriptor[];

export type P6ShortcutDescriptor = (typeof P6_SHORTCUT_DESCRIPTORS)[number];
