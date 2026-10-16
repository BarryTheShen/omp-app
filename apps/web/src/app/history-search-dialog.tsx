import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useShortcutRegistry } from "@/shortcuts";
import { searchPrompts } from "./history-search";

/** The U2 descriptor id of Ctrl+R (`app.history.search` in omp). */
export const HISTORY_SEARCH_SHORTCUT_ID = "U2.historySearchShortcut";

/** What the search dialog says, in plain English. */
export const HISTORY_SEARCH_MESSAGES = {
  title: "Search earlier messages",
  description:
    "Enter puts the chosen message in the message box, in place of what is there. Esc closes.",
  search: "Type words to search",
  none: "You have not sent any messages yet.",
  noMatch: "No earlier message has all of these words.",
} as const;

/** The most rows the dialog lists at once; a long history is narrowed by typing. */
const MAX_ROWS = 100;

/** The first line of a message, with its spacing collapsed, for one row. */
function firstLine(text: string): string {
  return text.trim().split("\n", 1)[0]?.replace(/\s+/g, " ").trim() ?? "";
}

export interface HistorySearchDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The messages you sent, oldest first. Read each time the dialog opens. */
  readonly readPrompts: () => readonly string[];
  readonly onPick: (text: string) => void;
}

export function HistorySearchDialog({
  open,
  onOpenChange,
  readPrompts,
  onPick,
}: HistorySearchDialogProps) {
  const descriptionId = useId();
  const listId = useId();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const prompts = useMemo(() => (open ? readPrompts() : []), [open, readPrompts]);
  const results = useMemo(() => searchPrompts(prompts, query).slice(0, MAX_ROWS), [prompts, query]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
  }, [open]);

  /** Moves the highlight to one row and scrolls that row into view, so Enter picks a row the person can see. */
  const highlight = (position: number): void => {
    setActive(position);
    document.getElementById(`${listId}-${position}`)?.scrollIntoView({ block: "nearest" });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      highlight(Math.min(active + 1, results.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      highlight(Math.max(active - 1, 0));
    } else if (event.key === "Enter") {
      const chosen = results[active];
      if (chosen === undefined) return;
      event.preventDefault();
      onPick(chosen.text);
    }
  };

  const hasRows = prompts.length > 0 && results.length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={descriptionId} className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{HISTORY_SEARCH_MESSAGES.title}</DialogTitle>
          <DialogDescription id={descriptionId}>
            {HISTORY_SEARCH_MESSAGES.description}
          </DialogDescription>
        </DialogHeader>
        <Input
          type="search"
          aria-label={HISTORY_SEARCH_MESSAGES.search}
          aria-controls={hasRows ? listId : undefined}
          aria-activedescendant={hasRows ? `${listId}-${active}` : undefined}
          placeholder={HISTORY_SEARCH_MESSAGES.search}
          value={query}
          autoFocus
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
            // A new search starts at the top of the list, so the row Enter picks is in view.
            if (listRef.current) listRef.current.scrollTop = 0;
          }}
          onKeyDown={onKeyDown}
        />
        {prompts.length === 0 ? (
          <p className="text-muted-foreground text-sm">{HISTORY_SEARCH_MESSAGES.none}</p>
        ) : results.length === 0 ? (
          <p className="text-muted-foreground text-sm">{HISTORY_SEARCH_MESSAGES.noMatch}</p>
        ) : (
          <div
            id={listId}
            ref={listRef}
            role="listbox"
            aria-label={HISTORY_SEARCH_MESSAGES.title}
            className="flex max-h-80 flex-col gap-1 overflow-y-auto"
          >
            {results.map((hit, position) => (
              <div
                key={hit.index}
                id={`${listId}-${position}`}
                role="option"
                tabIndex={-1}
                aria-selected={position === active}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActive(position)}
                onClick={() => onPick(hit.text)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") onPick(hit.text);
                }}
                className={`truncate rounded-md px-3 py-2 ${
                  position === active ? "bg-accent text-accent-foreground" : ""
                }`}
              >
                {firstLine(hit.text)}
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Keeps Ctrl+R's action registered while the open chat is mounted. The chord acts only while the message box has focus:
 * its descriptor says so, and the registry checks it before the key is prevented.
 */
export function useHistorySearchShortcut(open: () => void): void {
  const registry = useShortcutRegistry();
  useEffect(
    () => registry.registerAction(HISTORY_SEARCH_SHORTCUT_ID, () => open()),
    [open, registry],
  );
}
