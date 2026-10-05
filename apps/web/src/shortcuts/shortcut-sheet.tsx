import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  useShortcutBindings,
  useShortcutError,
  useShortcutPreferenceError,
  useShortcutRegistry,
} from "./context";

export interface ShortcutSheetProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

function formatScope(scope: string): string {
  return scope.replace(/^panel:/, "Panel: ").replace(/^./, (char) => char.toUpperCase());
}

/** Searchable grouped shortcut sheet with conflict-safe rebinding and reset. */
export function ShortcutSheet({ open, onOpenChange }: ShortcutSheetProps) {
  const registry = useShortcutRegistry();
  const shortcutError = useShortcutError();
  const shortcutPreferenceError = useShortcutPreferenceError();
  const bindings = useShortcutBindings();
  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState<string | undefined>(undefined);
  const [conflict, setConflict] = useState<string | undefined>(undefined);
  const normalizedQuery = query.trim().toLowerCase();
  const visible = useMemo(
    () =>
      bindings.filter(
        (binding) =>
          normalizedQuery.length === 0 ||
          `${binding.title} ${binding.scope} ${binding.chord}`
            .toLowerCase()
            .includes(normalizedQuery),
      ),
    [bindings, normalizedQuery],
  );
  const groups = new Map<string, typeof visible>();
  for (const binding of visible)
    groups.set(binding.scope, [...(groups.get(binding.scope) ?? []), binding]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby="shortcut-sheet-description" className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription id="shortcut-sheet-description">
            Search, rebind, or reset shortcuts. Changes are saved to app preferences.
          </DialogDescription>
        </DialogHeader>
        <input
          aria-label="Search shortcuts"
          className="border-input bg-background focus-visible:ring-ring rounded-md border px-3 py-2 text-sm outline-none focus-visible:ring-2"
          placeholder="Search shortcuts"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="max-h-[60vh] overflow-y-auto pe-1">
          {[...groups.entries()].map(([scope, entries]) => (
            <section
              className="border-border mt-4 border-t pt-3 first:mt-0 first:border-t-0"
              key={scope}
            >
              <h3 className="text-muted-foreground mb-2 text-xs font-semibold uppercase tracking-wide">
                {formatScope(scope)}
              </h3>
              <div className="space-y-1">
                {entries.map((binding) => {
                  const editing = editingId === binding.id;
                  return (
                    <div
                      className="flex items-center justify-between gap-3 rounded-md px-2 py-2 hover:bg-muted"
                      key={binding.id}
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="min-w-0 truncate text-sm">{binding.title}</span>
                        {registry.isBrowserReserved(binding.defaultChord, binding.scope) && (
                          <span
                            className="text-warning shrink-0 text-xs"
                            role="status"
                            title="Your browser keeps this default shortcut for itself"
                          >
                            Browser reserved
                          </span>
                        )}
                      </div>
                      {editing ? (
                        <input
                          aria-label={`Rebind ${binding.title}`}
                          autoFocus
                          className="border-input w-32 rounded-md border px-2 py-1 text-right font-mono text-xs"
                          defaultValue={binding.chord}
                          onBlur={(event) => {
                            const result = registry.rebind(binding.id, event.currentTarget.value);
                            setConflict(
                              result.ok
                                ? undefined
                                : (result.error ??
                                    `Shortcut conflicts with ${[
                                      ...new Set(
                                        result.conflicts.flatMap(({ first, second }) => [
                                          first.owner,
                                          second.owner,
                                        ]),
                                      ),
                                    ].join(" and ")}.`),
                            );
                            setEditingId(undefined);
                          }}
                          onKeyDown={(event) => {
                            if (event.key === "Escape") {
                              setEditingId(undefined);
                              return;
                            }
                            if (event.key === "Enter") event.currentTarget.blur();
                          }}
                        />
                      ) : (
                        <div className="flex shrink-0 items-center gap-1">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setEditingId(binding.id)}
                          >
                            {binding.chord}
                          </Button>
                          {binding.chord !== binding.defaultChord && (
                            <Button
                              aria-label={`Reset ${binding.title}`}
                              size="sm"
                              variant="ghost"
                              onClick={() => {
                                registry.reset(binding.id);
                                setConflict(undefined);
                              }}
                            >
                              Reset
                            </Button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
          {visible.length === 0 && (
            <p className="text-muted-foreground py-6 text-center text-sm">No shortcuts found.</p>
          )}
        </div>
        {conflict !== undefined && (
          <p className="text-danger text-sm" role="alert">
            {conflict}
          </p>
        )}
        {shortcutError !== undefined && (
          <p className="text-danger text-sm" role="alert">
            Could not run “{shortcutError.binding.title}”. Try again.
          </p>
        )}
        {shortcutPreferenceError !== undefined && (
          <p className="text-danger text-sm" role="alert">
            Could not load saved shortcuts. Reset all to clear app preferences.
          </p>
        )}
        <div className="flex justify-end">
          <Button
            variant="outline"
            onClick={() => {
              registry.resetAll();
              setConflict(undefined);
            }}
          >
            Reset all
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Opens the sheet from `?` or Mod+/ without stealing editable-field input. */
export function ShortcutSheetHost({ children }: { readonly children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const registry = useShortcutRegistry();
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
      )
        return;
      const slash = event.key === "/" && (event.ctrlKey || event.metaKey);
      if (event.key === "?" || slash) {
        event.preventDefault();
        setOpen(true);
      }
      registry.dispatch(event, "global");
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [registry]);
  return (
    <>
      {children}
      <ShortcutSheet open={open} onOpenChange={setOpen} />
    </>
  );
}
