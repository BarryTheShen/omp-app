/**
 * Registry descriptors: data that says what a module adds to the app — tool cards, transcript
 * message renderers, dialogs, panels, commands, settings, shortcuts, status segments and notices. Descriptors hold no code
 * and no React; the web app attaches a renderer to each by its id. Modules register descriptors
 * from their own folders; the main agent's composition index collects them, and
 * `validateRegistry` must return no problems before a registry ships.
 */
import { z } from "zod";
import { CapabilityKey } from "./capabilities";
import { INVENTORY, INVENTORY_IDS, InventoryId } from "./inventory";
import {
  MODULE_IDS,
  ModuleId,
  NAMESPACE_OWNERSHIP,
  type NamespaceClaim,
  type NamespaceKind,
  SETTING_SECTIONS,
  SETTING_TABS,
  type SettingSection,
  type SettingTab,
} from "./modules";
import type { OmpWire } from "./omp";

const DESCRIPTOR_ID = new RegExp(`^(?:${MODULE_IDS.join("|")})\\.[a-z][A-Za-z0-9_.-]*$`);

/** `<ModuleId>.<name>`; the module prefix must be the descriptor's owner. */
export type DescriptorId = `${ModuleId}.${string}`;
export const DescriptorId = z.custom<DescriptorId>(
  (value) => typeof value === "string" && DESCRIPTOR_ID.test(value),
  "expected <ModuleId>.<name>",
);

const DescriptorBase = z.object({
  id: DescriptorId,
  owner: ModuleId,
  title: z.string().min(1),
  /** Inventory rows this descriptor covers; across a registry each row is covered once (CC12). */
  covers: z.array(InventoryId),
  /** Capabilities the feature needs; without them its controls are hidden or disabled. */
  requires: z.array(CapabilityKey),
});

/** Which omp tool calls a tool card renders: one tool, a name prefix (MCP tools), or every unmatched call. */
export const ToolMatch = z.discriminatedUnion("by", [
  z.object({ by: z.literal("name"), name: z.string().min(1) }),
  z.object({ by: z.literal("prefix"), prefix: z.string().min(1) }),
  z.object({ by: z.literal("fallback") }),
]);
export type ToolMatch = z.infer<typeof ToolMatch>;

export const ToolDescriptor = DescriptorBase.extend({ kind: z.literal("tool"), match: ToolMatch });
export type ToolDescriptor = z.infer<typeof ToolDescriptor>;

export const DialogDescriptor = DescriptorBase.extend({ kind: z.literal("dialog") });
export type DialogDescriptor = z.infer<typeof DialogDescriptor>;

/** A panel's name is the part of its id after the module prefix (`U5.todo` → `todo`). */
export const PanelDescriptor = DescriptorBase.extend({ kind: z.literal("panel") });
export type PanelDescriptor = z.infer<typeof PanelDescriptor>;

const SLASH_SOURCES = {
  builtin: true,
  skill: true,
  extension: true,
  custom: true,
  mcp_prompt: true,
  file: true,
} as const satisfies Record<OmpWire.SlashCommandSource, true>;

/** `source` of omp's command catalog (`get_available_commands`). */
export const SlashCommandSource = z.enum(
  Object.keys(SLASH_SOURCES) as [OmpWire.SlashCommandSource, ...OmpWire.SlashCommandSource[]],
);

export const CommandDescriptor = DescriptorBase.extend({
  kind: z.literal("command"),
  /** The omp slash command it implements, without the slash; absent for app-only commands. */
  slash: z.object({ name: z.string().regex(/^[^\s/]\S*$/), source: SlashCommandSource }).optional(),
});
export type CommandDescriptor = z.infer<typeof CommandDescriptor>;

/** `<tab>/<section>` naming one of omp's settings sections (`SETTING_SECTIONS`). */
export const SettingSectionName = z.custom<SettingSection>((value) => {
  if (typeof value !== "string") return false;
  const slash = value.indexOf("/");
  const tab = value.slice(0, slash);
  return (
    SETTING_TABS.includes(tab as SettingTab) &&
    SETTING_SECTIONS[tab as SettingTab].includes(value.slice(slash + 1))
  );
}, "expected <tab>/<section> of omp's settings");

export const SettingDescriptor = DescriptorBase.extend({
  kind: z.literal("setting"),
  /** The omp setting id as written in config files, for example `compaction.enabled`. */
  key: z.string().regex(/^[A-Za-z][\w-]*(?:\.[\w-]+)*$/),
  /** The setting's omp settings section; null for config-file-only settings, which have none. */
  section: SettingSectionName.nullable(),
});
export type SettingDescriptor = z.infer<typeof SettingDescriptor>;

export const ShortcutDescriptor = DescriptorBase.extend({
  kind: z.literal("shortcut"),
  /**
   * `Mod+Shift+K` style, where `Mod` is Cmd on macOS and Ctrl elsewhere; a space separates the
   * steps of a sequence (`G G`); the plus key is written `Plus`.
   */
  chord: z.string().min(1),
  /** Where the chord applies: `global`, `composer`, `transcript`, a panel name, … */
  scope: z.string().min(1),
});
export type ShortcutDescriptor = z.infer<typeof ShortcutDescriptor>;

export const StatusDescriptor = DescriptorBase.extend({ kind: z.literal("status") });
export type StatusDescriptor = z.infer<typeof StatusDescriptor>;

export const NoticeSeverity = z.enum(["info", "success", "warning", "error"]);
export const NoticeDescriptor = DescriptorBase.extend({
  kind: z.literal("notice"),
  severity: NoticeSeverity,
});
export type NoticeDescriptor = z.infer<typeof NoticeDescriptor>;

/**
 * Which transcript messages a renderer draws: every message of one omp role (`bashExecution`,
 * `compactionSummary`, …) or every custom message of one `customType`. Across a registry each
 * role and each customType has one renderer (contract change 2026-10-05).
 */
export const MessageMatch = z.discriminatedUnion("by", [
  z.object({ by: z.literal("role"), role: z.string().min(1) }),
  z.object({ by: z.literal("customType"), customType: z.string().min(1) }),
]);
export type MessageMatch = z.infer<typeof MessageMatch>;

export const MessageDescriptor = DescriptorBase.extend({
  kind: z.literal("message"),
  match: MessageMatch,
});
export type MessageDescriptor = z.infer<typeof MessageDescriptor>;

export const Descriptor = z.discriminatedUnion("kind", [
  ToolDescriptor,
  DialogDescriptor,
  PanelDescriptor,
  CommandDescriptor,
  SettingDescriptor,
  ShortcutDescriptor,
  StatusDescriptor,
  NoticeDescriptor,
  MessageDescriptor,
]);
export type Descriptor = z.infer<typeof Descriptor>;

const MODIFIERS = ["mod", "ctrl", "alt", "shift", "meta"];

/** Canonical chord text for comparison: lower case, modifiers in one fixed order. */
export function normalizeChord(chord: string): string {
  return chord
    .trim()
    .split(/\s+/)
    .map((step) => {
      const keys = step
        .split("+")
        .map((key) => key.trim().toLowerCase())
        .filter((key) => key !== "");
      const modifiers = keys
        .filter((key) => MODIFIERS.includes(key))
        .sort((a, b) => MODIFIERS.indexOf(a) - MODIFIERS.indexOf(b));
      return [...modifiers, ...keys.filter((key) => !MODIFIERS.includes(key))].join("+");
    })
    .join(" ");
}

export type RegistryProblemKind =
  /** The descriptor breaks its schema. */
  | "invalid"
  /** The id's module prefix is not the owner. */
  | "owner-mismatch"
  | "duplicate-id"
  | "unknown-inventory-id"
  /** Two descriptors cover the same inventory row. */
  | "inventory-double-claim"
  /** Two descriptors claim the same tool match, slash command, setting key, or chord in a scope. */
  | "double-claim"
  /** The ownership table gives the namespace to another module. */
  | "not-owner"
  /** The namespace is contested; the main agent must settle it first. */
  | "contested-namespace";

export interface RegistryProblem {
  readonly kind: RegistryProblemKind;
  /** The descriptor id, or its position when the descriptor has no valid id. */
  readonly id: string;
  readonly detail: string;
}

function claimKeys(descriptor: Descriptor): string[] {
  switch (descriptor.kind) {
    case "tool": {
      const { match } = descriptor;
      if (match.by === "name") return [`omp tool ${match.name}`];
      return [match.by === "prefix" ? `omp tool prefix ${match.prefix}` : "omp tool fallback"];
    }
    case "command":
      return descriptor.slash === undefined
        ? []
        : [`slash command ${descriptor.slash.source}:${descriptor.slash.name}`];
    case "setting":
      return [`setting ${descriptor.key}`];
    case "shortcut":
      return [`chord ${normalizeChord(descriptor.chord)} in ${descriptor.scope}`];
    case "message":
      return descriptor.match.by === "role"
        ? [`message role ${descriptor.match.role}`]
        : [`message customType ${descriptor.match.customType}`];
    default:
      return [];
  }
}

/** The ownership-table key (`<kind>:<namespace>`) a descriptor registers in, if any. */
function namespaceOf(descriptor: Descriptor): `${NamespaceKind}:${string}` | undefined {
  if (descriptor.kind === "setting" && descriptor.section !== null) {
    return `setting-section:${descriptor.section}`;
  }
  if (descriptor.kind === "command" && descriptor.slash !== undefined) {
    const { name, source } = descriptor.slash;
    return `slash-command:${source === "builtin" ? `/${name}` : `source:${source}`}`;
  }
  if (descriptor.kind === "panel") {
    return `panel:${descriptor.id.slice(descriptor.id.indexOf(".") + 1)}`;
  }
  return undefined;
}

/**
 * Checks a whole registry: every descriptor matches its schema; ids are unique and prefixed by
 * their owner; covered inventory rows exist and are covered once; no two descriptors claim the
 * same omp tool, slash command, setting key, or chord within a scope; and each setting section,
 * slash command and panel belongs to the descriptor's owner in the ownership table
 * (`NAMESPACE_OWNERSHIP` unless another table is passed). Returns every problem found; an empty
 * list means the registry is valid.
 */
export function validateRegistry(
  descriptors: readonly unknown[],
  ownership: readonly NamespaceClaim[] = NAMESPACE_OWNERSHIP,
): RegistryProblem[] {
  const claimsByNamespace = new Map(
    ownership.map((claim) => [`${claim.kind}:${claim.namespace}`, claim]),
  );
  const problems: RegistryProblem[] = [];
  const ids = new Set<string>();
  const claims = new Map<string, string>();
  const covered = new Map<string, string>();
  for (const [index, candidate] of descriptors.entries()) {
    const parsed = Descriptor.safeParse(candidate);
    if (!parsed.success) {
      const id = (candidate as { id?: unknown } | null)?.id;
      problems.push({
        kind: "invalid",
        id: typeof id === "string" ? id : `#${index}`,
        detail: z.prettifyError(parsed.error),
      });
      continue;
    }
    const descriptor = parsed.data;
    const { id } = descriptor;
    if (!id.startsWith(`${descriptor.owner}.`)) {
      problems.push({ kind: "owner-mismatch", id, detail: `owner is ${descriptor.owner}` });
    }
    if (ids.has(id)) problems.push({ kind: "duplicate-id", id, detail: "id used twice" });
    ids.add(id);
    for (const row of descriptor.covers) {
      if (!INVENTORY_IDS.has(row)) {
        problems.push({ kind: "unknown-inventory-id", id, detail: row });
        continue;
      }
      const first = covered.get(row);
      if (first === undefined) covered.set(row, id);
      else
        problems.push({
          kind: "inventory-double-claim",
          id,
          detail: `${row} is covered by ${first}`,
        });
    }
    for (const key of claimKeys(descriptor)) {
      const first = claims.get(key);
      if (first === undefined) claims.set(key, id);
      else problems.push({ kind: "double-claim", id, detail: `${key} is claimed by ${first}` });
    }
    const namespace = namespaceOf(descriptor);
    const claim = namespace === undefined ? undefined : claimsByNamespace.get(namespace);
    if (claim?.status === "contested") {
      const candidates = claim.candidates.join(", ");
      problems.push({
        kind: "contested-namespace",
        id,
        detail: `${claim.namespace} is contested between ${candidates}`,
      });
    } else if (claim !== undefined && claim.owner !== descriptor.owner) {
      problems.push({
        kind: "not-owner",
        id,
        detail: `${claim.namespace} belongs to ${claim.owner}`,
      });
    }
  }
  return problems;
}

/** Inventory rows no descriptor covers yet; empty at W8 (CC12). */
export function uncoveredInventory(descriptors: readonly Descriptor[]): InventoryId[] {
  const covered = new Set(descriptors.flatMap((descriptor) => descriptor.covers));
  return INVENTORY.filter((item) => !covered.has(item.id)).map((item) => item.id);
}
