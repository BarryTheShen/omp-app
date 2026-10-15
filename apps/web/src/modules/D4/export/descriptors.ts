import type { Descriptor } from "@omp-app/contracts";

/**
 * D4.3's registry descriptors: the five inventory rows this part builds (`D5.export`, `D5.dump`,
 * `D5.dump-all`, `D5.open`, `D5.record`), each covered once. D4.6 does not compose them into `D4_DESCRIPTORS` until
 * their commands are mounted (follow-up issue 1683), and does not declare them again. `/dump all` is a subcommand, so
 * it has no slash name of its own.
 */
export const EXPORT_COMMAND_DESCRIPTORS = [
  {
    kind: "command",
    id: "D4.export",
    owner: "D4",
    title: "Export this chat",
    covers: ["D5.export"],
    requires: ["omp.cmd.export_html"],
    slash: { name: "export", source: "builtin" },
  },
  {
    kind: "command",
    id: "D4.dump",
    owner: "D4",
    title: "Save this chat as a dump file",
    covers: ["D5.dump"],
    requires: ["host.command-gateway"],
    slash: { name: "dump", source: "builtin" },
  },
  {
    kind: "command",
    id: "D4.dump-all",
    owner: "D4",
    title: "Save omp's archive of this chat",
    covers: ["D5.dump-all"],
    requires: ["host.command-gateway"],
  },
  {
    kind: "command",
    id: "D4.open",
    owner: "D4",
    title: "Open the last link (omp's terminal only)",
    covers: ["D5.open"],
    requires: [],
    slash: { name: "open", source: "builtin" },
  },
  {
    kind: "command",
    id: "D4.record",
    owner: "D4",
    title: "Record the screen (omp's terminal only)",
    covers: ["D5.record"],
    requires: [],
    slash: { name: "record", source: "builtin" },
  },
] as const satisfies readonly Descriptor[];
