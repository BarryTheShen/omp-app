import type { ShortcutDescriptor } from "@omp-app/contracts";

type EditableShortcutDescriptor = ShortcutDescriptor & { readonly allowInEditable: true };

/**
 * Model and thinking chords from omp v18.9.1 (`packages/tui/src/app-keybindings.ts:109-131`). omp runs
 * them while the editor has focus, so each one is `allowInEditable`.
 *
 * Not offered:
 * - `app.model.cycleBackward` (Shift+Ctrl+P): omp's `cycle_model` RPC takes no direction
 *   (`packages/coding-agent/src/modes/rpc/rpc-mode.ts:2275-2280` at v18.9.1), so the app cannot run it.
 *   Its inventory row is recorded as `not-offered` in `fixtures/index.ts`.
 *
 * Changed:
 * - `app.thinking.cycle` defaults to Shift+Tab, which the browser uses to move focus
 *   (`FOCUS_NAVIGATION_CHORDS`). Its replacement is Alt+K: Alt+T is U1's transcript "Toggle thinking",
 *   Shift+Alt+T is Chrome's "focus the first toolbar item" (Chrome help page, Windows and Linux table), and
 *   neither that page nor a third-party copy of Firefox's key list (checked 2026-10-12) names Alt+K.
 */
export const D1_SHORTCUT_DESCRIPTORS = [
  {
    id: "D1.appModelCycleForward",
    owner: "D1",
    title: "Cycle model forward",
    kind: "shortcut",
    scope: "global",
    chord: "Mod+P",
    allowInEditable: true,
    covers: ["D1.app-model-cycleforward"],
    requires: ["omp.cmd.cycle_model"],
  },
  {
    id: "D1.appModelSelect",
    owner: "D1",
    title: "Open model selector",
    kind: "shortcut",
    chord: "Alt+M",
    scope: "global",
    allowInEditable: true,
    covers: ["D1.app-model-select"],
    requires: ["omp.cmd.set_model"],
  },
  {
    id: "D1.appModelSelectTemporary",
    owner: "D1",
    title: "Pick a model for this chat only",
    kind: "shortcut",
    chord: "Alt+P",
    scope: "global",
    allowInEditable: true,
    covers: ["D1.app-model-selecttemporary"],
    requires: ["omp.cmd.set_model"],
  },
  {
    id: "D1.appThinkingCycle",
    owner: "D1",
    title: "Cycle thinking level",
    kind: "shortcut",
    chord: "Alt+K",
    scope: "global",
    allowInEditable: true,
    covers: ["D1.app-thinking-cycle"],
    requires: ["omp.cmd.cycle_thinking_level"],
  },
] as const satisfies readonly EditableShortcutDescriptor[];
