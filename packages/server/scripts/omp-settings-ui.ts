#!/usr/bin/env bun
/**
 * Writes the new UI's copy of omp's settings definitions, `apps/ui/src/settings/omp-settings.json`, from the omp this
 * package pins: omp's own settings page (every setting with a `ui` tab, in omp's tab, group and declaration order, as
 * omp's `createSettingsHost` lists them) and the few settings the app shows that omp's page leaves out. Run it after
 * moving to another omp release:
 *
 *   bun packages/server/scripts/omp-settings-ui.ts
 *
 * `omp-settings-ui.test.ts` fails while the file is stale.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { orderedSettings } from "@oh-my-pi/pi-coding-agent/config/all-settings";
import {
  SETTING_TABS,
  TAB_GROUPS,
  TAB_LEADS,
  TAB_METADATA,
} from "@oh-my-pi/pi-tui/overlays/settings-defs";

/** The omp release the definitions come from: the version in the package folder `all-settings` resolves to. */
function ompVersion(): string {
  const settingsFile = Bun.resolveSync(
    "@oh-my-pi/pi-coding-agent/config/all-settings",
    import.meta.dir,
  );
  const packageFile = join(dirname(settingsFile), "../../package.json");
  return (JSON.parse(readFileSync(packageFile, "utf8")) as { version: string }).version;
}
export const OMP_SETTINGS_UI_PATH = join(
  import.meta.dir,
  "../../../apps/ui/src/settings/omp-settings.json",
);

/** A choice of a setting's list, as omp's page offers it. */
interface Choice {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

export interface UiSetting {
  readonly key: string;
  readonly tab: string;
  /** The section within the tab; `null` lists it before the tab's first section. */
  readonly group: string | null;
  readonly type: string;
  readonly label: string;
  readonly description: string;
  /** omp's default; absent when omp has none. */
  readonly default?: unknown;
  /** An enum's values. */
  readonly values?: readonly string[];
  /** The list omp's page picks from (an enum's, a number's, a string's or a list's members). */
  readonly choices?: readonly Choice[];
  /** The only entries a list takes. */
  readonly items?: readonly string[];
  readonly secret?: true;
  /** A list whose order matters. */
  readonly ordered?: true;
  /** Edited as JSON. */
  readonly json?: true;
  /** omp's named condition for showing it (`advisorEnabled`, `hindsightActive`, …). */
  readonly condition?: string;
  /** omp's risk note. */
  readonly warning?: string;
  /** Only omp's terminal reads it (`omp-app tui` included); the app's chats do not. */
  readonly terminalOnly?: true;
}

export interface UiSettings {
  readonly omp: string;
  readonly tabs: readonly {
    readonly id: string;
    readonly label: string;
    readonly lead: string;
    readonly groups: readonly string[];
  }[];
  readonly settings: readonly UiSetting[];
}

/**
 * Settings only omp's terminal reads, decided from omp's source (every reader in the terminal's code or behind its
 * flags). The first 72 are the old settings screen's decisions; the `compaction.idle*` keys (read only by
 * `modes/interactive-mode.ts`) and `branchSummary.enabled` (read only by the terminal's tree selector) were decided
 * at omp 18.12.6; the keys after `branchSummary.enabled` (`tui.colorfulMarkdown`, `tui.maxFps`, `tui.motion`,
 * `tui.spinnerInterval`, `display.advisorCollapsedLines`, `btw.inject`, `composer.predictionAlternatives`,
 * `extensionHandlers.modeControl`, `extensionRenderers.*`, `async.printWake` and `session.worktreeScope`, which only
 * omp's resume pickers read) were decided at omp 18.18.5.
 * `completion.notify` and `error.notify` are not here: omp reads them only in its terminal, and the app
 * reads them too, for the desktop window's notifications (`apps/ui/src/desktop/notify.ts`).
 */
const TERMINAL_ONLY: ReadonlySet<string> = new Set([
  "autocompleteMaxVisible",
  "colorBlindMode",
  "composer.predictions",
  "composer.recallClearedDrafts",
  "composer.shape",
  "composer.tokenRate",
  "display.cacheMissMarker",
  "display.collapseCompacted",
  "display.hideToolActivity",
  "display.pinnedAgents",
  "display.shimmer",
  "display.showTokenUsage",
  "display.showTurnTime",
  "display.smoothStreaming",
  "display.subagentLivePreview",
  "doubleEscapeAction",
  "emojiAutocomplete",
  "expandThinkingBlocks",
  "git.enabled",
  "goal.statusInFooter",
  "hideThinkingBlock",
  "input.bareExitOnEmptySession",
  "input.bareSlashCommands",
  "loop.conditionTimeoutMs",
  "loop.mode",
  "mcp.renderMarkdownResults",
  "paste.largeMenuThreshold",
  "plan.defaultOnStartup",
  "proseOnlyThinking",
  "read.toolResultPreview",
  "recap.enabled",
  "recap.idleSeconds",
  "showHardwareCursor",
  "speech.mode",
  "spelling.autocorrect",
  "spelling.typoDetection",
  "startup.checkUpdate",
  "startup.quiet",
  "startup.setupWizard",
  "startup.showSplash",
  "statusLine.compactThinkingLevel",
  "statusLine.contextLine",
  "statusLine.preset",
  "statusLine.separator",
  "statusLine.sessionAccent",
  "statusLine.showHookStatus",
  "statusLine.transparent",
  "stt.enabled",
  "symbolPreset",
  "task.showResolvedModelBadge",
  "tasks.todoClearDelay",
  "terminal.programStatus",
  "terminal.showImages",
  "terminal.showProgress",
  "treeFilterMode",
  "tui.autoGraph",
  "tui.codexResetFireworks",
  "tui.completeScrollback",
  "tui.hyperlinks",
  "tui.imeSafeCursor",
  "tui.mouse",
  "tui.renderMermaid",
  "tui.renderSvg",
  "tui.resizeScrollback",
  "tui.textSizing",
  "tui.tight",
  "tui.titleSpinner",
  "tui.titleState",
  "tui.vimMode",
  "tui.vimModeDisplay",
  "worktree.onExit",
  "worktree.onStart",
  "compaction.idleEnabled",
  "compaction.idleThresholdTokens",
  "compaction.idleTimeoutSeconds",
  "branchSummary.enabled",
  "tui.colorfulMarkdown",
  "tui.maxFps",
  "tui.motion",
  "tui.spinnerInterval",
  "display.advisorCollapsedLines",
  "btw.inject",
  "composer.predictionAlternatives",
  "extensionHandlers.modeControl",
  "extensionRenderers.assistantText",
  "extensionRenderers.transcriptPresenters",
  "async.printWake",
  "session.worktreeScope",
]);

/**
 * Settings the app does not offer at all, left out of the copy. `update.auto` is omp's self-update (omp 18.17): the
 * app's omp changes with the app's releases, and `omp-app tui` starts omp with it off (`src/launcher/tui.ts`,
 * `TUI_SETTINGS`).
 */
const APP_HIDDEN: ReadonlySet<string> = new Set(["update.auto"]);

/** Conditions on the terminal or the machine (images in the terminal, its renderer, macOS): the app shows the row. */
const TERMINAL_CONDITIONS: ReadonlySet<string> = new Set([
  "hasImageProtocol",
  "nativeRendering",
  "macOS",
]);

/** Settings omp's own page leaves out that the app shows, with where and how. */
const APP_ADDED: Readonly<
  Record<string, { tab: string; group: string; label: string; description: string }>
> = {
  "retry.enabled": {
    tab: "model",
    group: "Retry & Fallback",
    label: "Retries",
    description: "Retry transient provider errors.",
  },
  "retry.baseDelayMs": {
    tab: "model",
    group: "Retry & Fallback",
    label: "Retry Base Delay",
    description: "Initial retry delay in milliseconds.",
  },
  "async.maxJobs": {
    tab: "tools",
    group: "Execution",
    label: "Maximum Concurrent Async Jobs",
    description:
      "Maximum number of asynchronous shell commands and background tasks that may run at once.",
  },
  "task.disabledAgents": {
    tab: "tasks",
    group: "Subagents",
    label: "Disabled Agents",
    description:
      "Prevent selected agent names from being used by future task and evaluation dispatches.",
  },
  "task.agentModelOverrides": {
    tab: "tasks",
    group: "Subagents",
    label: "Agent Model Overrides",
    description: "Set one model selector or an ordered model preference list for each agent.",
  },
  "task.agentServiceTierOverrides": {
    tab: "tasks",
    group: "Subagents",
    label: "Agent Service Tier Overrides",
    description:
      "Choose the service tier for each agent; inherit follows the session's current tier.",
  },
  "task.agentCompactionThresholdOverrides": {
    tab: "tasks",
    group: "Subagents",
    label: "Agent Compaction Threshold Overrides",
    description: "Set a token count or percentage threshold for each agent.",
  },
  "task.agentPrewalk": {
    tab: "tasks",
    group: "Subagents",
    label: "Agent Prewalk Overrides",
    description: "Choose whether an agent hands off to a cheaper model at its first edit.",
  },
  "task.agentAdvisor": {
    tab: "tasks",
    group: "Subagents",
    label: "Agent Advisor Overrides",
    description: "Enable or disable an advisor for an agent, or choose its model.",
  },
  "stt.language": {
    tab: "providers",
    group: "Services",
    label: "Speech Language",
    description: "Language used for speech recognition, for example en.",
  },
};

interface OmpUi {
  readonly tab?: string;
  readonly group?: string;
  readonly label?: string;
  readonly description?: string;
  readonly warning?: string;
  readonly condition?: string;
  readonly options?: readonly Choice[] | "runtime";
  readonly secret?: boolean;
  readonly ordered?: boolean;
  readonly editor?: "json";
}

interface OmpDefinition {
  readonly type: string;
  readonly default?: unknown;
  readonly values?: readonly string[];
  readonly items?: { readonly values: readonly string[] };
}

export function ompSettingsForUi(): UiSettings {
  const all = orderedSettings().filter((setting) => !APP_HIDDEN.has(setting.id));
  const describe = (
    setting: (typeof all)[number],
    place: { tab: string; group: string | null; label: string; description: string },
    ui: OmpUi | undefined,
  ): UiSetting => {
    const definition = setting.definition as OmpDefinition;
    const options = ui?.options;
    const condition = ui?.condition;
    return {
      key: setting.id,
      tab: place.tab,
      group: place.group,
      type: definition.type,
      label: place.label,
      description: place.description,
      ...(definition.default === undefined ? {} : { default: definition.default }),
      ...(definition.values === undefined ? {} : { values: [...definition.values] }),
      ...(Array.isArray(options)
        ? {
            choices: options.map((choice) => ({
              value: choice.value,
              label: choice.label,
              ...(choice.description === undefined ? {} : { description: choice.description }),
            })),
          }
        : {}),
      ...(definition.items === undefined ? {} : { items: [...definition.items.values] }),
      ...(ui?.secret === true || setting.isCredential ? { secret: true as const } : {}),
      ...(ui?.ordered === true ? { ordered: true as const } : {}),
      ...(ui?.editor === "json" ? { json: true as const } : {}),
      ...(condition === undefined || TERMINAL_CONDITIONS.has(condition) ? {} : { condition }),
      ...(ui?.warning === undefined ? {} : { warning: ui.warning }),
      ...(TERMINAL_ONLY.has(setting.id) ? { terminalOnly: true as const } : {}),
    };
  };

  const settings: UiSetting[] = [];
  for (const tab of SETTING_TABS) {
    for (const setting of all) {
      const ui = setting.ui as OmpUi | undefined;
      if (ui?.tab === tab) {
        settings.push(
          describe(
            setting,
            {
              tab,
              group: ui.group ?? null,
              label: ui.label ?? setting.id,
              description: ui.description ?? "",
            },
            ui,
          ),
        );
      } else if (ui?.tab === undefined) {
        const added = APP_ADDED[setting.id];
        if (added?.tab === tab) settings.push(describe(setting, added, undefined));
      }
    }
  }
  const missing = Object.keys(APP_ADDED).filter((key) => !settings.some((one) => one.key === key));
  if (missing.length > 0)
    throw new Error(`omp no longer has these settings: ${missing.join(", ")}`);
  return {
    omp: ompVersion(),
    tabs: SETTING_TABS.map((id) => ({
      id,
      label: TAB_METADATA[id].label,
      lead: TAB_LEADS[id],
      groups: [...TAB_GROUPS[id]],
    })),
    settings,
  };
}

if (import.meta.main) {
  await Bun.write(OMP_SETTINGS_UI_PATH, `${JSON.stringify(ompSettingsForUi(), null, 2)}\n`);
  console.log(`Wrote ${OMP_SETTINGS_UI_PATH}`);
}
