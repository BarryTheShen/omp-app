import type { Descriptor } from "@omp-app/contracts";

export const P7_COMMAND_DESCRIPTORS = [
  {
    kind: "command",
    id: "P7.context",
    owner: "P7",
    title: "Show context usage",
    covers: ["P4.context"],
    requires: ["host.command-gateway"],
    slash: { name: "context", source: "builtin" },
  },
  {
    kind: "command",
    id: "P7.stats",
    owner: "P7",
    title: "Show session statistics",
    covers: ["P4.stats"],
    requires: ["host.command-gateway"],
    slash: { name: "stats", source: "builtin" },
  },
  {
    kind: "command",
    id: "P7.usage",
    owner: "P7",
    title: "Show provider usage",
    covers: ["P4.usage-command", "P4.usage-show", "P4.usage-reset"],
    requires: ["host.command-gateway"],
    slash: { name: "usage", source: "builtin" },
  },
  {
    kind: "command",
    id: "P7.compact",
    owner: "P7",
    title: "Compact conversation",
    covers: ["E4.compact", "E4.compact-soft", "E4.compact-remote", "E4.compact-snapcompact"],
    requires: ["host.command-gateway"],
    slash: { name: "compact", source: "builtin" },
  },
] as const satisfies readonly Descriptor[];
