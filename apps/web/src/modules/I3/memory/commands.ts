import type { AppFailure, CommandDescriptor, MemoryEntry, MemoryScope } from "@omp-app/contracts";

export const MEMORY_COMMANDS = [
  "view",
  "stats",
  "diagnose",
  "clear",
  "enqueue",
  "rebuild",
  "reset",
  "mm-list",
  "mm-show",
  "mm-history",
  "mm-refresh",
  "mm-reload",
  "mm-seed",
] as const;
export type MemoryCommand = (typeof MEMORY_COMMANDS)[number];

export interface MemoryCommandRequest {
  readonly command: MemoryCommand;
  readonly scope: MemoryScope;
  readonly memoryId?: string;
}

export interface MemoryCommandResult {
  readonly command: MemoryCommand;
  readonly status: "complete" | "pending" | "error";
  readonly message?: string;
  readonly entries?: readonly MemoryEntry[];
  readonly error?: AppFailure;
}

export type MemoryCommandExecutor = (
  request: MemoryCommandRequest,
  options?: { readonly signal?: AbortSignal },
) => Promise<MemoryCommandResult>;

export const MEMORY_COMMAND_LABELS: Readonly<Record<MemoryCommand, string>> = {
  view: "View memory",
  stats: "Show memory stats",
  diagnose: "Diagnose memory",
  clear: "Clear memory",
  enqueue: "Queue consolidation",
  rebuild: "Rebuild memory",
  reset: "Reset memory",
  "mm-list": "List mental models",
  "mm-show": "Show mental model",
  "mm-history": "Show mental model history",
  "mm-refresh": "Refresh mental models",
  "mm-reload": "Reload mental models",
  "mm-seed": "Add built-in mental models",
};

export const MEMORY_COMMAND_DESCRIPTORS = [
  {
    kind: "command",
    id: "I3.memory",
    owner: "I3",
    title: "Memory",
    covers: ["C4.memory"],
    requires: ["host.memory-store"],
    slash: { name: "memory", source: "builtin" },
  },
  {
    kind: "command",
    id: "I3.memoryClear",
    owner: "I3",
    title: "Clear memory",
    covers: ["C4.memory-clear"],
    requires: ["host.memory-store"],
  },
  {
    kind: "command",
    id: "I3.memoryDiagnose",
    owner: "I3",
    title: "Diagnose memory",
    covers: ["C4.memory-diagnose"],
    requires: ["host.memory-store"],
  },
  {
    kind: "command",
    id: "I3.memoryEnqueue",
    owner: "I3",
    title: "Queue consolidation",
    covers: ["C4.memory-enqueue"],
    requires: ["host.memory-store"],
  },
  {
    kind: "command",
    id: "I3.memoryMmDelete",
    owner: "I3",
    title: "Delete mental model",
    covers: ["C4.memory-mm-delete"],
    requires: ["host.memory-store"],
  },
  {
    kind: "command",
    id: "I3.memoryMmHistory",
    owner: "I3",
    title: "Show mental model history",
    covers: ["C4.memory-mm-history"],
    requires: ["host.memory-store"],
  },
  {
    kind: "command",
    id: "I3.memoryMmList",
    owner: "I3",
    title: "List mental models",
    covers: ["C4.memory-mm-list"],
    requires: ["host.memory-store"],
  },
  {
    kind: "command",
    id: "I3.memoryMmRefresh",
    owner: "I3",
    title: "Refresh mental models",
    covers: ["C4.memory-mm-refresh"],
    requires: ["host.memory-store"],
  },
  {
    kind: "command",
    id: "I3.memoryMmReload",
    owner: "I3",
    title: "Reload mental models",
    covers: ["C4.memory-mm-reload"],
    requires: ["host.memory-store"],
  },
  {
    kind: "command",
    id: "I3.memoryMmSeed",
    owner: "I3",
    title: "Add built-in mental models",
    covers: ["C4.memory-mm-seed"],
    requires: ["host.memory-store"],
  },
  {
    kind: "command",
    id: "I3.memoryMmShow",
    owner: "I3",
    title: "Show mental model",
    covers: ["C4.memory-mm-show"],
    requires: ["host.memory-store"],
  },
  {
    kind: "command",
    id: "I3.memoryRebuild",
    owner: "I3",
    title: "Rebuild memory",
    covers: ["C4.memory-rebuild"],
    requires: ["host.memory-store"],
  },
  {
    kind: "command",
    id: "I3.memoryReset",
    owner: "I3",
    title: "Reset memory",
    covers: ["C4.memory-reset"],
    requires: ["host.memory-store"],
  },
  {
    kind: "command",
    id: "I3.memoryStats",
    owner: "I3",
    title: "Show memory stats",
    covers: ["C4.memory-stats"],
    requires: ["host.memory-store"],
  },
  {
    kind: "command",
    id: "I3.memoryView",
    owner: "I3",
    title: "View memory",
    covers: ["C4.memory-view"],
    requires: ["host.memory-store"],
  },
] as const satisfies readonly CommandDescriptor[];

export const DESTRUCTIVE_MEMORY_COMMANDS = new Set<MemoryCommand>(["clear", "reset", "mm-seed"]);

const MEMORY_COMMANDS_WITH_TYPED_SUPPORT = new Set<MemoryCommand>([
  "clear",
  "reset",
  "mm-list",
  "mm-show",
]);

export function requiresMemoryCommandExecutor(command: MemoryCommand): boolean {
  return !MEMORY_COMMANDS_WITH_TYPED_SUPPORT.has(command);
}

export function normalizeMemoryCommand(command: MemoryCommand): MemoryCommand {
  if (command === "rebuild") return "enqueue";
  if (command === "reset") return "clear";
  return command;
}
