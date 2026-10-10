import type { AppError, EntryId, SessionEntryHead, ThreadId } from "@omp-app/contracts";
import { z } from "zod";
import type {
  ReadOnlyTreeLabel,
  TreeNode,
  TreeSelectorFilter,
  TreeSelectorState,
  TreeSnapshot,
} from "../contract";

export interface P4TreeSelectorRowModel {
  readonly entryId: EntryId;
  /** The nearest listed ancestor; ArrowLeft moves here. */
  readonly parentId: EntryId | null;
  /**
   * Display depth, as omp's terminal draws it: one level deeper only below a message with more
   * than one child (or a root of a conversation with several roots). A straight chain stays flat.
   */
  readonly depth: number;
  /** Zero-based place among the listed rows that share this row's parent. */
  readonly position: number;
  readonly siblingCount: number;
  readonly role: string;
  readonly timestamp: string;
  readonly preview: string;
  readonly label?: ReadOnlyTreeLabel;
  readonly currentLeaf: boolean;
  readonly selected: boolean;
  readonly hasVisibleChildren: boolean;
  readonly collapsed: boolean;
}
export interface P4TreeSelectorPreviewModel {
  readonly entryId: EntryId;
  readonly role: string;
  readonly timestamp: string;
  readonly text: string;
  readonly label?: ReadOnlyTreeLabel;
  readonly currentLeaf: boolean;
}

export interface P4TreeSelectorStatusModel {
  readonly kind: "loading" | "updating" | "empty" | "unavailable" | "error";
  readonly message: string;
  readonly retryable: boolean;
}

/** All derived conversation-tree data the selector view renders. */
export interface P4TreeSelectorViewModel {
  readonly threadId: ThreadId;
  readonly filter: TreeSelectorFilter;
  readonly showAllEntries: boolean;
  readonly selectedEntryId: EntryId | null;
  readonly currentLeafId: EntryId | null;
  /** Where the list opens: the marked entry, else the current one, or its nearest listed ancestor. */
  readonly openEntryId: EntryId | null;
  readonly hasTree: boolean;
  readonly status: P4TreeSelectorStatusModel | null;
  readonly rows: readonly P4TreeSelectorRowModel[];
  readonly totalCount: number;
  readonly resultSummary: string;
  readonly noResultsMessage: string | null;
  readonly emptyListMessage: string | null;
  readonly hasLabels: boolean;
  readonly labelsNotice: string | null;
  readonly preview: P4TreeSelectorPreviewModel | null;
  readonly pickerDisabledReason: string | undefined;
  readonly canSelect: boolean;
}

interface FlatTreeNode {
  readonly node: TreeNode;
  readonly depth: number;
  readonly parentId: EntryId | null;
  /** The node's children are listed one level deeper than it (omp's branch rule). */
  readonly branches: boolean;
}

export const LABELS_READ_ONLY_NOTICE = "Labels can only be changed in omp's terminal for now.";

/**
 * Entry kinds omp's terminal hides in its default view (tui/overlays/tree-selector.ts, the
 * `isSettingsEntry` list). "Show all entries" lists them.
 */
const BOOKKEEPING_ENTRY_TYPES: Readonly<Record<string, true>> = {
  label: true,
  custom: true,
  model_change: true,
  model_usage: true,
  thinking_level_change: true,
  service_tier_change: true,
  title_change: true,
  credential_pin: true,
  session_init: true,
  ttsr_injection: true,
  mode_change: true,
  reset_boundary: true,
};

const PreviewMessageSchema = z
  .object({
    role: z.unknown().optional(),
    content: z.unknown().optional(),
  })
  .passthrough();
const ContentPartSchema = z.object({ text: z.string().optional() }).passthrough();
const treeDateTimeFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export function formatTreeTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? "Date unavailable" : treeDateTimeFormat.format(date);
}

function messageContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      if (typeof part === "string") return part;
      const parsed = ContentPartSchema.safeParse(part);
      return parsed.success ? (parsed.data.text ?? "") : "";
    })
    .filter((text) => text.length > 0)
    .join(" ");
}

function messageForEntry(entry: SessionEntryHead) {
  const parsed = PreviewMessageSchema.safeParse(entry.message);
  return parsed.success ? parsed.data : undefined;
}

function entryRole(entry: SessionEntryHead): string {
  const role = messageForEntry(entry)?.role;
  if (typeof role === "string") {
    switch (role) {
      case "assistant":
        return "Assistant";
      case "user":
        return "You";
      case "toolResult":
        return "Tool result";
      case "developer":
        return "Instruction";
      case "system":
        return "System instruction";
    }
  }
  switch (entry.type) {
    case "branch_summary":
    case "compaction":
      return "Conversation summary";
    case "label":
      return "Label";
    case "model_change":
      return "Model change";
    case "thinking_level_change":
      return "Thinking level change";
    case "title_change":
      return "Title change";
    case "service_tier_change":
      return "Service tier change";
    case "mode_change":
      return "Mode change";
    case "custom":
      return "Extension data";
    case "custom_message":
      return "Extension message";
    default:
      return "Conversation update";
  }
}

/**
 * omp writes a reminder for the model as one `<system-*>` envelope around plain words. A todo
 * reminder uses `<system-reminder>`; a rule notice adds attributes. The history shows the words,
 * not the envelope. Only a developer or system message and a custom message are unwrapped (the
 * caller decides), and only when the whole text is exactly one envelope with its own closing tag.
 * Any other text, such as a tag a person quoted, is shown as it was written.
 */
const MODEL_ENVELOPE =
  /^<(system-[\w-]+)(?:\s+[\w-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'<>]+))?)*\s*>([\s\S]*)<\/\1>$/i;

function withoutModelEnvelope(text: string): string {
  const match = MODEL_ENVELOPE.exec(text.trim());
  if (match === null) return text;
  const inner = (match[2] ?? "").trim();
  // A second envelope inside the first makes two reminders, not one: the text is shown as written.
  return /<\/?system-/i.test(inner) ? text : inner;
}

function entryPreview(entry: SessionEntryHead): string {
  const message = messageForEntry(entry);
  if (message) {
    const text = messageContent(message.content);
    const unwrap = message.role === "developer" || message.role === "system";
    const shown = unwrap ? withoutModelEnvelope(text) : text;
    return shown.length > 0 ? shown : "No message text is available.";
  }
  const summary = entry.summary;
  if (typeof summary === "string" && summary.length > 0) return summary;
  switch (entry.type) {
    case "label":
      return typeof entry.label === "string" && entry.label.length > 0
        ? `Label set to ${entry.label}`
        : "Label removed";
    case "model_change":
      return typeof entry.model === "string" ? `Model set to ${entry.model}` : "Model changed";
    case "thinking_level_change":
      return typeof entry.thinkingLevel === "string"
        ? `Thinking level set to ${entry.thinkingLevel}`
        : "Thinking level changed";
    case "title_change":
      return typeof entry.title === "string" ? `Title set to ${entry.title}` : "Title changed";
    case "mode_change":
      return typeof entry.mode === "string" ? `Mode set to ${entry.mode}` : "Mode changed";
  }
  const content = messageContent(entry.content);
  const shown = entry.type === "custom_message" ? withoutModelEnvelope(content) : content;
  return shown.length > 0 ? shown : "No preview is available for this message.";
}

/** Nodes whose subtree holds the current leaf, which omp lists first. */
function nodesOnCurrentBranch(
  nodes: readonly TreeNode[],
  leafId: EntryId | null,
): ReadonlySet<TreeNode> {
  const onBranch = new Set<TreeNode>();
  if (leafId === null) return onBranch;
  const preOrder: TreeNode[] = [];
  const pending = [...nodes];
  while (pending.length > 0) {
    const node = pending.pop();
    if (!node) continue;
    preOrder.push(node);
    pending.push(...node.children);
  }
  for (let index = preOrder.length - 1; index >= 0; index -= 1) {
    const node = preOrder[index];
    if (!node) continue;
    if (node.entry.id === leafId || node.children.some((child) => onBranch.has(child))) {
      onBranch.add(node);
    }
  }
  return onBranch;
}

function orderChildren(
  children: readonly TreeNode[],
  onBranch: ReadonlySet<TreeNode>,
): readonly TreeNode[] {
  if (!children.some((child) => onBranch.has(child))) return children;
  return [...children].sort((a, b) => Number(onBranch.has(b)) - Number(onBranch.has(a)));
}

/**
 * Depth-first list of every entry, the way omp's terminal projects its tree: a message with one
 * child passes its depth on unchanged, and one with several children (or a root in a
 * multi-root conversation) indents its children. The current branch is listed first.
 */
function flattenTree(nodes: readonly TreeNode[], leafId: EntryId | null): FlatTreeNode[] {
  const onBranch = nodesOnCurrentBranch(nodes, leafId);
  const multipleRoots = nodes.length > 1;
  const flattened: FlatTreeNode[] = [];
  const pending: Array<{ node: TreeNode; depth: number; parentId: EntryId | null }> = [];
  const pushSiblings = (
    siblings: readonly TreeNode[],
    depth: number,
    parentId: EntryId | null,
  ): void => {
    for (let index = siblings.length - 1; index >= 0; index -= 1) {
      const node = siblings[index];
      if (node) pending.push({ node, depth, parentId });
    }
  };
  pushSiblings(orderChildren(nodes, onBranch), 0, null);
  while (pending.length > 0) {
    const item = pending.pop();
    if (!item) continue;
    const { children } = item.node;
    const branches =
      children.length > 0 && (children.length > 1 || (multipleRoots && item.parentId === null));
    flattened.push({ node: item.node, depth: item.depth, parentId: item.parentId, branches });
    pushSiblings(
      orderChildren(children, onBranch),
      branches ? item.depth + 1 : item.depth,
      item.node.entry.id,
    );
  }
  return flattened;
}

/** omp's per-message rule: an assistant turn with no text is hidden unless it failed or is the leaf. */
function isListedEntry(entry: SessionEntryHead, isCurrentLeaf: boolean, showAll: boolean): boolean {
  if (!showAll && BOOKKEEPING_ENTRY_TYPES[entry.type] === true) return false;
  if (isCurrentLeaf || entry.type !== "message") return true;
  const message = messageForEntry(entry);
  if (message?.role !== "assistant") return true;
  const hasText = messageContent(message.content).trim().length > 0;
  const stopReason = message.stopReason;
  const failedOrAborted =
    typeof stopReason === "string" && stopReason !== "stop" && stopReason !== "toolUse";
  return hasText || failedOrAborted;
}

function searchText(item: FlatTreeNode, showLabels: boolean): string {
  const label = showLabels ? (item.node.label?.text ?? "") : "";
  const { entry } = item.node;
  return `${entryRole(entry)} ${formatTreeTimestamp(entry.timestamp)} ${entryPreview(entry)} ${label}`.toLocaleLowerCase();
}

/** Entries hidden because an ancestor is folded; the walk is pre-order, so ancestors come first. */
function foldedEntryIds(
  nodes: readonly FlatTreeNode[],
  collapsedIds: ReadonlySet<EntryId>,
): ReadonlySet<EntryId> {
  const hidden = new Set<EntryId>();
  if (collapsedIds.size === 0) return hidden;
  for (const item of nodes) {
    const { parentId } = item;
    if (parentId !== null && (hidden.has(parentId) || collapsedIds.has(parentId))) {
      hidden.add(item.node.entry.id);
    }
  }
  return hidden;
}

/** Position and sibling count per listed row, grouped by the row's parent in the list. */
function listSiblingPlaces(
  rows: readonly FlatTreeNode[],
): Map<EntryId, { position: number; siblingCount: number }> {
  const groups: Array<{ count: number } | undefined> = [];
  const placed: Array<{ id: EntryId; group: { count: number }; position: number }> = [];
  let previousDepth = -1;
  for (const item of rows) {
    const { depth } = item;
    groups.length = depth + 1;
    let group = groups[depth];
    if (previousDepth < depth || group === undefined) {
      group = { count: 0 };
      groups[depth] = group;
    }
    placed.push({ id: item.node.entry.id, group, position: group.count });
    group.count += 1;
    previousDepth = depth;
  }
  const places = new Map<EntryId, { position: number; siblingCount: number }>();
  for (const place of placed) {
    places.set(place.id, { position: place.position, siblingCount: place.group.count });
  }
  return places;
}

function visibleErrorMessage(code: AppError["code"]): string {
  switch (code) {
    case "permission":
      return "You don't have permission to view this conversation.";
    case "not_found":
      return "This conversation history could not be found.";
    case "unavailable":
      return "Conversation history isn't available here.";
    case "timeout":
      return "Loading conversation history took too long.";
    case "conflict":
      return "Conversation history changed. Try again.";
    case "cancelled":
      return "Loading conversation history was cancelled.";
    default:
      return "Conversation history couldn't be loaded.";
  }
}

function statusFor(
  state: TreeSelectorState,
  snapshot: TreeSnapshot | null,
  isLoading: boolean,
  unavailableReason: string | undefined,
): P4TreeSelectorStatusModel | null {
  if (unavailableReason || state.error?.code === "unavailable") {
    return {
      kind: "unavailable",
      message: unavailableReason ?? visibleErrorMessage("unavailable"),
      retryable: false,
    };
  }
  if (state.error) {
    return {
      kind: "error",
      message: visibleErrorMessage(state.error.code),
      retryable: state.error.retryable,
    };
  }
  if (isLoading) {
    return {
      kind: snapshot ? "updating" : "loading",
      message: snapshot ? "Updating conversation history…" : "Loading conversation history…",
      retryable: false,
    };
  }
  if (!snapshot) {
    return {
      kind: "empty",
      message: "Conversation history hasn't been loaded yet.",
      retryable: false,
    };
  }
  if (snapshot.tree.length === 0) {
    return { kind: "empty", message: "No conversation messages yet.", retryable: false };
  }
  return null;
}

function countNoun(count: number, showAll: boolean): string {
  if (showAll) return count === 1 ? "1 entry" : `${count} entries`;
  return count === 1 ? "1 message" : `${count} messages`;
}

const EMPTY_COLLAPSED_IDS: ReadonlySet<EntryId> = new Set();

export function createP4TreeSelectorViewModel(
  snapshot: TreeSnapshot | null,
  state: TreeSelectorState,
  unavailableReason?: string,
  collapsedIds: ReadonlySet<EntryId> = EMPTY_COLLAPSED_IDS,
  showAllEntries = false,
): P4TreeSelectorViewModel {
  const activeSnapshot = snapshot?.threadId === state.threadId ? snapshot : null;
  const staleSnapshot = snapshot !== null && activeSnapshot === null;
  const isLoading = state.isLoading || staleSnapshot;
  const currentLeafId = activeSnapshot?.leafId ?? state.leafId;
  const allNodes = flattenTree(activeSnapshot?.tree ?? [], currentLeafId);
  const entryById = new Map<EntryId, FlatTreeNode>();
  for (const item of allNodes) entryById.set(item.node.entry.id, item);

  const listed = allNodes.filter((item) =>
    isListedEntry(item.node.entry, item.node.entry.id === currentLeafId, showAllEntries),
  );
  // Like omp's terminal, every word of the query must match, in any order (it matches each word
  // by fuzzy search; a word here is a plain substring).
  const queryWords = state.filter.query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const hasQuery = queryWords.length > 0;
  // A search shows only the matching entries, not the path to them (omp's per-entry predicate).
  const matches = hasQuery
    ? listed.filter((item) => {
        const text = searchText(item, state.filter.showLabels);
        return queryWords.every((word) => text.includes(word));
      })
    : listed;
  const folded = hasQuery ? new Set<EntryId>() : foldedEntryIds(allNodes, collapsedIds);
  const rowsFlat = hasQuery ? matches : listed.filter((item) => !folded.has(item.node.entry.id));

  const listedIds = new Set(rowsFlat.map((item) => item.node.entry.id));
  const parentsWithListedChildren = new Set<EntryId>();
  for (const item of hasQuery ? matches : listed) {
    if (item.parentId !== null) parentsWithListedChildren.add(item.parentId);
  }
  // The nearest listed ancestor of every entry, in one pre-order pass.
  const listedParent = new Map<EntryId, EntryId | null>();
  for (const item of allNodes) {
    const id = item.node.entry.id;
    const { parentId } = item;
    if (parentId === null) listedParent.set(id, null);
    else if (listedIds.has(parentId)) listedParent.set(id, parentId);
    else listedParent.set(id, listedParent.get(parentId) ?? null);
  }
  const places = listSiblingPlaces(rowsFlat);
  const rows: P4TreeSelectorRowModel[] = rowsFlat.map((item, index) => {
    const { entry } = item.node;
    // A search lists its matches as one flat list, so a place is counted across that list.
    const place = hasQuery
      ? { position: index, siblingCount: rowsFlat.length }
      : (places.get(entry.id) ?? { position: 0, siblingCount: 1 });
    const label = state.filter.showLabels ? item.node.label : undefined;
    return {
      entryId: entry.id,
      parentId: listedParent.get(entry.id) ?? null,
      // Search results are one flat list, so every ARIA level has a parent in it.
      depth: hasQuery ? 0 : item.depth,
      position: place.position,
      siblingCount: place.siblingCount,
      role: entryRole(entry),
      timestamp: entry.timestamp,
      preview: entryPreview(entry),
      ...(label === undefined ? {} : { label }),
      selected: state.selectedEntryId === entry.id,
      currentLeaf: currentLeafId === entry.id,
      hasVisibleChildren: !hasQuery && item.branches && parentsWithListedChildren.has(entry.id),
      collapsed: !hasQuery && collapsedIds.has(entry.id),
    };
  });

  const selectedEntryId = state.selectedEntryId;
  const previewEntryId = selectedEntryId ?? currentLeafId;
  const previewNode =
    (previewEntryId === null ? undefined : entryById.get(previewEntryId)) ??
    (currentLeafId === null ? undefined : entryById.get(currentLeafId));
  const previewLabel =
    state.filter.showLabels && previewNode?.node.label !== undefined
      ? previewNode.node.label
      : undefined;
  const nearestListed = (entryId: EntryId | null): EntryId | null => {
    let current = entryId;
    while (current !== null) {
      if (listedIds.has(current)) return current;
      current = entryById.get(current)?.parentId ?? null;
    }
    return null;
  };
  const openEntryId =
    nearestListed(selectedEntryId) ?? nearestListed(currentLeafId) ?? rows[0]?.entryId ?? null;
  const status = statusFor(state, activeSnapshot, isLoading, unavailableReason);
  const totalCount = listed.length;
  const hasTree = activeSnapshot !== null && activeSnapshot.tree.length > 0;
  const hasLabels = activeSnapshot !== null && activeSnapshot.labels.length > 0;
  const noun = showAllEntries ? "entries" : "messages";
  const canSelect =
    selectedEntryId !== null &&
    activeSnapshot !== null &&
    status === null &&
    entryById.has(selectedEntryId);

  return {
    threadId: state.threadId,
    filter: state.filter,
    showAllEntries,
    selectedEntryId,
    currentLeafId,
    openEntryId,
    hasTree,
    status,
    rows,
    totalCount,
    resultSummary: hasQuery
      ? `Showing ${rows.length} of ${countNoun(totalCount, showAllEntries)}`
      : countNoun(totalCount, showAllEntries),
    noResultsMessage: hasQuery && rows.length === 0 ? `No ${noun} match your search.` : null,
    emptyListMessage:
      !hasQuery && rows.length === 0 && activeSnapshot !== null && status === null
        ? `No ${noun} yet.`
        : null,
    hasLabels,
    labelsNotice: state.filter.showLabels && hasLabels ? LABELS_READ_ONLY_NOTICE : null,
    preview:
      previewNode === undefined
        ? null
        : {
            entryId: previewNode.node.entry.id,
            role: entryRole(previewNode.node.entry),
            timestamp: previewNode.node.entry.timestamp,
            text: entryPreview(previewNode.node.entry),
            ...(previewLabel === undefined ? {} : { label: previewLabel }),
            currentLeaf: previewNode.node.entry.id === currentLeafId,
          },
    pickerDisabledReason: status?.kind === "unavailable" ? status.message : undefined,
    canSelect,
  };
}
