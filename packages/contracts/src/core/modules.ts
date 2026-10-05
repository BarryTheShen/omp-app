/**
 * The 42 modules of PLAN.md and who owns what: repository paths, omp setting sections, slash
 * commands and panels.
 *
 * The module table mirrors PLAN.md, "Modules (42)"; a test compares the two. Namespace ownership
 * is derived from the module headers (`modules/<id>/README.md`): every claim cites the header
 * text it rests on, and a test checks each quote against the header. Where two headers claimed
 * the same namespace, or no header named something omp 18.6.1 added, the main agent decided the
 * owner on 2026-10-04 and the claim also cites that decision. A namespace found contested later
 * is recorded as `contested` until the main agent decides it; `validateRegistry` accepts no
 * registration there meanwhile.
 */
import { z } from "zod";

export const MODULE_IDS = [
  "C0",
  "A0",
  "A1",
  "R0",
  "R1",
  "U0",
  "U1",
  "U2",
  "U3",
  "U4",
  "U5",
  "T1",
  "T2",
  "T3",
  "T4",
  "T5",
  "T6",
  "T7",
  "P1",
  "P2",
  "P3",
  "P4",
  "P5",
  "P6",
  "P7",
  "D1",
  "D2",
  "D3",
  "D4",
  "D5",
  "D6",
  "D7",
  "D8",
  "I1",
  "I2",
  "I3",
  "I4",
  "I5",
  "N1",
  "S1",
  "S2",
  "S3",
] as const;
export const ModuleId = z.enum(MODULE_IDS);
export type ModuleId = z.infer<typeof ModuleId>;

export const WAVES = ["W0", "W1", "W2", "W3", "W4", "W5", "W6", "W7", "W8"] as const;
export type Wave = (typeof WAVES)[number];
export type ModuleSize = "S" | "M" | "L";

export interface ModuleInfo {
  readonly id: ModuleId;
  readonly name: string;
  readonly wave: Wave;
  readonly size: ModuleSize;
  readonly needs: readonly ModuleId[];
}

/** PLAN.md, "Modules (42)", in its order. */
export const MODULES: readonly ModuleInfo[] = [
  {
    id: "C0",
    name: "Shared contracts and capability descriptors",
    wave: "W0",
    size: "S",
    needs: [],
  },
  {
    id: "A0",
    name: "omp RPC transport and recorded-fixture harness",
    wave: "W1",
    size: "L",
    needs: ["C0"],
  },
  {
    id: "A1",
    name: "omp server bridge and direct stores",
    wave: "W1",
    size: "L",
    needs: ["C0", "A0"],
  },
  {
    id: "R0",
    name: "ExternalStoreRuntime and omp message adapter",
    wave: "W2",
    size: "L",
    needs: ["C0", "A0"],
  },
  {
    id: "R1",
    name: "Remote thread list and per-folder session catalog",
    wave: "W3",
    size: "L",
    needs: ["C0", "A0", "A1", "R0"],
  },
  {
    id: "U0",
    name: "App shell, design tokens, registries, and keymap surface",
    wave: "W1",
    size: "L",
    needs: ["C0"],
  },
  {
    id: "U1",
    name: "Transcript and message-part core",
    wave: "W3",
    size: "L",
    needs: ["C0", "R0", "U0"],
  },
  {
    id: "U2",
    name: "Composer, attachments, input modes, and durable drafts",
    wave: "W3",
    size: "L",
    needs: ["C0", "R0", "A1", "U0"],
  },
  {
    id: "U3",
    name: "Tool-card core and bash exemplar",
    wave: "W3",
    size: "M",
    needs: ["C0", "U0", "U1"],
  },
  {
    id: "U4",
    name: "Dialog, extension-UI, and approval core",
    wave: "W3",
    size: "M",
    needs: ["C0", "A0", "U0"],
  },
  { id: "U5", name: "Panel and todo core", wave: "W3", size: "M", needs: ["C0", "R0", "U0"] },
  { id: "T1", name: "File-operation tool cards", wave: "W4", size: "M", needs: ["C0", "A0", "U3"] },
  {
    id: "T2",
    name: "Search and code-intelligence tool cards",
    wave: "W4",
    size: "M",
    needs: ["C0", "A0", "U3"],
  },
  {
    id: "T3",
    name: "Execution and computer tool cards",
    wave: "W4",
    size: "M",
    needs: ["C0", "A0", "U3"],
  },
  {
    id: "T4",
    name: "Web, browser, and GitHub tool cards",
    wave: "W4",
    size: "M",
    needs: ["C0", "A0", "U3"],
  },
  {
    id: "T5",
    name: "Agent, hub, task, yield, and vibe tool cards",
    wave: "W4",
    size: "M",
    needs: ["C0", "A0", "U3"],
  },
  {
    id: "T6",
    name: "Memory and learning tool cards",
    wave: "W4",
    size: "S",
    needs: ["C0", "A0", "U3"],
  },
  {
    id: "T7",
    name: "Miscellaneous, host, MCP, security, goal, and checkpoint tool cards",
    wave: "W4",
    size: "M",
    needs: ["C0", "A0", "U3"],
  },
  {
    id: "P1",
    name: "Agent roster, live transcripts, and advisor observability",
    wave: "W5",
    size: "L",
    needs: ["C0", "A0", "R0", "U1", "U3", "U4"],
  },
  {
    id: "P2",
    name: "Plan mode and plan review",
    wave: "W5",
    size: "M",
    needs: ["A0", "A1", "R0", "U1", "U4", "U5"],
  },
  {
    id: "P3",
    name: "Message editing, regeneration, and assistant-ui branching",
    wave: "W5",
    size: "M",
    needs: ["A0", "R0", "U1", "U2", "U4"],
  },
  {
    id: "P4",
    name: "Durable session tree, fork, and history navigation",
    wave: "W6",
    size: "M",
    needs: ["A0", "A1", "R1", "U1", "U4"],
  },
  {
    id: "P5",
    name: "Workspace checkpoints and rewind",
    wave: "W7",
    size: "L",
    needs: ["A1", "P4", "P3", "U1", "U4", "U5"],
  },
  { id: "P6", name: "Queue and steering", wave: "W5", size: "M", needs: ["A0", "R0", "U2", "U4"] },
  {
    id: "P7",
    name: "Context, compaction, usage, and command exemplar",
    wave: "W5",
    size: "L",
    needs: ["A0", "A1", "R0", "U0", "U1", "U5"],
  },
  {
    id: "D1",
    name: "Model, thinking, and persisted model settings",
    wave: "W5",
    size: "M",
    needs: ["A0", "A1", "U0", "U4"],
  },
  {
    id: "D2",
    name: "Composer triggers, slash commands, mentions, and autocomplete",
    wave: "W5",
    size: "M",
    needs: ["A0", "A1", "U0", "U2", "U4"],
  },
  {
    id: "D3",
    name: "Authentication, provider flows, and provider settings",
    wave: "W5",
    size: "L",
    needs: ["A0", "A1", "U0", "U4"],
  },
  {
    id: "D4",
    name: "Copy, export, share, and transcript actions",
    wave: "W5",
    size: "M",
    needs: ["A1", "U0", "U1", "U4"],
  },
  {
    id: "D5",
    name: "Session and project command surfaces",
    wave: "W5",
    size: "M",
    needs: ["A0", "A1", "R0", "R1", "U0", "U4"],
  },
  {
    id: "D6",
    name: "Diagnostics, security, and operational side panels",
    wave: "W5",
    size: "L",
    needs: ["A0", "A1", "R0", "U0", "U1", "U4", "U5", "P1"],
  },
  {
    id: "D7",
    name: "Execution modes and session controls",
    wave: "W5",
    size: "M",
    needs: ["A0", "A1", "R0", "U0", "U4", "U5"],
  },
  {
    id: "D8",
    name: "Autonomy, goals, loops, and persistent workers",
    wave: "W5",
    size: "M",
    needs: ["A0", "A1", "R0", "U0", "U4", "U5", "P1"],
  },
  {
    id: "I1",
    name: "MCP management and MCP-specific settings",
    wave: "W5",
    size: "M",
    needs: ["A0", "A1", "U0", "U4"],
  },
  {
    id: "I2",
    name: "Extensions, plugins, and marketplace",
    wave: "W5",
    size: "M",
    needs: ["A0", "A1", "U0", "U4"],
  },
  {
    id: "I3",
    name: "Memory, rules, and learning management",
    wave: "W5",
    size: "M",
    needs: ["A0", "A1", "U0", "U1", "U4"],
  },
  {
    id: "I4",
    name: "Collaboration and shared sessions",
    wave: "W5",
    size: "M",
    needs: ["A0", "A1", "R0", "U0", "U1", "U4"],
  },
  {
    id: "I5",
    name: "Voice, speech, and dictation",
    wave: "W5",
    size: "M",
    needs: ["A0", "R0", "U0", "U2", "U4"],
  },
  {
    id: "N1",
    name: "Feedback chrome: notifications and status",
    wave: "W5",
    size: "M",
    needs: ["A0", "A1", "R0", "U0", "U1", "P1"],
  },
  {
    id: "S1",
    name: "Appearance and interaction settings",
    wave: "W5",
    size: "M",
    needs: ["A1", "U0", "U4"],
  },
  { id: "S2", name: "Files and shell settings", wave: "W5", size: "M", needs: ["A1", "U0", "U4"] },
  {
    id: "S3",
    name: "Tools and task-policy settings",
    wave: "W5",
    size: "M",
    needs: ["A1", "U0", "U4", "P1", "T1", "T2", "T3", "T4", "T5", "T7"],
  },
];

// Repository paths

/** A module, or `main`: the main agent (the build chat named in AI-README.md). */
export type Owner = ModuleId | "main";

export interface PathRule {
  /** Repository-relative; a trailing `/` covers the whole folder. `<ModuleId>` and `<name>` match one segment. */
  readonly path: string;
  /** `<ModuleId>`: the module named by that segment of the path. */
  readonly owner: Owner | "<ModuleId>";
  readonly note?: string;
}

/**
 * Who may edit what; the first matching rule wins. A module edits only what it owns, plus its own
 * header, and may add dependencies to the `package.json` of the package it lives in. Copied or
 * generated files are refreshed by their script, never edited by hand.
 */
export const PATH_OWNERSHIP: readonly PathRule[] = [
  { path: "packages/contracts/src/ports/<ModuleId>/", owner: "<ModuleId>" },
  { path: "packages/contracts/src/index.ts", owner: "main", note: "the barrel" },
  {
    path: "packages/contracts/src/omp-wire/",
    owner: "C0",
    note: "copied from omp; refresh with scripts/sync-omp-wire.ts",
  },
  {
    path: "packages/contracts/src/core/inventory.json",
    owner: "C0",
    note: "generated by scripts/build-inventory.ts",
  },
  {
    path: "packages/contracts/",
    owner: "C0",
    note: "src/core/ is frozen after W0; later changes go through the main agent",
  },
  { path: "packages/server/src/registry/", owner: "main" },
  { path: "apps/web/src/registry/", owner: "main" },
  { path: "packages/<name>/src/modules/<ModuleId>/", owner: "<ModuleId>" },
  { path: "apps/<name>/src/modules/<ModuleId>/", owner: "<ModuleId>" },
  {
    path: "packages/omp-rpc/",
    owner: "A0",
    note: "isomorphic RPC core: JSONL/v2 framing, correlation, event normalization, fixture replay; runs in Bun and in browser tests",
  },
  {
    path: "packages/client/",
    owner: "A0",
    note: "isomorphic client of the omp-app/1 envelope: WebSocket, reconnect and resume, typed port proxies; used by the web app and by Bun tests",
  },
  {
    path: "packages/server/",
    owner: "A0",
    note: "the server shell: entrypoint, HTTP/WebSocket, dispatcher; A1's stores live in src/modules/A1/",
  },
  {
    path: "apps/web/src/components/",
    owner: "U0",
    note: "copied assistant-ui and shadcn components",
  },
  {
    path: "apps/web/",
    owner: "U0",
    note: "the shell: Vite config, entry, AppShell, tokens",
  },
  {
    path: "modules/<ModuleId>/",
    owner: "<ModuleId>",
    note: "the module header; its lead edits it within AGENTS.md and lists every change",
  },
  { path: "AGENTS.md", owner: "main", note: "only with the owner's approval" },
  { path: "AI-README.md", owner: "main" },
  { path: "PLAN.md", owner: "main" },
  { path: "research/", owner: "main" },
  { path: "package.json", owner: "main" },
  { path: "tsconfig.base.json", owner: "main" },
  { path: "biome.json", owner: "main" },
  { path: ".gitignore", owner: "main" },
  { path: "bun.lock", owner: "main" },
];

const PATH_RULE_PATTERNS = PATH_OWNERSHIP.map((rule) => {
  const body = rule.path
    .split(/(<ModuleId>|<name>)/)
    .map((part) => {
      if (part === "<ModuleId>") return `(${MODULE_IDS.join("|")})`;
      if (part === "<name>") return "[^/]+";
      return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("");
  return { rule, pattern: new RegExp(`^${body}${rule.path.endsWith("/") ? "" : "$"}`) };
});

/** The owner of a repository-relative path, or undefined when no rule covers it. */
export function ownerOfPath(path: string): Owner | undefined {
  const relative = path.replace(/^\.\//, "");
  for (const { rule, pattern } of PATH_RULE_PATTERNS) {
    const match = pattern.exec(relative);
    if (match === null) continue;
    return rule.owner === "<ModuleId>" ? ModuleId.parse(match[1]) : rule.owner;
  }
  return undefined;
}

// omp setting sections

/**
 * omp's settings tabs and the sections in each, in panel order (omp v18.6.1,
 * packages/tui/src/overlays/settings-defs.ts:4-31 and 66-102). Every setting with UI metadata
 * declares one tab and section; settings without it are config-file only and have no section.
 */
export const SETTING_TABS = [
  "appearance",
  "model",
  "interaction",
  "context",
  "memory",
  "files",
  "shell",
  "tools",
  "tasks",
  "providers",
] as const;
export type SettingTab = (typeof SETTING_TABS)[number];

export const SETTING_SECTIONS: Record<SettingTab, readonly string[]> = {
  appearance: ["Theme", "Composer", "Status Line", "Display", "Images"],
  model: ["Thinking", "Sampling", "Prompt", "Retry & Fallback", "Advisor", "Prewalk", "Vision"],
  interaction: [
    "Input",
    "Approvals",
    "Notifications",
    "Speech",
    "Collab",
    "Stream",
    "Magic Keywords",
    "Startup & Updates",
    "Power",
    "Agent",
    "Git",
    "Skills",
  ],
  context: ["General", "Compaction", "Rules (TTSR)", "Experimental"],
  memory: ["General", "Auto-Learn", "Mnemopi", "Hindsight", "Sharpshooter"],
  files: ["Editing", "Reading", "Read Summaries", "LSP"],
  shell: ["Bash", "Eval & Runtimes"],
  tools: [
    "Available Tools",
    "Todos",
    "Grep & Browser",
    "Computer",
    "IDA Pro",
    "GitHub",
    "Output Limits",
    "Execution",
    "Discovery & MCP",
    "Extensions",
    "Developer",
  ],
  tasks: ["Modes", "Subagents", "Isolation", "Commands & Skills"],
  providers: ["Services", "Fireworks", "Tiny Model", "Protocol", "Timeouts", "Privacy"],
};

/** `<tab>/<section>`, for example `tools/Discovery & MCP`. */
export type SettingSection = `${SettingTab}/${string}`;

// Namespace ownership

export type HeaderSection = "Responsibility" | "Scope" | "Interface" | "Parallel work";

/** A verbatim quote from one section of a module header. */
export interface HeaderCitation {
  readonly module: ModuleId;
  readonly section: HeaderSection;
  readonly quote: string;
}

/**
 * - `setting-section`: an omp settings section, `<tab>/<section>`. Owned per section, not per
 *   tab, because the headers split tabs (the Tools tab goes to S3 and I1).
 * - `slash-command`: an omp builtin command, `/<name>` (omp v18.6.1 has 85), or a whole command
 *   source, `source:<skill|extension|custom|mcp_prompt|file>`.
 * - `panel`: a panel name; the panel descriptor's id is `<owner>.<name>`.
 */
export type NamespaceKind = "setting-section" | "slash-command" | "panel";

/** Where the headers disagreed or were silent, the main agent decided; claims cite that decision. */
export interface DecisionCitation {
  readonly decision: "main agent decision";
  readonly date: string;
}

export type ClaimSource = HeaderCitation | DecisionCitation;

interface ClaimBase {
  readonly kind: NamespaceKind;
  readonly namespace: string;
  readonly sources: readonly ClaimSource[];
  readonly note?: string;
}

/**
 * `contested` marks a namespace that two headers claim, or that no header names, until the main
 * agent decides it; `validateRegistry` accepts no registration there meanwhile. The table below
 * has none: every earlier contest was decided on 2026-10-04.
 */
export type NamespaceClaim =
  | (ClaimBase & { readonly status: "owned"; readonly owner: ModuleId })
  | (ClaimBase & { readonly status: "contested"; readonly candidates: readonly ModuleId[] });

function owned(
  kind: NamespaceKind,
  owner: ModuleId,
  sources: readonly ClaimSource[],
  namespaces: readonly string[],
  note?: string,
): NamespaceClaim[] {
  return namespaces.map((namespace) => ({
    kind,
    namespace,
    status: "owned",
    owner,
    sources,
    note,
  }));
}

const MAIN_AGENT_DECISION: DecisionCitation = {
  decision: "main agent decision",
  date: "2026-10-04",
};

/** A namespace that was contested between `candidates` until the main agent gave it to `owner`. */
function decided(
  kind: NamespaceKind,
  namespace: string,
  owner: ModuleId,
  candidates: readonly ModuleId[],
  sources: readonly HeaderCitation[],
  note: string,
): NamespaceClaim {
  return {
    kind,
    namespace,
    status: "owned",
    owner,
    sources: [MAIN_AGENT_DECISION, ...sources],
    note: `Main agent decision, 2026-10-04 (candidates were ${candidates.join(", ")}). ${note}`,
  };
}

const S1_R1: HeaderCitation = {
  module: "S1",
  section: "Responsibility",
  quote: "Own appearance/theme/composer/status-line/display/image settings",
};
const D1_S1: HeaderCitation = {
  module: "D1",
  section: "Scope",
  quote: "D1, E5, and S2 Model settings",
};
const P1_S1: HeaderCitation = {
  module: "P1",
  section: "Scope",
  quote: "the advisor command/mode/configuration/note-card subset of C3",
};
const S1_R2: HeaderCitation = {
  module: "S1",
  section: "Responsibility",
  quote:
    "interaction input, approvals, notifications, speech, collaboration, magic-keyword, startup/update, power, agent, and git settings UI",
};
const I5_R1: HeaderCitation = {
  module: "I5",
  section: "Responsibility",
  quote: "voice-related persisted settings",
};
const I5_S1: HeaderCitation = {
  module: "I5",
  section: "Scope",
  quote: "Interaction/Speech setting consumers",
};
const I4_S1: HeaderCitation = {
  module: "I4",
  section: "Scope",
  quote: "the collaboration setting groups consumed from S1",
};
const I4_R1: HeaderCitation = {
  module: "I4",
  section: "Responsibility",
  quote: "relay/share configuration",
};
const S3_R1: HeaderCitation = {
  module: "S3",
  section: "Responsibility",
  quote:
    "Own available-tools, todo, grep/browser, computer, developer, execution, extensions, GitHub, output-limit, task modes, isolation, commands/skills, and subagent policy settings",
};
const I2_R1: HeaderCitation = {
  module: "I2",
  section: "Responsibility",
  quote: "plugin/marketplace list/install/uninstall/update/upgrade",
};
const P7_S1: HeaderCitation = {
  module: "P7",
  section: "Scope",
  quote: "S4 Context setting groups are implemented here as the context configuration section",
};
const I3_S1: HeaderCitation = { module: "I3", section: "Scope", quote: "S5 Memory groups" };
const I3_R1: HeaderCitation = {
  module: "I3",
  section: "Responsibility",
  quote: "Hindsight/Mnemopi settings",
};
const S2_S1: HeaderCitation = {
  module: "S2",
  section: "Scope",
  quote: "S5 Files and Shell groups",
};
const S2_R1: HeaderCitation = {
  module: "S2",
  section: "Responsibility",
  quote: "Own file editing/reading/read-summary/LSP settings and Bash/Eval/runtime settings",
};
const S3_S1: HeaderCitation = {
  module: "S3",
  section: "Scope",
  quote:
    "S5 Tools and Tasks groups except Tools/Discovery & MCP (I1), Providers (D3), Memory (I3), and Files/Shell (S2)",
};
const U5_S1: HeaderCitation = {
  module: "U5",
  section: "Scope",
  quote: "todo portions of P2, P4, P7, N1, C3, and S3",
};
const I1_S1: HeaderCitation = {
  module: "I1",
  section: "Scope",
  quote: "S5 Tools/Discovery & MCP settings",
};
const D3_S1: HeaderCitation = { module: "D3", section: "Scope", quote: "all S5 Providers groups" };
const D6_R1: HeaderCitation = {
  module: "D6",
  section: "Responsibility",
  quote: "Own debug/security/changelog/jobs/stats/setup diagnostics",
};
const S1_S1: HeaderCitation = {
  module: "S1",
  section: "Scope",
  quote: "S1 and S3 except plugin settings (I2)",
};
const D3_S2: HeaderCitation = {
  module: "D3",
  section: "Scope",
  quote: "provider-related C1 setup rows",
};
const P2_S1: HeaderCitation = { module: "P2", section: "Scope", quote: "P2's nine rows" };
const P2_R1: HeaderCitation = {
  module: "P2",
  section: "Responsibility",
  quote: "Implement read-only plan mode, persistent plan document",
};
const D8_S1: HeaderCitation = {
  module: "D8",
  section: "Scope",
  quote: "goal/guided-goal/loop/tan/vibe",
};
const P6_S1: HeaderCitation = { module: "P6", section: "Scope", quote: "P5's 14 rows" };
const D1_R1: HeaderCitation = {
  module: "D1",
  section: "Responsibility",
  quote: "searchable provider-grouped model picker",
};
const D1_R2: HeaderCitation = {
  module: "D1",
  section: "Responsibility",
  quote: "per-reply/session-only versus saved-default choice",
};
const D3_R1: HeaderCitation = {
  module: "D3",
  section: "Responsibility",
  quote: "Own login/logout/switch/account selectors",
};
const D7_R1: HeaderCitation = {
  module: "D7",
  section: "Responsibility",
  quote: "Own default/fast/extended-context/browser/computer/vision/prewalk/force modes",
};
const D7_R2: HeaderCitation = {
  module: "D7",
  section: "Responsibility",
  quote: "mode precedence/status",
};
const D2_R1: HeaderCitation = {
  module: "D2",
  section: "Responsibility",
  quote: "Own slash-command catalog/action execution, MCP/custom/file/skill prompts",
};
const D8_R1: HeaderCitation = {
  module: "D8",
  section: "Responsibility",
  quote:
    "Own goal create/get/set/pause/resume/drop/budget, guided goal interview, loop mode, tan dispatch, vibe workers",
};
const D1_R3: HeaderCitation = {
  module: "D1",
  section: "Responsibility",
  quote: "role/fallback presentation",
};
const D1_R4: HeaderCitation = {
  module: "D1",
  section: "Responsibility",
  quote: "thinking-level picker/cycling",
};
const D4_S1: HeaderCitation = {
  module: "D4",
  section: "Scope",
  quote: "D5 plus copy/export/share rows from C1/C5",
};
const P7_S2: HeaderCitation = { module: "P7", section: "Scope", quote: "P4's 20 rows" };
const I4_R2: HeaderCitation = {
  module: "I4",
  section: "Responsibility",
  quote: "Own collab host/guest/view/join/leave/status",
};
const U5_S2: HeaderCitation = {
  module: "U5",
  section: "Scope",
  quote: "E3 and todo portions of P2, P4, P7, N1, C3, and S3",
};
const D5_R1: HeaderCitation = {
  module: "D5",
  section: "Responsibility",
  quote: "Own session info/delete/pin/rename/new/drop/clear/fresh/handoff",
};
const P7_R1: HeaderCitation = { module: "P7", section: "Responsibility", quote: "usage output" };
const U0_S1: HeaderCitation = {
  module: "U0",
  section: "Scope",
  quote: "F4 shell/design responsibilities, D6",
};
const U0_R1: HeaderCitation = {
  module: "U0",
  section: "Responsibility",
  quote: "shortcut sheet/rebinding UI",
};
const D7_R3: HeaderCitation = {
  module: "D7",
  section: "Responsibility",
  quote: "mode-specific tool availability",
};
const S3_R2: HeaderCitation = { module: "S3", section: "Responsibility", quote: "available-tools" };
const P7_R2: HeaderCitation = {
  module: "P7",
  section: "Responsibility",
  quote: "Own context meter, token/cost/cache status",
};
const I2_R2: HeaderCitation = {
  module: "I2",
  section: "Responsibility",
  quote: "Own extension control center",
};
const P1_S2: HeaderCitation = { module: "P1", section: "Scope", quote: "P1's 20 rows" };
const D5_S1: HeaderCitation = {
  module: "D5",
  section: "Scope",
  quote: "C2 and the session/SSH subset of C1; R1 owns list metadata and P4 owns tree/fork history",
};
const N1_R1: HeaderCitation = {
  module: "N1",
  section: "Responsibility",
  quote: "local git/path/time/hostname metadata",
};
const P1_R1: HeaderCitation = {
  module: "P1",
  section: "Responsibility",
  quote: "Own the subagent list",
};
const P3_S1: HeaderCitation = {
  module: "P3",
  section: "Scope",
  quote: "The message-branching subset of P3 (branch, branch message selector, branch summary)",
};
const P4_R1: HeaderCitation = {
  module: "P4",
  section: "Responsibility",
  quote: "fork/branch session transitions",
};
const P4_S1: HeaderCitation = {
  module: "P4",
  section: "Scope",
  quote: "The durable-tree subset of P3: fork, get_entries, get_tree, tree, tree selector",
};
const I1_R1: HeaderCitation = {
  module: "I1",
  section: "Responsibility",
  quote:
    "Own MCP server add/list/remove/test/auth/enable/disable/reconnect/reload/resources/prompts/notifications",
};
const D5_R2: HeaderCitation = {
  module: "D5",
  section: "Responsibility",
  quote: "add/remove/list directories, move directory, retry, SSH management",
};
const P7_S3: HeaderCitation = { module: "P7", section: "Scope", quote: "all four E4 compact rows" };
const D7_S1: HeaderCitation = { module: "D7", section: "Scope", quote: "prewalk, shake, vision" };
const R1_S1: HeaderCitation = {
  module: "R1",
  section: "Scope",
  quote: "including open_session, resume, session selector",
};
const D6_S1: HeaderCitation = {
  module: "D6",
  section: "Scope",
  quote:
    "The diagnostic/operational subset of C1 and the `btw`, `cleanse`, `omfg`, `pause`, and debug-selector subset of C3",
};
const I3_R2: HeaderCitation = {
  module: "I3",
  section: "Responsibility",
  quote: "Own memory command surfaces",
};
const U0_S2: HeaderCitation = {
  module: "U0",
  section: "Scope",
  quote: "It does not own omp commands or runtime state.",
};
const A0_R1: HeaderCitation = {
  module: "A0",
  section: "Responsibility",
  quote: "Own the one-omp-process-per-chat lifecycle",
};
const I2_R3: HeaderCitation = { module: "I2", section: "Responsibility", quote: "reload-plugins" };
const I5_S2: HeaderCitation = { module: "I5", section: "Scope", quote: "C5 `live`" };
const D4_R1: HeaderCitation = {
  module: "D4",
  section: "Responsibility",
  quote: "Implement Markdown/raw-code copy fidelity, HTML/plain export",
};
const I2_P1: HeaderCitation = {
  module: "I2",
  section: "Parallel work",
  quote: "command metadata is registered through C0/D2 ports",
};
const I1_S2: HeaderCitation = {
  module: "I1",
  section: "Scope",
  quote: "MCP prompt source integration",
};
const U5_R1: HeaderCitation = {
  module: "U5",
  section: "Responsibility",
  quote: "implement the live todo/plan checklist",
};
const P1_R2: HeaderCitation = {
  module: "P1",
  section: "Responsibility",
  quote:
    "Own the subagent list, lifecycle/progress subscription, selected-agent inspector, focused steerable transcript",
};
const P1_P1: HeaderCitation = {
  module: "P1",
  section: "Parallel work",
  quote: "it owns its panel files",
};
const P2_R2: HeaderCitation = {
  module: "P2",
  section: "Responsibility",
  quote: "persistent plan document, TOC, annotations/comments, review actions",
};
const P6_R1: HeaderCitation = { module: "P6", section: "Responsibility", quote: "queue bar" };
const P4_R2: HeaderCitation = {
  module: "P4",
  section: "Responsibility",
  quote: "tree-selector UI",
};
const R1_R1: HeaderCitation = {
  module: "R1",
  section: "Responsibility",
  quote: "list/search/group sessions per folder",
};
const I3_R3: HeaderCitation = {
  module: "I3",
  section: "Responsibility",
  quote: "persistent memory list/edit/delete",
};
const I3_R4: HeaderCitation = {
  module: "I3",
  section: "Responsibility",
  quote: "rules browser/editor",
};
const I4_R3: HeaderCitation = { module: "I4", section: "Responsibility", quote: "participants" };
const I5_R2: HeaderCitation = {
  module: "I5",
  section: "Responsibility",
  quote: "voice transcripts, live voice controls",
};
const S1_I1: HeaderCitation = {
  module: "S1",
  section: "Interface",
  quote: "SettingsSectionDescriptor",
};
const D6_I1: HeaderCitation = { module: "D6", section: "Interface", quote: "SidePanelDescriptor" };
const D6_R2: HeaderCitation = { module: "D6", section: "Responsibility", quote: "btw questions" };
const D6_R3: HeaderCitation = {
  module: "D6",
  section: "Responsibility",
  quote: "cleanse progress",
};
const D6_R4: HeaderCitation = { module: "D6", section: "Responsibility", quote: "omfg/TTSR panel" };
const D6_R5: HeaderCitation = { module: "D6", section: "Responsibility", quote: "pause gate" };
const D8_R2: HeaderCitation = {
  module: "D8",
  section: "Responsibility",
  quote: "Own goal create/get/set/pause/resume/drop/budget",
};
const D8_S2: HeaderCitation = {
  module: "D8",
  section: "Scope",
  quote: "and their modes/panels/tool coordination",
};
const D8_R3: HeaderCitation = { module: "D8", section: "Responsibility", quote: "tan dispatch" };
const D8_R4: HeaderCitation = { module: "D8", section: "Responsibility", quote: "vibe workers" };

const NEW_IN_18_6_1 = "New in omp 18.6.1; no header names it.";

/** Which module owns each omp setting section, slash command and panel. */
export const NAMESPACE_OWNERSHIP: readonly NamespaceClaim[] = [
  // Setting sections: all 60 of omp 18.6.1.
  ...owned(
    "setting-section",
    "S1",
    [S1_R1],
    [
      "appearance/Theme",
      "appearance/Composer",
      "appearance/Status Line",
      "appearance/Display",
      "appearance/Images",
    ],
  ),
  ...owned(
    "setting-section",
    "D1",
    [D1_S1],
    [
      "model/Thinking",
      "model/Sampling",
      "model/Prompt",
      "model/Retry & Fallback",
      "model/Prewalk",
      "model/Vision",
    ],
  ),
  decided(
    "setting-section",
    "model/Advisor",
    "P1",
    ["D1", "P1"],
    [D1_S1, P1_S1],
    "D1 takes all old-S2 model settings, which include this section; P1 takes the advisor configuration subset of C3.",
  ),
  ...owned(
    "setting-section",
    "S1",
    [S1_R2],
    [
      "interaction/Input",
      "interaction/Approvals",
      "interaction/Notifications",
      "interaction/Magic Keywords",
      "interaction/Startup & Updates",
      "interaction/Power",
      "interaction/Agent",
      "interaction/Git",
    ],
  ),
  decided(
    "setting-section",
    "interaction/Speech",
    "I5",
    ["S1", "I5"],
    [S1_R2, I5_R1, I5_S1],
    "S1 lists speech settings; I5 owns voice-related persisted settings but calls itself a consumer of this section.",
  ),
  ...owned("setting-section", "S1", [S1_R2, I4_S1], ["interaction/Collab"]),
  decided(
    "setting-section",
    "interaction/Stream",
    "I4",
    ["S1", "I4"],
    [S1_R2, I4_R1],
    "New in omp 18.6.1. It broadcasts a session to viewers, so it goes to sharing (I4): `stream.serverUrl` is the live-stream server `omp stream` uses, where viewers watch at <base>/<your Stencil username>, and `stream.redactPatterns` redacts every streamed row (omp v18.6.1 packages/coding-agent/src/stream/settings.ts:10-35).",
  ),
  decided(
    "setting-section",
    "interaction/Skills",
    "I2",
    ["S1", "S3", "I2"],
    [S1_R2, S3_R1, I2_R1],
    `${NEW_IN_18_6_1} It holds the skills registry URL.`,
  ),
  ...owned(
    "setting-section",
    "P7",
    [P7_S1],
    ["context/General", "context/Compaction", "context/Rules (TTSR)", "context/Experimental"],
  ),
  ...owned("setting-section", "I3", [I3_S1], ["memory/General", "memory/Auto-Learn"]),
  ...owned("setting-section", "I3", [I3_S1, I3_R1], ["memory/Mnemopi", "memory/Hindsight"]),
  ...owned(
    "setting-section",
    "I3",
    [I3_S1],
    ["memory/Sharpshooter"],
    "New in omp 18.6.1; a Memory group.",
  ),
  ...owned(
    "setting-section",
    "S2",
    [S2_S1, S2_R1],
    [
      "files/Editing",
      "files/Reading",
      "files/Read Summaries",
      "files/LSP",
      "shell/Bash",
      "shell/Eval & Runtimes",
    ],
  ),
  ...owned(
    "setting-section",
    "S3",
    [S3_S1, S3_R1],
    [
      "tools/Available Tools",
      "tools/Grep & Browser",
      "tools/Computer",
      "tools/GitHub",
      "tools/Output Limits",
      "tools/Execution",
      "tools/Extensions",
      "tools/Developer",
      "tasks/Modes",
      "tasks/Subagents",
      "tasks/Isolation",
      "tasks/Commands & Skills",
    ],
  ),
  decided(
    "setting-section",
    "tools/Todos",
    "S3",
    ["S3", "U5"],
    [S3_R1, U5_S1],
    "S3 lists todo settings; U5 takes the todo portions of S3.",
  ),
  ...owned(
    "setting-section",
    "S3",
    [S3_S1],
    ["tools/IDA Pro"],
    "New in omp 18.6.1; a Tools group.",
  ),
  ...owned("setting-section", "I1", [I1_S1, S3_S1], ["tools/Discovery & MCP"]),
  decided(
    "setting-section",
    "providers/Services",
    "I5",
    ["D3", "I5"],
    [D3_S1, I5_R1],
    "D3 takes every Providers group; I5 owns voice-related persisted settings, and this section holds live.voice, tts.localVoice and speech.*.",
  ),
  ...owned(
    "setting-section",
    "D3",
    [D3_S1],
    [
      "providers/Fireworks",
      "providers/Tiny Model",
      "providers/Protocol",
      "providers/Timeouts",
      "providers/Privacy",
    ],
  ),

  // Slash commands: all 85 builtins of omp 18.6.1, then the non-builtin sources.
  ...owned("slash-command", "D6", [D6_R1], ["/security", "/jobs", "/changelog"]),
  ...owned("slash-command", "S1", [S1_S1], ["/settings"]),
  decided(
    "slash-command",
    "/setup",
    "D3",
    ["D3", "D6"],
    [D3_S2, D6_R1],
    "`/setup` opens provider setup; D3 takes the provider setup rows and D6 lists setup diagnostics.",
  ),
  ...owned("slash-command", "P2", [P2_S1, P2_R1], ["/plan", "/plan-review"]),
  ...owned("slash-command", "D8", [D8_S1], ["/vibe", "/goal", "/guided-goal", "/loop", "/tan"]),
  ...owned("slash-command", "P6", [P6_S1], ["/queue"]),
  ...owned("slash-command", "D1", [D1_R1], ["/model"]),
  decided(
    "slash-command",
    "/switch",
    "D1",
    ["D1", "D3"],
    [D1_R2, D3_R1],
    "In omp 18.6.1 `/switch` picks a model for this session only (slash-commands/builtin-modes.ts:498-505); D3's header lists `switch` among account selectors.",
  ),
  ...owned(
    "slash-command",
    "D7",
    [D7_R1],
    ["/fast", "/extended-context", "/computer", "/prewalk", "/browser", "/force"],
  ),
  decided(
    "slash-command",
    "/slow",
    "D7",
    ["D7"],
    [D7_R1],
    `${NEW_IN_18_6_1} It is the slow service-tier counterpart of \`/fast\`.`,
  ),
  decided(
    "slash-command",
    "/skillful",
    "D7",
    ["D7", "D2"],
    [D7_R2, D2_R1],
    `${NEW_IN_18_6_1} It toggles the skill list in the system prompt for this session.`,
  ),
  decided(
    "slash-command",
    "/ratchet",
    "D8",
    ["D8"],
    [D8_R1],
    `${NEW_IN_18_6_1} It runs an unattended eval hill-climb.`,
  ),
  decided(
    "slash-command",
    "/modelpreset",
    "D1",
    ["D1"],
    [D1_R3],
    `${NEW_IN_18_6_1} It saves and switches role models plus thinking level.`,
  ),
  ...owned(
    "slash-command",
    "D1",
    [D1_R4],
    ["/effort"],
    "Sets the thinking level (named `/effort` in omp 18.6.1).",
  ),
  ...owned("slash-command", "P1", [P1_S1], ["/advisor"]),
  ...owned("slash-command", "D4", [D4_S1], ["/export", "/dump", "/share", "/copy"]),
  decided(
    "slash-command",
    "/trace",
    "D6",
    ["D6", "P7"],
    [D6_R1, P7_S2],
    `${NEW_IN_18_6_1} It opens this session's trace in the stats dashboard.`,
  ),
  ...owned("slash-command", "I4", [I4_R2], ["/collab", "/join", "/leave"]),
  decided(
    "slash-command",
    "/open",
    "D4",
    ["D4"],
    [D4_S1],
    `${NEW_IN_18_6_1} It opens the conversation's last link, a companion of \`/copy\`.`,
  ),
  ...owned("slash-command", "U5", [U5_S2], ["/todo"]),
  ...owned("slash-command", "D5", [D5_R1], ["/session", "/new", "/fresh", "/clear", "/handoff"]),
  ...owned("slash-command", "P7", [P7_R1, P7_S2], ["/usage"]),
  decided(
    "slash-command",
    "/stats",
    "P7",
    ["P7", "D6"],
    [P7_S2, D6_R1],
    "The old P4 rows (P7) include `/stats`; D6 lists stats diagnostics.",
  ),
  ...owned("slash-command", "U0", [U0_S1, U0_R1], ["/hotkeys"]),
  decided(
    "slash-command",
    "/tools",
    "D7",
    ["D7", "S3"],
    [D7_R3, S3_R2],
    "`/tools` lists the tools visible to the agent; its old C4 row falls in no named C4 subset.",
  ),
  ...owned("slash-command", "P7", [P7_R2, P7_S2], ["/context"]),
  ...owned("slash-command", "I2", [I2_R2], ["/extensions"]),
  ...owned("slash-command", "P1", [P1_S2], ["/agents"]),
  decided(
    "slash-command",
    "/git",
    "D5",
    ["D5", "N1"],
    [D5_S1, N1_R1],
    `${NEW_IN_18_6_1} It opens a git UI (diff viewer, staging, commit composer).`,
  ),
  ...owned(
    "slash-command",
    "P1",
    [P1_R1, P1_S2],
    ["/hub"],
    "New in omp 18.6.1; opens the Agent Hub, which the old P1 rows cover.",
  ),
  decided(
    "slash-command",
    "/branch",
    "P4",
    ["P3", "P4"],
    [P3_S1, P4_R1],
    "P3 takes `branch` and the branch message selector; P4 owns fork/branch session transitions. Alias `/rewind`.",
  ),
  ...owned("slash-command", "P4", [P4_S1], ["/fork", "/tree"]),
  ...owned("slash-command", "D3", [D3_R1], ["/login", "/logout"]),
  ...owned("slash-command", "I1", [I1_R1], ["/mcp"]),
  ...owned(
    "slash-command",
    "D5",
    [D5_R2],
    ["/ssh", "/retry", "/move", "/add-dir", "/remove-dir", "/dirs"],
  ),
  ...owned(
    "slash-command",
    "D5",
    [D5_R1],
    ["/delete", "/pin", "/rename"],
    "R1 owns the same actions in the session list (D5 Scope: R1 owns list metadata).",
  ),
  ...owned("slash-command", "P7", [P7_S3], ["/compact"]),
  ...owned("slash-command", "D7", [D7_S1], ["/shake"]),
  ...owned("slash-command", "R1", [R1_S1], ["/resume"]),
  ...owned("slash-command", "D6", [D6_S1], ["/btw", "/omfg", "/cleanse", "/pause"]),
  ...owned("slash-command", "D6", [D6_R1, D6_S1], ["/debug"]),
  ...owned("slash-command", "I3", [I3_R2], ["/memory"]),
  decided(
    "slash-command",
    "/wt",
    "D5",
    ["D5"],
    [D5_S1],
    `${NEW_IN_18_6_1} It moves the session into a new worktree; worktrees await the scope decision in PLAN.md.`,
  ),
  decided(
    "slash-command",
    "/exit",
    "U0",
    ["U0", "A0"],
    [U0_S1, U0_S2, A0_R1],
    "The old F4 rows went to U0, but U0 does not own omp commands; A0 owns the omp process lifecycle.",
  ),
  decided(
    "slash-command",
    "/restart",
    "D5",
    ["A0", "D5"],
    [A0_R1, D5_R1],
    `${NEW_IN_18_6_1} It restarts omp with the same flags and resumes the session.`,
  ),
  ...owned("slash-command", "I2", [I2_R1], ["/marketplace", "/plugins"]),
  ...owned("slash-command", "I2", [I2_R3], ["/reload-plugins"]),
  decided(
    "slash-command",
    "/skills",
    "I2",
    ["I2", "D2"],
    [I2_R1, D2_R1],
    `${NEW_IN_18_6_1} It searches, installs and updates skills from the skills registry.`,
  ),
  ...owned("slash-command", "I5", [I5_S2], ["/live"]),
  decided(
    "slash-command",
    "/record",
    "D4",
    ["D4", "U0"],
    [D4_R1, U0_S1],
    `${NEW_IN_18_6_1} It records the terminal screen to a replayable file.`,
  ),
  decided(
    "slash-command",
    "/quit",
    "U0",
    ["U0", "A0"],
    [U0_S1, U0_S2, A0_R1],
    "The old F4 rows went to U0, but U0 does not own omp commands; A0 owns the omp process lifecycle.",
  ),
  ...owned("slash-command", "D2", [D2_R1], ["source:skill", "source:custom", "source:file"]),
  ...owned("slash-command", "D2", [D2_R1, I2_P1], ["source:extension"]),
  decided(
    "slash-command",
    "source:mcp_prompt",
    "D2",
    ["D2", "I1"],
    [D2_R1, I1_R1, I1_S2],
    "D2 owns MCP prompts in the slash catalog; I1 owns MCP prompts and their source integration.",
  ),

  // Panels.
  ...owned("panel", "U5", [U5_R1], ["todo"]),
  ...owned("panel", "P1", [P1_R2, P1_P1], ["agents"]),
  ...owned("panel", "P2", [P2_R2], ["plan"]),
  ...owned("panel", "P7", [P7_R2], ["context"]),
  ...owned("panel", "P7", [P7_R1], ["usage"]),
  ...owned("panel", "P6", [P6_R1], ["queue"]),
  ...owned("panel", "P4", [P4_R2], ["tree"]),
  ...owned("panel", "R1", [R1_R1], ["sessions"]),
  ...owned("panel", "I1", [I1_R1], ["mcp"]),
  ...owned("panel", "I2", [I2_R2], ["extensions"]),
  ...owned("panel", "I3", [I3_R3], ["memory"]),
  ...owned("panel", "I3", [I3_R4], ["rules"]),
  ...owned("panel", "I4", [I4_R3], ["collab"]),
  ...owned("panel", "I5", [I5_R2], ["voice"]),
  ...owned("panel", "S1", [S1_S1, S1_I1], ["settings"]),
  ...owned("panel", "D6", [D6_R1, D6_I1], ["debug", "security", "changelog", "jobs"]),
  decided(
    "panel",
    "stats",
    "P7",
    ["D6", "P7"],
    [D6_R1, P7_S2],
    "Same split as the `/stats` command.",
  ),
  decided(
    "panel",
    "setup",
    "D3",
    ["D3", "D6"],
    [D3_S2, D6_R1],
    "Same split as the `/setup` command.",
  ),
  ...owned("panel", "D6", [D6_R2, D6_I1], ["btw"]),
  ...owned("panel", "D6", [D6_R3, D6_I1], ["cleanse"]),
  ...owned("panel", "D6", [D6_R4, D6_I1], ["omfg"]),
  ...owned("panel", "D6", [D6_R5, D6_I1], ["pause"]),
  ...owned("panel", "D8", [D8_R2, D8_S2], ["goal"]),
  ...owned("panel", "D8", [D8_R3, D8_S2], ["tan"]),
  ...owned("panel", "D8", [D8_R4, D8_S2], ["vibe"]),
];

const CLAIMS_BY_NAMESPACE = new Map(
  NAMESPACE_OWNERSHIP.map((claim) => [`${claim.kind}:${claim.namespace}`, claim]),
);

/** The claim on one namespace, or undefined when the table does not list it. */
export function namespaceClaim(kind: NamespaceKind, namespace: string): NamespaceClaim | undefined {
  return CLAIMS_BY_NAMESPACE.get(`${kind}:${namespace}`);
}
