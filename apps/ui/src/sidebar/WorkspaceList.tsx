import { cn } from "cn";
import { AppWindow, X } from "lucide-react";
import { type ReactNode, useState, useSyncExternalStore } from "react";
import { carriesTab, RenameInput, TAB_TYPE } from "../workspace/TabStrip";
import type { WorkspacesStore } from "../workspace/workspaces";

const REVEAL =
  "opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100";

/**
 * The workspaces as rows at the top of the chat list, as Zen's sidebar lists a browser's spaces: the one shown marked.
 * A click shows one, a double click renames it (Enter keeps the name, Esc leaves it; an empty name goes back to its
 * first chat's title), a middle click or × closes it, and a drag moves it up or down. The same tabs as the strip on top
 * had (`TabStrip`), which comes back while the list is hidden.
 */
export function WorkspaceList({ store }: { readonly store: WorkspacesStore }): ReactNode {
  const view = useSyncExternalStore(store.subscribe, store.getSnapshot);
  /** The row a dragged one would land on. */
  const [over, setOver] = useState<string | null>(null);
  const act = store.actions;
  if (view === null || act === null) return null;
  return (
    <div data-tour="tabs" role="tablist" aria-label="Workspaces" aria-orientation="vertical">
      {view.tabs.map((tab, index) => {
        const label = view.labels.get(tab.id) ?? "New workspace";
        const selected = tab.id === view.active;
        return (
          // biome-ignore lint/a11y/noStaticElementInteractions: the drag moves the row; its buttons are its controls
          <div
            key={tab.id}
            draggable={view.renaming !== tab.id}
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
              act.move(event.dataTransfer.getData(TAB_TYPE), index);
            }}
            onDragEnd={() => setOver(null)}
            className={cn(
              "group/row flex items-center rounded-md hover:bg-l1",
              selected && "bg-l2",
              over === tab.id && "ring-1 ring-accent-ink ring-inset",
            )}
          >
            {view.renaming === tab.id ? (
              <div className="flex h-8 min-w-0 flex-1 items-center px-2 tablet:h-11">
                <RenameInput
                  initial={tab.title ?? label}
                  onDone={(title) => {
                    if (title !== null) act.rename(tab.id, title);
                    act.renaming(null);
                  }}
                />
              </div>
            ) : (
              <button
                type="button"
                role="tab"
                aria-selected={selected}
                className={cn(
                  "flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-t2 outline-none group-hover/row:text-t1 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset tablet:h-11",
                  selected && "text-t1",
                )}
                onClick={() => act.activate(tab.id)}
                onDoubleClick={() => act.renaming(tab.id)}
                onAuxClick={(event) => {
                  if (event.button === 1) act.close(tab.id);
                }}
              >
                <AppWindow className="size-3.5 shrink-0 text-t3" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-[0.8125rem]">{label}</span>
              </button>
            )}
            <button
              type="button"
              // Not named after the workspace: its label is its first chat's title, which the chat's own row has.
              aria-label="Close workspace"
              title={`Close the workspace ${label}`}
              className={cn(
                "mr-1 grid size-6 shrink-0 place-items-center rounded-sm text-t3 hover:bg-l2 hover:text-t1 tablet:size-11",
                REVEAL,
              )}
              onClick={() => act.close(tab.id)}
            >
              <X className="size-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
