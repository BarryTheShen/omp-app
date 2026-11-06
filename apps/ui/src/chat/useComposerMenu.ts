import type { FileSearchCandidate } from "@omp-app/contracts";
import type { ChatHostCommand, ExtensionCompletion } from "@omp-app/contracts/chat-host";
import { useEffect, useMemo, useState } from "react";
import { lastSeen } from "../lastSeen";
import type { MenuItem } from "./ComposerMenu";
import type { ChatController } from "./controller";
import { findTrigger, matchCommands, mentionText, replaceTrigger } from "./triggers";

/** omp's commands as the menu listed them last in a folder (its skills and prompts are the folder's), for this page. */
const keptCommands = (folder: string) => lastSeen<readonly ChatHostCommand[]>(`commands:${folder}`);

/** How long typing pauses before an `@` mention searches the folder. */
const SEARCH_PAUSE_MS = 120;
const MAX_COMMANDS = 50;

export interface ComposerMenuState {
  /** What opened the menu: `/` for omp's commands, `@` for a file. */
  readonly kind: "command" | "file";
  readonly label: string;
  readonly items: readonly MenuItem[];
  readonly active: number;
  readonly empty: string;
}

/**
 * The `/` and `@` menu for the text and caret of the message box: omp's commands (read once per chat) or the folder's
 * files (searched as the mention is typed). `move` steps the highlight, `pick` returns the text with a row put in, and
 * `dismiss` closes the menu until the caret leaves this trigger.
 */
export function useComposerMenu(
  controller: ChatController,
  text: string,
  caret: number,
): {
  readonly menu: ComposerMenuState | null;
  readonly move: (step: 1 | -1) => void;
  readonly pick: (index: number) => { readonly text: string; readonly caret: number } | null;
  readonly dismiss: () => void;
} {
  const trigger = useMemo(() => findTrigger(text, caret), [text, caret]);
  const triggerId = trigger === null ? null : `${trigger.kind}:${trigger.start}`;
  const [dismissed, setDismissed] = useState<string | null>(null);
  // A dismissal holds while the caret stays in that trigger; a `/` typed again later opens the menu again.
  if (dismissed !== null && triggerId !== dismissed) setDismissed(null);
  const open = trigger !== null && triggerId !== dismissed;
  const [commands, setCommands] = useState<readonly ChatHostCommand[] | null>(
    () => keptCommands(controller.folder).get() ?? null,
  );
  /** This box has read omp's commands: until then the menu shows the folder's list from last time. */
  const [read, setRead] = useState(false);
  const [files, setFiles] = useState<{
    readonly query: string;
    readonly found: readonly FileSearchCandidate[];
  } | null>(null);
  /** omp's extensions' rows for this exact text and caret (a note app's pages, say), shown after the files. */
  const [extensionRows, setExtensionRows] = useState<{
    readonly at: string;
    readonly rows: readonly ExtensionCompletion[];
  } | null>(null);
  const [active, setActive] = useState(0);

  const wantsCommands = open && trigger.kind === "command" && !read;
  useEffect(() => {
    if (!wantsCommands) return;
    let alive = true;
    controller
      .commands()
      .then((list) => {
        keptCommands(controller.folder).set(list);
        if (!alive) return;
        setCommands(list);
        setRead(true);
      })
      .catch(() => {
        if (!alive) return;
        setCommands((shown) => shown ?? []);
        setRead(true);
      });
    return () => {
      alive = false;
    };
  }, [wantsCommands, controller]);

  const fileQuery = open && trigger.kind === "file" ? trigger.query : null;
  useEffect(() => {
    if (fileQuery === null) return;
    let alive = true;
    const timer = window.setTimeout(() => {
      controller
        .searchFiles(fileQuery)
        .then((found) => alive && setFiles({ query: fileQuery, found }))
        .catch(() => alive && setFiles({ query: fileQuery, found: [] }));
    }, SEARCH_PAUSE_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [fileQuery, controller]);

  const extensionAt = fileQuery === null ? null : `${caret}:${text}`;
  useEffect(() => {
    if (extensionAt === null) return;
    let alive = true;
    const timer = window.setTimeout(() => {
      controller
        .extensionCompletions(text, caret)
        .then((rows) => alive && setExtensionRows({ at: extensionAt, rows }));
    }, SEARCH_PAUSE_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [extensionAt, controller, text, caret]);

  const items = useMemo<readonly MenuItem[]>(() => {
    if (!open) return [];
    if (trigger.kind === "command")
      return matchCommands(commands ?? [], trigger.query)
        .slice(0, MAX_COMMANDS)
        .map((command) => ({
          key: `/${command.name}`,
          kind: "command" as const,
          label: `/${command.name}`,
          detail: command.description,
        }));
    const found: MenuItem[] = (files?.found ?? []).map((candidate) => ({
      key: candidate.path,
      kind: candidate.kind,
      label: candidate.kind === "directory" ? `${candidate.path}/` : candidate.path,
    }));
    const offered = extensionRows?.at === `${caret}:${text}` ? extensionRows.rows : [];
    return [
      ...found,
      ...offered.map((row, index) => ({
        key: `extension:${index}:${row.label}`,
        kind: "extension" as const,
        label: row.label,
        detail: row.detail,
        result: { text: row.text, caret: row.caret },
      })),
    ];
  }, [open, trigger, commands, files, extensionRows, text, caret]);

  // A new trigger or a new list starts at its first row.
  const itemKeys = items.map((item) => item.key).join("\n");
  // biome-ignore lint/correctness/useExhaustiveDependencies: the highlight resets when the trigger or the rows change
  useEffect(() => setActive(0), [triggerId, itemKeys]);

  if (!open)
    return { menu: null, move: () => undefined, pick: () => null, dismiss: () => undefined };
  const searching = trigger.kind === "file" && files?.query !== trigger.query;
  const menu: ComposerMenuState = {
    kind: trigger.kind,
    label:
      trigger.kind === "command"
        ? "omp's commands"
        : items.some((item) => item.kind === "extension")
          ? "Files and more to mention"
          : "Files to mention",
    items,
    active: Math.min(active, Math.max(0, items.length - 1)),
    empty:
      trigger.kind === "command"
        ? commands === null
          ? "Reading omp's commands…"
          : "No command matches."
        : searching
          ? "Searching the folder…"
          : "No file matches.",
  };
  return {
    menu,
    move: (step) => {
      if (items.length > 0) setActive((current) => (current + step + items.length) % items.length);
    },
    pick: (index) => {
      const item = items[index];
      if (item === undefined) return null;
      if (item.kind === "extension") return item.result ?? null;
      const replacement =
        item.kind === "command"
          ? `${item.label} `
          : item.kind === "directory"
            ? mentionText(item.label).trimEnd()
            : mentionText(item.key);
      return replaceTrigger(text, trigger, replacement);
    },
    dismiss: () => setDismissed(triggerId),
  };
}
