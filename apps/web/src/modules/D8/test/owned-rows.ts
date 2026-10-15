/**
 * The inventory rows D8 owns. `research/modules/D8.md:9-11` lists these 18 ids; its heading says "17 C3 rows", and the
 * row the heading leaves out is C3.ratchet. `packages/contracts/src/core/modules.ts:1197-1204` decides `/ratchet` for D8.
 * The inventory's `group: "D8"` rows (`D8.live-voice`, `D8.speech-to-text-push-to-talk`) are not here:
 * `research/modules/I5.md:11-12` gives them to I5.
 */
export const D8_OWNED_ROWS: readonly string[] = [
  "C3.goal",
  "C3.goal-launch-flag",
  "C3.guided-goal",
  "C3.loop",
  "C3.tan",
  "C3.vibe",
  "C3.ratchet",
  "C3.goal-budget",
  "C3.goal-drop",
  "C3.goal-pause",
  "C3.goal-resume",
  "C3.goal-set",
  "C3.goal-show",
  "C3.goal-updated",
  "C3.goal-mode",
  "C3.guided-goal-interview",
  "C3.loop-mode",
  "C3.vibe-mode",
];
