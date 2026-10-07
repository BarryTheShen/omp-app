import type { Descriptor } from "@omp-app/contracts";
import { SESSION_LIFECYCLE_CAPABILITIES } from "./lifecycle";

/** D5-owned lifecycle commands; later D5 command surfaces reuse these registry entries. */
export const D5_LIFECYCLE_COMMAND_DESCRIPTORS = [
  {
    kind: "command",
    id: "D5.new",
    owner: "D5",
    title: "New chat",
    covers: ["C2.new"],
    requires: [SESSION_LIFECYCLE_CAPABILITIES.new],
    slash: { name: "new", source: "builtin" },
  },
  {
    kind: "command",
    id: "D5.fresh",
    owner: "D5",
    title: "Fresh connection to the model",
    covers: ["C2.fresh"],
    requires: [SESSION_LIFECYCLE_CAPABILITIES.fresh],
    slash: { name: "fresh", source: "builtin" },
  },
  {
    kind: "command",
    id: "D5.clear",
    owner: "D5",
    title: "Clear conversation",
    covers: ["C2.clear"],
    requires: [SESSION_LIFECYCLE_CAPABILITIES.clear],
    slash: { name: "clear", source: "builtin" },
  },
] as const satisfies readonly Descriptor[];
