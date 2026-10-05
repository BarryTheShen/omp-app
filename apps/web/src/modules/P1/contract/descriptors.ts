import type { Descriptor } from "@omp-app/contracts";

/** Owner-prefixed descriptor unions P1's later descriptor part will register. */
export type P1Descriptor = Extract<Descriptor, { owner: "P1" }>;
export type P1PanelDescriptor = Extract<P1Descriptor, { kind: "panel" }>;
export type P1MessageDescriptor = Extract<P1Descriptor, { kind: "message" }>;
export type P1CommandDescriptor = Extract<P1Descriptor, { kind: "command" }>;
export type P1SettingDescriptor = Extract<P1Descriptor, { kind: "setting" }>;
export type P1ShortcutDescriptor = Extract<P1Descriptor, { kind: "shortcut" }>;

export type P1DescriptorKind = P1Descriptor["kind"];
