import type { FileSearchCandidate } from "@omp-app/contracts";
import type { ChatHostCommand, ExtensionCompletion } from "@omp-app/contracts/chat-host";
import { useEffect, useMemo, useState } from "react";
import { lastSeen } from "../lastSeen";
import type { MenuItem } from "./ComposerMenu";
import type { ChatController } from "./controller";
import {
  askedAs,
  type BoxState,
  findTrigger,
  folderMention,
  matchCommands,
  mentionText,
  rebaseRow,
  replaceTrigger,
} from "./triggers";

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

/** The folder's files found for a mention: where the mention starts, and what was searched. */
interface FileAnswer {
  readonly start: number;
  readonly query: string;
  readonly found: readonly FileSearchCandidate[];
}

/** omp's extensions' rows for a mention: where it starts, the box they were asked about, and the box then. */
interface ExtensionAnswer {
  readonly start: number;
  readonly asked: BoxState;
  readonly box: BoxState;
  readonly rows: readonly ExtensionCompletion[];
}

/** An extension's row as the menu lists it: the box once it is taken. */
interface OfferedRow {
  readonly label: string;
  readonly detail: string | undefined;
  readonly result: BoxState;
}

/**
 * The extension rows to show for the box now: the answer for this text and caret as it came, or the latest answer for
 * the same mention put on the box as it is now, so rows stay until the new answer arrives (#2846). A row that cannot be
 * put on it waits for the new answer.
 */
function offeredRows(
  answer: ExtensionAnswer | null,
  start: number,
  box: BoxState,
): readonly OfferedRow[] {
  if (answer === null || answer.start !== start) return [];
  const current = answer.box.text === box.text && answer.box.caret === box.caret;
  return answer.rows.flatMap((row) => {
    const result = current
      ? { text: row.text, caret: row.caret }
      : rebaseRow(row, answer.asked, start, box);
    return result === null ? [] : [{ label: row.label, detail: row.detail, result }];
  });
}

/**
 * The `/` and `@` menu for the text and caret of the message box: omp's commands (read once per chat) or the folder's
 * files and omp's extensions' rows (searched as the mention is typed). A mention of words with spaces (`@lecture 3`)
 * stays open while rows match and ends once nothing does (#2846). `move` steps the highlight; `pick` returns the box
 * with a row put in, or a promise of it when the row must first be found in an answer still coming; `dismiss` closes the
 * menu until the caret leaves this trigger.
 */
export function useComposerMenu(
  controller: ChatController,
  text: string,
  caret: number,
): {
  readonly menu: ComposerMenuState | null;
  readonly move: (step: 1 | -1) => void;
  readonly pick: (index: number) => BoxState | Promise<BoxState | null> | null;
  readonly dismiss: () => void;
} {
  const found = useMemo(() => findTrigger(text, caret), [text, caret]);
  /** A mention of words whose answers found nothing: closed, and not searched, while more is typed after those words. */
  const [ended, setEnded] = useState<{ readonly start: number; readonly query: string } | null>(
    null,
  );
  const spaced = found?.kind === "file" && found.form === "spaced" ? found : null;
  const stillEnded =
    ended !== null &&
    spaced !== null &&
    spaced.start === ended.start &&
    spaced.query.startsWith(ended.query);
  // Leaving that mention, or going back before those words, forgets that it ended.
  if (ended !== null && !stillEnded) setEnded(null);
  const trigger = stillEnded ? null : found;
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
  const [files, setFiles] = useState<FileAnswer | null>(null);
  /** omp's extensions' rows (a note app's pages, say), shown after the files. */
  const [extension, setExtension] = useState<ExtensionAnswer | null>(null);
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

  const mention = open && trigger.kind === "file" ? trigger : null;
  const mentionStart = mention?.start ?? null;
  /** What the folder is searched for: the mention's query without the spaces around it. */
  const fileQuery = mention === null ? null : mention.query.trim();
  useEffect(() => {
    if (fileQuery === null || mentionStart === null) return;
    let alive = true;
    const timer = window.setTimeout(() => {
      controller
        .searchFiles(fileQuery)
        .then((found) => alive && setFiles({ start: mentionStart, query: fileQuery, found }))
        .catch(() => alive && setFiles({ start: mentionStart, query: fileQuery, found: [] }));
    }, SEARCH_PAUSE_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [fileQuery, mentionStart, controller]);

  // Extensions are asked about words with spaces in their quoted form, as omp's terminal asks them.
  const asked = mention === null ? null : askedAs(text, caret, mention);
  const askedText = asked?.text ?? null;
  const askedCaret = asked?.caret ?? null;
  useEffect(() => {
    if (askedText === null || askedCaret === null || mentionStart === null) return;
    let alive = true;
    const box = { text, caret };
    const timer = window.setTimeout(() => {
      controller.extensionCompletions(askedText, askedCaret).then(
        (rows) =>
          alive &&
          setExtension({
            start: mentionStart,
            asked: { text: askedText, caret: askedCaret },
            box,
            rows,
          }),
      );
    }, SEARCH_PAUSE_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [askedText, askedCaret, mentionStart, text, caret, controller]);

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
    // Words with spaces list only their own mention's files; a word or a name in quotes, the latest found, as before.
    const own = trigger.form !== "spaced" || files?.start === trigger.start;
    const found: MenuItem[] = (own ? (files?.found ?? []) : []).map((candidate) => ({
      key: candidate.path,
      kind: candidate.kind,
      label: candidate.kind === "directory" ? `${candidate.path}/` : candidate.path,
    }));
    return [
      ...found,
      ...offeredRows(extension, trigger.start, { text, caret }).map((row, index) => ({
        key: `extension:${index}:${row.label}`,
        kind: "extension" as const,
        label: row.label,
        detail: row.detail,
        result: row.result,
      })),
    ];
  }, [open, trigger, commands, files, extension, text, caret]);

  /** Both answers for this mention as typed now are in. */
  const answered =
    mention !== null &&
    files !== null &&
    files.start === mention.start &&
    files.query === fileQuery &&
    extension !== null &&
    extension.start === mention.start &&
    extension.box.text === text &&
    extension.box.caret === caret;
  /** Words with spaces that nothing matches: their menu is closed, and ends once both answers are in. */
  const nothingMatches = mention !== null && mention.form === "spaced" && items.length === 0;
  useEffect(() => {
    if (nothingMatches && answered && mention !== null)
      setEnded({ start: mention.start, query: mention.query });
  }, [nothingMatches, answered, mention]);

  // A new trigger or a new list starts at its first row.
  const itemKeys = items.map((item) => item.key).join("\n");
  // biome-ignore lint/correctness/useExhaustiveDependencies: the highlight resets when the trigger or the rows change
  useEffect(() => setActive(0), [triggerId, itemKeys]);

  if (!open || nothingMatches)
    return { menu: null, move: () => undefined, pick: () => null, dismiss: () => undefined };
  const searching = trigger.kind === "file" && files?.query !== fileQuery;
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
  /** The box with a row put in, on the text as it is now. */
  const take = (item: MenuItem): BoxState | null => {
    if (item.kind === "extension") return item.result ?? null;
    const replacement =
      item.kind === "command"
        ? `${item.label} `
        : item.kind === "directory"
          ? folderMention(item.label)
          : mentionText(item.key);
    return replaceTrigger(text, trigger, replacement);
  };
  /**
   * Words with spaces whose answer is still coming: both are asked at once, and the row is taken only if the answer
   * still has it, so a quick Enter after a sentence never puts a row from before in place of what was typed (#2846).
   */
  const takeWhenAnswered = async (item: MenuItem): Promise<BoxState | null> => {
    if (mention === null || fileQuery === null || asked === null) return null;
    const start = mention.start;
    const query = fileQuery;
    const [found, rows] = await Promise.all([
      controller.searchFiles(query).catch((): readonly FileSearchCandidate[] => []),
      controller.extensionCompletions(asked.text, asked.caret),
    ]);
    setFiles({ start, query, found });
    setExtension({ start, asked, box: { text, caret }, rows });
    if (item.kind === "extension") {
      const row = rows.find((each) => each.label === item.label && each.detail === item.detail);
      return row === undefined ? null : { text: row.text, caret: row.caret };
    }
    return found.some((each) => each.path === item.key && each.kind === item.kind)
      ? take(item)
      : null;
  };
  return {
    menu,
    move: (step) => {
      if (items.length > 0) setActive((current) => (current + step + items.length) % items.length);
    },
    pick: (index) => {
      const item = items[index];
      if (item === undefined) return null;
      if (mention?.form === "spaced" && !answered) return takeWhenAnswered(item);
      return take(item);
    },
    dismiss: () => setDismissed(triggerId),
  };
}
