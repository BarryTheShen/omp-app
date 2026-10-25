import { describe, expect, test } from "vitest";
import { P7_CONTEXT_SETTINGS_SECTIONS } from "@/modules/P7/settings";
import { SETTINGS_SECTIONS } from "@/registry";

/**
 * Every entry is a source decision from omp v18.9.1: the reader is in the interactive/TUI path,
 * or a main.ts branch guarded by `isInteractive`; no reader runs for --mode rpc. Shared readers
 * in AgentSession, session/tools code, and rpc-mode are deliberately absent.
 */
const TERMINAL_ONLY_SOURCES: Readonly<Record<string, string>> = {
  symbolPreset: "modes/settings.ts effect; main.ts initTheme under interactive startup",
  colorBlindMode: "modes/settings.ts effect; main.ts initTheme under interactive startup",
  "composer.shape": "modes/settings.ts effect; interactive composer",
  "composer.tokenRate": "modes/interactive-mode.ts",
  "statusLine.preset": "modes/status-line-host.ts",
  "statusLine.separator": "modes/status-line-host.ts",
  "statusLine.contextLine": "modes/status-line-host.ts",
  "statusLine.sessionAccent": "modes/status-line-host.ts",
  "statusLine.transparent": "modes/status-line-host.ts",
  "statusLine.compactThinkingLevel": "modes/status-line-host.ts",
  "statusLine.showHookStatus": "modes/status-line-host.ts",
  "tui.resizeScrollback": "main.ts prepaint composer; interactive TUI",
  "tui.completeScrollback":
    "v18.12.6 main.ts:2025 prepaint composer (startup-composer.ts:114-121) and modes/interactive-mode.ts:438,3624; interactive TUI",
  "terminal.showProgress": "modes/controllers/event-controller.ts",
  "terminal.programStatus": "modes/interactive-mode.ts",
  "tui.renderMermaid": "sdk.ts:3955 gated by tuiTranscript=false in rpc-ui; terminal only",
  "tui.renderSvg": "sdk.ts:3956 gated by tuiTranscript=false in rpc-ui; terminal only",
  "tui.autoGraph": "sdk.ts:3957 gated by tuiTranscript=false in rpc-ui; terminal only",
  "tui.textSizing": "modes/interactive-mode.ts",
  "tui.codexResetFireworks": "modes/status-line-host.ts",
  "tui.titleState": "modes/interactive-mode.ts",
  "tui.titleSpinner": "modes/interactive-mode.ts",
  "tui.hyperlinks": "modes/interactive-mode.ts and terminal link effect",
  "tui.mouse": "modes/controllers/input-controller.ts",
  "tui.tight": "modes/interactive-mode.ts",
  "display.shimmer": "modes/settings.ts terminal shimmer effect",
  "display.pinnedAgents": "modes/interactive-mode.ts",
  "display.subagentLivePreview": "modes/interactive-mode.ts",
  "display.smoothStreaming": "modes/controllers/event-controller.ts",
  "display.hideToolActivity": "modes/controllers/input-controller.ts",
  "display.showTokenUsage": "modes/controllers/event-controller.ts and modes/utils/ui-helpers.ts",
  "display.showTurnTime": "modes/controllers/event-controller.ts and modes/utils/ui-helpers.ts",
  "display.cacheMissMarker": "modes/controllers/event-controller.ts and modes/utils/ui-helpers.ts",
  "display.collapseCompacted": "modes/utils/ui-helpers.ts",
  showHardwareCursor: "main.ts prepaint composer; interactive TUI",
  "tui.imeSafeCursor": "main.ts prepaint composer; interactive TUI",
  "task.showResolvedModelBadge": "modes/settings.ts terminal feed badge effect",
  "terminal.showImages": "modes/controllers/event-controller.ts and ui-helpers.ts",
  "tui.vimMode": "modes/interactive-mode.ts",
  "tui.vimModeDisplay": "modes/interactive-mode.ts",
  "loop.mode": "modes/interactive-mode.ts",
  "loop.conditionTimeoutMs": "modes/interactive-mode.ts",
  "composer.predictions": "modes/controllers/composer-prediction-controller.ts",
  "composer.recallClearedDrafts": "modes/utils/ui-helpers.ts",
  doubleEscapeAction: "modes/controllers/input-controller.ts",
  "input.bareExitOnEmptySession": "modes/controllers/input-controller.ts",
  "input.bareSlashCommands": "modes/controllers/input-controller.ts",
  treeFilterMode: "modes/controllers/selector-controller.ts",
  autocompleteMaxVisible: "main.ts prepaint composer guarded by cli.ts interactive TTY",
  "spelling.typoDetection": "main.ts prepaint composer guarded by cli.ts interactive TTY",
  "spelling.autocorrect": "main.ts prepaint composer guarded by cli.ts interactive TTY",
  emojiAutocomplete: "modes/controllers/input-controller.ts",
  "paste.largeMenuThreshold": "modes/controllers/input-controller.ts",
  "tasks.todoClearDelay": "modes/interactive-mode.ts",
  "worktree.onStart": "modes/interactive-mode.ts",
  "worktree.onExit": "modes/interactive-mode.ts",
  "goal.statusInFooter": "modes/status-line-host.ts",
  "plan.defaultOnStartup": "modes/interactive-mode.ts and modes/print-mode.ts, not rpc",
  hideThinkingBlock: "modes/interactive-mode.ts and modes/controllers/input-controller.ts",
  expandThinkingBlocks: "modes/interactive-mode.ts and modes/controllers/selector-controller.ts",
  proseOnlyThinking: "modes/interactive-mode.ts terminal rendering",
  "completion.notify": "modes/controllers/event-controller.ts",
  "error.notify": "modes/controllers/event-controller.ts",
  "recap.enabled": "modes/interactive-mode.ts",
  "recap.idleSeconds": "modes/interactive-mode.ts",
  "git.enabled": "modes/status-line-host.ts and modes/interactive-mode.ts",
  "read.toolResultPreview": "modes/controllers/event-controller.ts and modes/utils/ui-helpers.ts",
  "speech.mode": "modes/controllers/event-controller.ts",
  "stt.enabled": "modes/interactive-mode.ts",
  "startup.quiet": "main.ts interactive startup output",
  "startup.showSplash": "main.ts shouldShowStartupSplash receives isInteractive",
  "startup.setupWizard": "main.ts setup scene selection is interactive-only",
  "startup.checkUpdate": "main.ts version check is created only in isInteractive branch",
  "mcp.renderMarkdownResults": "mcp/settings.ts effect into pi-tui's MCP renderer; terminal only",
};

const ALL_SECTIONS = [...SETTINGS_SECTIONS, ...P7_CONTEXT_SETTINGS_SECTIONS];
const ALL_CONTROLS = ALL_SECTIONS.flatMap((section) => section.controls);

describe("Terminal-only settings wording", () => {
  test("matches every registered settings control in every settings module", () => {
    const controls = new Map(ALL_CONTROLS.map((control) => [control.key, control] as const));
    for (const [key, source] of Object.entries(TERMINAL_ONLY_SOURCES)) {
      const control = controls.get(key);
      expect(control, `${key}: ${source}`).toBeDefined();
      expect(control?.description ?? "", `${key}: ${source}`).toMatch(/^Terminal only\./);
    }
    for (const control of ALL_CONTROLS) {
      const saysTerminalOnly = control.description?.startsWith("Terminal only.") ?? false;
      expect(
        Object.hasOwn(TERMINAL_ONLY_SOURCES, control.key),
        `${control.key} has terminal-only wording without a source decision`,
      ).toBe(saysTerminalOnly);
    }
  });
});
