import type { ModelRef } from "../contract";

/**
 * The model roles omp's `/model` hub lists, in omp's order: `MODEL_ROLE_IDS` in omp's model browser
 * (packages/tui/src/overlays/model-browser.ts:72-89 at v18.12.6, where `widget` follows `advisor`; the list at v18.6.1 was
 * :64-80 and had no `widget`) and the names omp shows (`MODEL_ROLES`, packages/coding-agent/src/config/model-roles.ts:56-91
 * at v18.12.6, "Job widgets" at :67). omp's job widgets read the role when they write a widget spec
 * (packages/coding-agent/src/job-widgets/author.ts:185), so a change reaches a running chat. Roles omp stores under
 * `modelRoles.<id>` in config.yml.
 */
export interface ModelRoleDefinition {
  /** The key omp stores the role under. Shown to nobody: the dialog uses `name`. */
  readonly id: string;
  /** The name omp shows for the role. */
  readonly name: string;
  /** omp lists these under its "kind" roles; the others are chat roles. */
  readonly kind: boolean;
  /**
   * Why no model can be picked for the role in this app, or null when a chat model can take it. The
   * catalog lists chat models only (`getAvailable()` defaults to chat: model-controls.ts:502-507 at
   * v18.12.6, read by get_available_models: rpc-mode.ts:2328-2332), so kind-only roles have no candidates.
   */
  readonly unpickableReason: string | null;
}

function chatRole(id: string, name: string): ModelRoleDefinition {
  return { id, name, kind: false, unpickableReason: null };
}

/** omp's built-in roles, in omp's order. */
export const MODEL_ROLE_DEFINITIONS: readonly ModelRoleDefinition[] = [
  chatRole("default", "Default"),
  chatRole("smol", "Fast"),
  chatRole("slow", "Thinking"),
  chatRole("vision", "Vision"),
  chatRole("plan", "Architect"),
  chatRole("commit", "Commit"),
  chatRole("tiny", "Tiny"),
  chatRole("memory", "Memory"),
  chatRole("task", "Subtask"),
  chatRole("advisor", "Advisor"),
  chatRole("widget", "Job widgets"),
  {
    id: "image",
    name: "Image generation",
    kind: true,
    unpickableReason: "Image models aren't listed in the app yet.",
  },
  {
    id: "web",
    name: "Web search",
    kind: true,
    unpickableReason: "The app can't tell which models search the web yet.",
  },
  {
    id: "speech",
    name: "Speech",
    kind: true,
    unpickableReason: "Speech models aren't listed in the app yet.",
  },
  {
    id: "dictation",
    name: "Dictation",
    kind: true,
    unpickableReason: "Dictation models aren't listed in the app yet.",
  },
  { id: "judge", name: "Judge", kind: true, unpickableReason: null },
];

/**
 * The roles to list: omp's built-ins in omp's order, then any custom role the configuration names (a key
 * of `modelRoles` or of `cycleOrder`), in the order first seen. A custom role is named by its key, as omp
 * does (getRoleInfo, model-roles.ts:150-154).
 */
export function roleDefinitions(
  configuredRoleIds: Iterable<string>,
): readonly ModelRoleDefinition[] {
  const roles = [...MODEL_ROLE_DEFINITIONS];
  const listed = new Set(roles.map((role) => role.id));
  for (const id of configuredRoleIds) {
    if (listed.has(id)) continue;
    listed.add(id);
    roles.push(chatRole(id, id));
  }
  return roles;
}

/** The thinking suffixes omp accepts on a role's selector (`provider/id:high`). */
const THINKING_SUFFIXES: Record<string, true> = {
  off: true,
  minimal: true,
  low: true,
  medium: true,
  high: true,
  xhigh: true,
  max: true,
  inherit: true,
  auto: true,
};

/**
 * A role's stored selector, `provider/id` with an optional `:level` suffix (omp writes it that way:
 * formatModelSelectorValue in packages/tui/src/overlays/model-selector.ts:81). `model` is
 * null when the text is not a `provider/id` pair.
 */
export function splitRoleSelector(selector: string): {
  readonly model: ModelRef | null;
  readonly thinkingLevel: string | null;
} {
  const colon = selector.lastIndexOf(":");
  const suffix = colon > 0 ? selector.slice(colon + 1) : "";
  const hasLevel = Object.hasOwn(THINKING_SUFFIXES, suffix);
  const base = hasLevel ? selector.slice(0, colon) : selector;
  const thinkingLevel = hasLevel ? suffix : null;
  const slash = base.indexOf("/");
  if (slash <= 0 || slash === base.length - 1) return { model: null, thinkingLevel };
  return {
    model: { provider: base.slice(0, slash), modelId: base.slice(slash + 1) },
    thinkingLevel,
  };
}
