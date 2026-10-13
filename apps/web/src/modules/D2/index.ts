import { D2_TRIGGER_DESCRIPTORS } from "./contract";
import { D2_SOURCE_DESCRIPTORS } from "./descriptors/descriptors";

export { D2_SOURCE_DESCRIPTORS } from "./descriptors/descriptors";

/** Every descriptor D2 registers: the composer triggers (D2.1) and the command sources (D2.6), each listed once. */
export const D2_DESCRIPTORS = [...D2_TRIGGER_DESCRIPTORS, ...D2_SOURCE_DESCRIPTORS] as const;
