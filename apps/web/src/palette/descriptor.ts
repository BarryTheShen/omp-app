import type { CommandDescriptor, ShortcutDescriptor } from "@omp-app/contracts";

export const U0_COMMAND_PALETTE_SHORTCUT = {
  kind: "shortcut",
  id: "U0.commandPalette",
  owner: "U0",
  title: "Open command palette",
  covers: [],
  requires: [],
  chord: "Mod+K",
  scope: "global",
  allowInEditable: true,
} as const satisfies ShortcutDescriptor & { readonly allowInEditable: true };

/** The palette command that saves the app's debug log as a file to attach to a bug report. */
export const U0_SAVE_DEBUG_LOG_COMMAND = {
  kind: "command",
  id: "U0.saveDebugLog",
  owner: "U0",
  title: "Save debug log",
  covers: [],
  requires: [],
} as const satisfies CommandDescriptor;

/** The palette command that opens the model and thinking-level dialog, the same one the header's model button opens. */
export const U0_MODEL_COMMAND = {
  kind: "command",
  id: "U0.modelAndThinking",
  owner: "U0",
  title: "Model and thinking level",
  covers: [],
  requires: ["omp.cmd.get_available_models", "omp.cmd.set_model"],
} as const satisfies CommandDescriptor;

/** The palette commands that set the theme: the same three choices as the sidebar's Theme buttons. */
const U0_THEME_COMMANDS = [
  {
    kind: "command",
    id: "U0.themeSystem",
    owner: "U0",
    title: "Use the system theme",
    covers: [],
    requires: [],
  },
  {
    kind: "command",
    id: "U0.themeLight",
    owner: "U0",
    title: "Use the light theme",
    covers: [],
    requires: [],
  },
  {
    kind: "command",
    id: "U0.themeDark",
    owner: "U0",
    title: "Use the dark theme",
    covers: [],
    requires: [],
  },
] as const satisfies readonly CommandDescriptor[];

/** The palette command that opens the keyboard shortcut sheet; omp's `/hotkeys` lists the same chords. */
export const U0_SHORTCUT_SHEET_COMMAND = {
  kind: "command",
  id: "U0.shortcutSheet",
  owner: "U0",
  title: "Keyboard shortcuts",
  covers: ["D6.hotkeys"],
  requires: [],
} as const satisfies CommandDescriptor;

/**
 * The palette's goal commands. Each runs the same operation as the typed `/goal` form, and needs omp's `goal` command.
 */
export const U0_GOAL_COMMANDS = [
  {
    kind: "command",
    id: "U0.goalShow",
    owner: "U0",
    title: "Show goal",
    covers: [],
    requires: ["omp.cmd.goal"],
  },
  {
    kind: "command",
    id: "U0.goalPause",
    owner: "U0",
    title: "Pause goal",
    covers: [],
    requires: ["omp.cmd.goal"],
  },
  {
    kind: "command",
    id: "U0.goalResume",
    owner: "U0",
    title: "Resume goal",
    covers: [],
    requires: ["omp.cmd.goal"],
  },
  {
    kind: "command",
    id: "U0.goalDrop",
    owner: "U0",
    title: "Drop goal",
    covers: [],
    requires: ["omp.cmd.goal"],
  },
] as const satisfies readonly CommandDescriptor[];

/** The typed `/goal` form, which the shortcut sheet lists under Typed commands. */
export const U0_GOAL_TYPED_COMMAND = {
  text: "/goal",
  title: "Show, set, pause, resume or drop the goal",
} as const;

/** Every palette command the U0 part owns; the composed registry lists them (`registry/index.ts`). */
export const U0_PALETTE_COMMANDS = [
  U0_MODEL_COMMAND,
  U0_SHORTCUT_SHEET_COMMAND,
  ...U0_GOAL_COMMANDS,
  ...U0_THEME_COMMANDS,
] as const;
