import { cn } from "cn";
import { X } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import type { WorkspaceTab } from "./tabs";

/**
 * kitty's tab bar, on top: shown once there are two tabs. A click activates a tab, a middle click or × closes it, a
 * double click renames it (Enter keeps the name, Esc leaves it; an empty name goes back to the chat's title).
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
}: {
  readonly tabs: readonly WorkspaceTab[];
  readonly active: string;
  /** Each tab's label: its name, or its focused chat's title. */
  readonly labels: ReadonlyMap<string, string>;
  /** The tab whose name is being typed, if any. */
  readonly renaming: string | null;
  readonly onActivate: (id: string) => void;
  readonly onClose: (id: string) => void;
  readonly onRename: (id: string, title: string) => void;
  readonly onRenaming: (id: string | null) => void;
}): ReactNode {
  return (
    <div
      data-tour="tabs"
      role="tablist"
      aria-label="Tabs"
      className="flex h-9 shrink-0 items-end gap-0.5 overflow-x-auto px-1.5 pt-1"
    >
      {tabs.map((tab, index) => {
        const label = labels.get(tab.id) ?? `Tab ${index + 1}`;
        const selected = tab.id === active;
        return (
          <div
            key={tab.id}
            className={cn(
              "group/tab flex h-8 max-w-56 min-w-24 shrink-0 items-center gap-1 rounded-t-lg pr-1 pl-3 text-xs",
              selected ? "bg-panel text-t1" : "text-t2 hover:bg-l1 hover:text-t1",
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
                className="min-w-0 flex-1 truncate text-left outline-none focus-visible:underline"
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
              aria-label={`Close ${label}`}
              className="grid size-5 shrink-0 place-items-center rounded-sm text-t3 opacity-0 group-hover/tab:opacity-100 hover:bg-l2 hover:text-t1 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
              onClick={() => onClose(tab.id)}
            >
              <X className="size-3" />
            </button>
          </div>
        );
      })}
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
      aria-label="Tab name"
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
