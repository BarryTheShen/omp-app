import type {
  CapabilityKey,
  CommandDescriptor,
  Descriptor,
  DialogDescriptor,
  PanelDescriptor,
  StatusDescriptor,
} from "@omp-app/contracts";
import { D8_AP6_CAPABILITIES, type GoalOperation } from "../contract";
import { LOOP_CAPABILITY } from "../loop/gate";

/**
 * Released omp RPC capabilities D8 uses. `omp.cmd.goal` carries get, create, pause, resume and drop;
 * `omp.subagent-events` carries the worker frames the workers panels read; `host.command-gateway` is
 * the A1 gateway that runs `/ratchet`.
 */
export const D8_RELEASED_CAPABILITIES = {
  goal: "omp.cmd.goal",
  subagentEvents: "omp.subagent-events",
  commandGateway: "host.command-gateway",
} as const satisfies Record<string, CapabilityKey>;

/** The capability that carries each released goal operation (the contract's `GoalOperationSchema`). */
export const D8_GOAL_OPERATION_CAPABILITY = {
  get: D8_RELEASED_CAPABILITIES.goal,
  create: D8_RELEASED_CAPABILITIES.goal,
  resume: D8_RELEASED_CAPABILITIES.goal,
  pause: D8_RELEASED_CAPABILITIES.goal,
  drop: D8_RELEASED_CAPABILITIES.goal,
} as const satisfies Record<GoalOperation, CapabilityKey>;

const GOAL = D8_RELEASED_CAPABILITIES.goal;
const SUBAGENT_EVENTS = D8_RELEASED_CAPABILITIES.subagentEvents;

/**
 * Command rows. Only `/ratchet` is an omp slash command that omp's RPC catalog lists (the recorded catalog in D2's
 * fixtures). omp runs `/goal`, `/guided-goal`, `/loop`, `/tan` and `/vibe` only in its terminal (`handleTui` only:
 * omp v18.12.6 `builtin-modes.ts:360-448` and `builtin-lifecycle.ts:463-471`), so those rows claim no slash name. The goal
 * subcommands and the `--goal` launch flag have no slash either.
 */
export const D8_COMMAND_DESCRIPTORS = [
  {
    kind: "command",
    id: "D8.goalCommand",
    owner: "D8",
    title: "Manage a goal",
    covers: ["C3.goal"],
    requires: [GOAL],
  },
  {
    kind: "command",
    id: "D8.goalLaunchFlag",
    owner: "D8",
    title: "Start with a goal",
    covers: ["C3.goal-launch-flag"],
    requires: [D8_AP6_CAPABILITIES.goalLaunch],
  },
  {
    kind: "command",
    id: "D8.guidedGoalCommand",
    owner: "D8",
    title: "Guided goal",
    covers: ["C3.guided-goal"],
    requires: [D8_GOAL_OPERATION_CAPABILITY.create],
  },
  {
    kind: "command",
    id: "D8.loopCommand",
    owner: "D8",
    title: "Loop",
    covers: ["C3.loop"],
    requires: [LOOP_CAPABILITY],
  },
  {
    kind: "command",
    id: "D8.tanCommand",
    owner: "D8",
    title: "Start a side-task worker",
    covers: ["C3.tan"],
    requires: [D8_AP6_CAPABILITIES.tanDispatch],
  },
  {
    kind: "command",
    id: "D8.vibeCommand",
    owner: "D8",
    title: "Start persistent workers",
    covers: ["C3.vibe"],
    requires: [D8_AP6_CAPABILITIES.vibeWorker],
  },
  {
    kind: "command",
    id: "D8.ratchetCommand",
    owner: "D8",
    title: "Improve a workflow automatically",
    covers: ["C3.ratchet"],
    requires: [D8_RELEASED_CAPABILITIES.commandGateway],
    slash: { name: "ratchet", source: "builtin" },
  },
  {
    kind: "command",
    id: "D8.goalShow",
    owner: "D8",
    title: "Show goal",
    covers: ["C3.goal-show"],
    requires: [D8_GOAL_OPERATION_CAPABILITY.get],
  },
  {
    kind: "command",
    id: "D8.goalPause",
    owner: "D8",
    title: "Pause goal",
    covers: ["C3.goal-pause"],
    requires: [D8_GOAL_OPERATION_CAPABILITY.pause],
  },
  {
    kind: "command",
    id: "D8.goalResume",
    owner: "D8",
    title: "Resume goal",
    covers: ["C3.goal-resume"],
    requires: [D8_GOAL_OPERATION_CAPABILITY.resume],
  },
] as const satisfies readonly CommandDescriptor[];

/**
 * Namespace panels for `/goal`, `/tan` and `/vibe`. Their inventory rows are covered by the command and
 * status descriptors above, so each row has one owner.
 */
export const D8_PANEL_DESCRIPTORS = [
  {
    kind: "panel",
    id: "D8.goal",
    owner: "D8",
    title: "Goal",
    covers: [],
    requires: [GOAL],
  },
  {
    kind: "panel",
    id: "D8.tan",
    owner: "D8",
    title: "Side-task workers",
    covers: [],
    requires: [SUBAGENT_EVENTS],
  },
  {
    kind: "panel",
    id: "D8.vibe",
    owner: "D8",
    title: "Persistent workers",
    covers: [],
    requires: [SUBAGENT_EVENTS],
  },
] as const satisfies readonly PanelDescriptor[];

/** The mode and notification rows the inventory shows as status chips. */
export const D8_STATUS_DESCRIPTORS = [
  {
    kind: "status",
    id: "D8.goalStatus",
    owner: "D8",
    title: "Goal status",
    covers: ["C3.goal-mode", "C3.goal-updated"],
    requires: [GOAL],
  },
  {
    kind: "status",
    id: "D8.loopStatus",
    owner: "D8",
    title: "Loop status",
    covers: ["C3.loop-mode"],
    requires: [LOOP_CAPABILITY],
  },
  {
    kind: "status",
    id: "D8.vibeStatus",
    owner: "D8",
    title: "Persistent worker status",
    covers: ["C3.vibe-mode"],
    requires: [D8_AP6_CAPABILITIES.vibeWorker],
  },
] as const satisfies readonly StatusDescriptor[];

/** Dialogs: the destructive drop, the edit and budget dialogs (AP6), and the guided interview. */
export const D8_DIALOG_DESCRIPTORS = [
  {
    kind: "dialog",
    id: "D8.goalDrop",
    owner: "D8",
    title: "Drop goal",
    covers: ["C3.goal-drop"],
    requires: [D8_GOAL_OPERATION_CAPABILITY.drop],
  },
  {
    kind: "dialog",
    id: "D8.goalSet",
    owner: "D8",
    title: "Edit goal",
    covers: ["C3.goal-set"],
    requires: [D8_AP6_CAPABILITIES.goalUpdate],
  },
  {
    kind: "dialog",
    id: "D8.goalBudget",
    owner: "D8",
    title: "Change goal budget",
    covers: ["C3.goal-budget"],
    requires: [D8_AP6_CAPABILITIES.goalUpdate],
  },
  {
    kind: "dialog",
    id: "D8.guidedGoalInterview",
    owner: "D8",
    title: "Guided goal interview",
    covers: ["C3.guided-goal-interview"],
    requires: [D8_GOAL_OPERATION_CAPABILITY.create],
  },
] as const satisfies readonly DialogDescriptor[];

export const D8_DESCRIPTORS = [
  ...D8_COMMAND_DESCRIPTORS,
  ...D8_PANEL_DESCRIPTORS,
  ...D8_STATUS_DESCRIPTORS,
  ...D8_DIALOG_DESCRIPTORS,
] as const satisfies readonly Descriptor[];

export type D8Descriptor = (typeof D8_DESCRIPTORS)[number];
