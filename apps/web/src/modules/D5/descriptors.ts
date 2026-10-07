import type { Descriptor } from "@omp-app/contracts";
import { SESSION_LIFECYCLE_CAPABILITIES } from "./lifecycle";

/**
 * D5-owned lifecycle commands; later D5 command surfaces reuse these registry entries.
 *
 * Only `/fresh` carries a slash name. Over omp's RPC, `/new` and `/clear` have no non-terminal
 * handler, so omp sends them to the model as plain text (probed on omp 18.7.0): a user who typed
 * what the palette shows would spend a model turn on the word "/new". They get a slash name back
 * when the composer's slash catalog (D2.3) runs them through these app handlers instead.
 */
export const D5_LIFECYCLE_COMMAND_DESCRIPTORS = [
  {
    kind: "command",
    id: "D5.new",
    owner: "D5",
    title: "New chat",
    covers: ["C2.new"],
    requires: [SESSION_LIFECYCLE_CAPABILITIES.new],
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
  },
] as const satisfies readonly Descriptor[];
