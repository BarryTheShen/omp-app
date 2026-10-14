import type { CommandDescriptor } from "@omp-app/contracts";

/**
 * The palette commands that open the reports panel and the security panel. Each one is listed only
 * when the command gateway is available, and the app's handlers open the matching panel.
 */
export const D6_REPORT_PALETTE_COMMANDS = [
  {
    kind: "command",
    id: "D6.reports",
    owner: "D6",
    title: "Show reports",
    covers: ["C1.changelog", "C1.jobs", "C1.trace"],
    requires: ["host.command-gateway"],
  },
  {
    kind: "command",
    id: "D6.security",
    owner: "D6",
    title: "Security scans",
    covers: ["C1.security"],
    requires: ["host.command-gateway"],
  },
] as const satisfies readonly CommandDescriptor[];
