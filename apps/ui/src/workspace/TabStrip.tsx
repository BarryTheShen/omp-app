import { cn } from "cn";
import { Plus, X } from "lucide-react";
import { type DragEvent, type ReactNode, useRef, useState } from "react";
import { useSidewaysRow } from "../sidewaysRow";
import type { WorkspaceTab } from "./tabs";

/** What a workspace's tab carries while it is dragged along the strip. */
const TAB_TYPE = "application/x-omp-app-workspace";

const carriesTab = (event: DragEvent): boolean => event.dataTransfer.types.includes(TAB_TYPE);

/**
 * The workspaces (#2791), as kitty's tab bar, on top: always shown, with + after them for a new one. A click shows a
 * workspace, a middle click or × closes it, a double click renames it (Enter keeps the name, Esc leaves it; an empty
 * name goes back to its first chat's title), and a drag moves it along the strip.
 */
export function TabStrip({
  tabs,
  active,
  labels,
  renaming,
  onActivate,
  onClose,
  onRename,
  onRenaming,
  onAdd,
  onMove,
  leading,
}: {
  readonly tabs: readonly WorkspaceTab[];
  readonly active: string;
  /** Each workspace's label: its name, or its first chat's title. */
  readonly labels: ReadonlyMap<string, string>;
  /** The workspace whose name is being typed, if any. */
  readonly renaming: string | null;
  readonly onActivate: (id: string) => void;
  readonly onClose: (id: string) => void;
  readonly onRename: (id: string, title: string) => void;
  readonly onRenaming: (id: string | null) => void;
  readonly onAdd: () => void;
  /** A workspace dragged onto another's place. */
  readonly onMove: (id: string, to: number) => void;
  /** Before the tabs: Show the chat list while it is hidden (#2805). */
  readonly leading?: ReactNode;
}): ReactNode {
  /** The tab a dragged one would land on. */
  const [over, setOver] = useState<string | null>(null);
  const tabRow = useSidewaysRow(active);
  return (
    <div className="flex h-9 shrink-0 items-end gap-0.5 px-1.5 pt-1 tablet:h-12">
      {leading}
      <div
        ref={tabRow}
        data-tour="tabs"
        role="tablist"
        aria-label="Workspaces"
        className="row-scroll flex min-w-0 items-end gap-0.5"
      >
        {tabs.map((tab, index) => {
          const label = labels.get(tab.id) ?? "New workspace";
          const selected = tab.id === active;
          return (
            // biome-ignore lint/a11y/noStaticElementInteractions: the drag moves the tab; its buttons are its controls
            <div
              key={tab.id}
              draggable={renaming !== tab.id}
              onDragStart={(event) => {
                event.dataTransfer.setData(TAB_TYPE, tab.id);
                event.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(event) => {
                if (!carriesTab(event)) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                setOver(tab.id);
              }}
              onDragLeave={() => setOver((now) => (now === tab.id ? null : now))}
              onDrop={(event) => {
                if (!carriesTab(event)) return;
                event.preventDefault();
                setOver(null);
                onMove(event.dataTransfer.getData(TAB_TYPE), index);
              }}
              onDragEnd={() => setOver(null)}
              className={cn(
                "group/tab flex h-8 max-w-56 min-w-24 shrink-0 items-center gap-1 rounded-t-lg pr-1 pl-3 text-xs tablet:h-11",
                selected ? "bg-panel text-t1" : "text-t2 hover:bg-l1 hover:text-t1",
                over === tab.id && "ring-1 ring-accent-ink ring-inset",
              )}
            >
              {renaming === tab.id ? (
                <RenameInput
                  initial={tab.title ?? label}
                  onDone={(title) => {
                    if (title !== null) onRename(tab.id, title);
                    onRenaming(null);
                  }}
                />
              ) : (
                <button
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  className="min-w-0 flex-1 self-stretch truncate text-left outline-none focus-visible:underline"
                  onClick={() => onActivate(tab.id)}
                  onDoubleClick={() => onRenaming(tab.id)}
                  onAuxClick={(event) => {
                    if (event.button === 1) onClose(tab.id);
                  }}
                >
                  {label}
                </button>
              )}
              <button
                type="button"
                aria-label={`Close the workspace ${label}`}
                className="grid size-5 shrink-0 place-items-center rounded-sm text-t3 opacity-0 group-hover/tab:opacity-100 hover:bg-l2 hover:text-t1 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 tablet:size-11"
                onClick={() => onClose(tab.id)}
              >
                <X className="size-3" />
              </button>
            </div>
          );
        })}
      </div>
      <button
        type="button"
        aria-label="New workspace"
        title="New workspace"
        className="mb-0.5 grid size-7 shrink-0 place-items-center rounded-md text-t3 hover:bg-l1 hover:text-t1 tablet:size-11"
        onClick={onAdd}
      >
        <Plus className="size-4" />
      </button>
    </div>
  );
}

function RenameInput({
  initial,
  onDone,
}: {
  readonly initial: string;
  readonly onDone: (title: string | null) => void;
}): ReactNode {
  const [value, setValue] = useState(initial);
  // Enter or Esc ends it; the blur that follows must not end it again.
  const ended = useRef(false);
  const end = (title: string | null): void => {
    if (ended.current) return;
    ended.current = true;
    onDone(title);
  };
  return (
    <input
      aria-label="Workspace name"
      // biome-ignore lint/a11y/noAutofocus: renaming starts typing in the name at once
      autoFocus
      className="min-w-0 flex-1 rounded-sm bg-transparent text-xs text-t1 outline-none ring-1 ring-l3"
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onFocus={(event) => event.currentTarget.select()}
      onBlur={() => end(value)}
      onKeyDown={(event) => {
        // The workspace's keys do not act on the name being typed.
        event.stopPropagation();
        if (event.key === "Enter") end(value);
        if (event.key === "Escape") end(null);
      }}
    />
  );
}
