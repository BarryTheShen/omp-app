import type { CommandDescriptor, Descriptor, StatusDescriptor } from "@omp-app/contracts";
import { type D7Capability, type ExecutionMode, MODE_CAPABILITY_REQUIREMENTS } from "../contract";

const command = (
  id: string,
  title: string,
  covers: readonly string[],
  mode: ExecutionMode | undefined,
  name: string | undefined,
  requires: readonly D7Capability[] = mode
    ? (MODE_CAPABILITY_REQUIREMENTS[mode] as readonly D7Capability[])
    : ["host.command-gateway"],
): CommandDescriptor => ({
  kind: "command",
  id: id as CommandDescriptor["id"],
  owner: "D7",
  title,
  covers: [...covers] as CommandDescriptor["covers"],
  requires: [...requires],
  ...(name === undefined ? {} : { slash: { name, source: "builtin" as const } }),
});

const status = (
  id: string,
  title: string,
  covers: readonly string[],
  requires: readonly D7Capability[],
): StatusDescriptor => ({
  kind: "status",
  id: id as StatusDescriptor["id"],
  owner: "D7",
  title,
  covers: [...covers] as StatusDescriptor["covers"],
  requires: [...requires],
});

export const D7_COMMAND_DESCRIPTORS = [
  command(
    "D7.browser",
    "Browser use",
    ["C3.browser", "C3.browser-headless", "C3.browser-visible"],
    "browser",
    "browser",
  ),
  command(
    "D7.computer",
    "Computer use",
    ["C3.computer", "C3.computer-off", "C3.computer-on"],
    "computer",
    "computer",
  ),
  command(
    "D7.extendedContext",
    "Extended context",
    ["C3.extended-context-command", "C3.extended-context-off", "C3.extended-context-on"],
    "extended-context",
    "extended-context",
  ),
  command("D7.fast", "Fast mode", ["C3.fast", "C3.fast-off", "C3.fast-on"], "fast", "fast"),
  command("D7.slow", "Slow mode", ["C3.slow", "C3.slow-off", "C3.slow-on"], "slow", "slow"),
  command("D7.force", "Force execution", ["C3.force"], "force", "force"),
  command("D7.prewalk", "Prepare a faster model", ["C3.prewalk-command"], "prewalk", "prewalk"),
  command(
    "D7.shake",
    "Refresh context",
    ["C3.shake", "C3.shake-elide", "C3.shake-images"],
    "shake",
    "shake",
  ),
  command(
    "D7.skillful",
    "Skill listing",
    ["C3.skillful", "C3.skillful-off", "C3.skillful-on"],
    "skillful",
    "skillful",
  ),
  command("D7.tools", "Available tools", ["C4.tools"], undefined, "tools"),
] as const satisfies readonly CommandDescriptor[];

const MODE_STATUS: ReadonlyArray<readonly [ExecutionMode, string, readonly string[]]> = [
  ["browser", "Browser status", ["C3.browser-visibility"]],
  ["computer", "Computer status", ["C3.computer-status", "C3.computer-use"]],
  [
    "extended-context",
    "Extended context status",
    ["C3.extended-context-status", "C3.extended-context-mode"],
  ],
  ["fast", "Fast mode status", ["C3.fast-status", "C3.fast-mode"]],
  ["slow", "Slow mode status", ["C3.slow-status"]],
  ["prewalk", "Preparation status", ["C3.prewalk-mode"]],
  ["skillful", "Skill listing status", ["C3.skillful-status"]],
  ["default", "Standard execution status", ["C3.default-execution"]],
];

export const D7_STATUS_DESCRIPTORS = MODE_STATUS.map(([mode, title, covers]) =>
  status(
    `D7.${mode.replaceAll("-", "")}.status`,
    title,
    covers,
    MODE_CAPABILITY_REQUIREMENTS[mode] as readonly D7Capability[],
  ),
) as readonly StatusDescriptor[];

export const D7_DESCRIPTORS = [
  ...D7_COMMAND_DESCRIPTORS,
  ...D7_STATUS_DESCRIPTORS,
] as const satisfies readonly Descriptor[];
export type D7Descriptor = (typeof D7_DESCRIPTORS)[number];
