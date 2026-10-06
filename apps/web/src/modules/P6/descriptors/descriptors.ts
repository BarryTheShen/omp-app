import type { Descriptor } from "@omp-app/contracts";
import { P6_QUEUE_CAPABILITIES } from "../contract";
import { P6_SHORTCUT_DESCRIPTORS } from "../shortcuts";

/**
 * P6's queue claims. `/queue` is a browser-local command: its slash namespace is registered for
 * discovery, while the command is expanded locally and admitted through R0.5 rather than sent as a
 * fake prompt. The inventory rows and capability boundary come from research/modules/P6.md:12-31.
 */
export const P6_QUEUE_DESCRIPTORS = [
  {
    kind: "command",
    id: "P6.queue",
    owner: "P6",
    title: "Queue a follow-up",
    covers: ["P5.queue"],
    requires: [P6_QUEUE_CAPABILITIES.followUp],
    slash: { name: "queue", source: "builtin" },
  },
  {
    kind: "command",
    id: "P6.removeQueuedMessage",
    owner: "P6",
    title: "Remove queued message",
    covers: ["P5.remove-queued-message"],
    requires: [P6_QUEUE_CAPABILITIES.remove],
  },
  {
    kind: "command",
    id: "P6.promoteQueuedMessage",
    owner: "P6",
    title: "Promote queued message",
    covers: ["P5.promote-queued-message"],
    requires: [P6_QUEUE_CAPABILITIES.promote],
  },
  {
    kind: "dialog",
    id: "P6.followUpQueueMode",
    owner: "P6",
    title: "Follow-up queue mode",
    covers: ["P5.follow-up-queue-mode"],
    requires: [P6_QUEUE_CAPABILITIES.followUpMode],
  },
  {
    kind: "dialog",
    id: "P6.interruptMode",
    owner: "P6",
    title: "Queue interrupt mode",
    covers: ["P5.interrupt-mode"],
    requires: [P6_QUEUE_CAPABILITIES.interruptMode],
  },
  {
    kind: "dialog",
    id: "P6.steeringQueueMode",
    owner: "P6",
    title: "Steering queue mode",
    covers: ["P5.steering-queue-mode"],
    requires: [P6_QUEUE_CAPABILITIES.steeringMode],
  },
  {
    kind: "dialog",
    id: "P6.queueModeSelector",
    owner: "P6",
    title: "Queue mode selector",
    covers: ["P5.queue-mode-selector-component"],
    requires: [
      P6_QUEUE_CAPABILITIES.steeringMode,
      P6_QUEUE_CAPABILITIES.followUpMode,
      P6_QUEUE_CAPABILITIES.interruptMode,
    ],
  },
  {
    kind: "composer",
    id: "P6.queueShorthand",
    owner: "P6",
    title: "Queue shorthand and lists",
    covers: ["P5.queue-shorthand-and-queued-lists"],
    requires: ["client.composer", P6_QUEUE_CAPABILITIES.followUp],
    feature: { slot: "submission" },
  },
  {
    kind: "composer",
    id: "P6.steerOnEnter",
    owner: "P6",
    title: "Steer on Enter while streaming",
    covers: ["P5.steer-on-enter-while-streaming"],
    requires: ["client.composer", P6_QUEUE_CAPABILITIES.steer],
    feature: { slot: "submission" },
  },
  {
    kind: "panel",
    id: "P6.queueBar",
    owner: "P6",
    title: "Queued steering and follow-up bar",
    covers: ["P5.queued-steering-follow-up-bar"],
    requires: [P6_QUEUE_CAPABILITIES.steer, P6_QUEUE_CAPABILITIES.followUp],
  },
] as const satisfies readonly Descriptor[];

/** Complete P6 descriptor claim, including the two keyboard descriptors from P6.4. */
export const P6_DESCRIPTORS = [
  ...P6_QUEUE_DESCRIPTORS,
  ...P6_SHORTCUT_DESCRIPTORS,
] as const satisfies readonly Descriptor[];

export type P6Descriptor = (typeof P6_DESCRIPTORS)[number];
