import type { DescriptorId } from "@omp-app/contracts";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { P1_AGENT_HUB_TYPED_COMMAND } from "@/modules/P1/hub/descriptors";
import { U0_GOAL_TYPED_COMMAND, U0_SHORTCUT_SHEET_COMMAND } from "@/palette/descriptor";
import { capabilityStatus, useCapabilities } from "@/registry-core";
import { chordHasKey, chordLabel, isApplePlatform, storedChord } from "./chord-label";
import {
  useShortcutBindings,
  useShortcutError,
  useShortcutPreferenceError,
  useShortcutRegistry,
} from "./context";
import type { ShortcutConflict } from "./registry";

/** The app's typed commands that open a surface or run an omp command; the sheet lists them under Typed commands. */
const TYPED_COMMANDS = [P1_AGENT_HUB_TYPED_COMMAND, U0_GOAL_TYPED_COMMAND];

export interface ShortcutSheetProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

/** Plain names for the scopes whose ids are not words a person knows. */
const SCOPE_NAMES: Partial<Record<string, string>> = {
  "session-list": "Session list",
};

function formatScope(scope: string): string {
  return (
    SCOPE_NAMES[scope] ??
    scope.replace(/^panel:/, "Panel: ").replace(/^./, (char) => char.toUpperCase())
  );
}

/** Names the other shortcut that already runs on the chord, by its title, in plain words. */
function conflictRefusal(
  chord: string,
  id: DescriptorId,
  conflicts: readonly ShortcutConflict[],
): string {
  const titles = [
    ...new Set(conflicts.map(({ first, second }) => (first.id === id ? second : first).title)),
  ];
  return `${chord} is already used by ${titles.map((title) => `“${title}”`).join(" and ")}.`;
}

/** Searchable grouped shortcut sheet with conflict-safe rebinding and reset. */
export function ShortcutSheet({ open, onOpenChange }: ShortcutSheetProps) {
  const registry = useShortcutRegistry();
  const apple = isApplePlatform();
  const shortcutError = useShortcutError();
  const shortcutPreferenceError = useShortcutPreferenceError();
  const bindings = useShortcutBindings();
  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState<string | undefined>(undefined);
  const capabilities = useCapabilities();
  const [conflict, setConflict] = useState<string | undefined>(undefined);
  const normalizedQuery = query.trim().toLowerCase();
  // A shortcut whose omp command or host feature is missing is not offered, as the palette does not
  // offer a command it cannot run.
  const visible = useMemo(
    () =>
      bindings.filter(
        (binding) =>
          binding.requires.every((key) => {
            const state = capabilityStatus(capabilities, key)?.state;
            return state === "available" || state === "fallback";
          }) &&
          (normalizedQuery.length === 0 ||
            `${binding.title} ${binding.scope} ${binding.chord} ${chordLabel(binding.chord, { mac: apple })}`
              .toLowerCase()
              .includes(normalizedQuery)),
      ),
    [apple, bindings, capabilities, normalizedQuery],
  );
  const groups = new Map<string, typeof visible>();
  for (const binding of visible)
    groups.set(binding.scope, [...(groups.get(binding.scope) ?? []), binding]);
  const typedCommands = TYPED_COMMANDS.filter(
    (command) =>
      normalizedQuery.length === 0 ||
      `${command.title} ${command.text}`.toLowerCase().includes(normalizedQuery),
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby="shortcut-sheet-description"
        className="max-w-2xl rounded-surface border border-foreground/10 shadow-none ring-0"
      >
        <DialogHeader>
          <DialogTitle className="text-sm font-medium">Keyboard shortcuts</DialogTitle>
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
                        <span className="min-w-0 text-sm">{binding.title}</span>
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
                          defaultValue={chordLabel(binding.chord, { mac: apple })}
                          onBlur={(event) => {
                            const shown = chordLabel(binding.chord, { mac: apple });
                            const typed = event.currentTarget.value.trim();
                            setEditingId(undefined);
                            // A field left with the text it showed stores nothing.
                            if (typed === shown) {
                              setConflict(undefined);
                              return;
                            }
                            const chord = storedChord(typed);
                            // A chord with no key cannot be pressed: it is refused and the old chord stays.
                            if (!chordHasKey(chord)) {
                              setConflict("Add a key, for example Ctrl+K.");
                              return;
                            }
                            const result = registry.rebind(binding.id, chord);
                            // A refusal names the chord the way the person's keyboard does, not the stored form.
                            const shownChord = chordLabel(chord, { mac: apple });
                            const refusal = result.error?.split(chord).join(shownChord);
                            setConflict(
                              result.ok
                                ? undefined
                                : (refusal ??
                                    conflictRefusal(shownChord, binding.id, result.conflicts)),
                            );
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
                            {chordLabel(binding.chord, { mac: apple })}
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
          {typedCommands.length > 0 && (
            <section className="border-border mt-4 border-t pt-3 first:mt-0 first:border-t-0">
              <h3 className="text-muted-foreground mb-2 text-xs font-semibold uppercase tracking-wide">
                Typed commands
              </h3>
              <div className="space-y-1">
                {typedCommands.map((command) => (
                  <div
                    className="flex items-center justify-between gap-3 rounded-md px-2 py-2 hover:bg-muted"
                    key={command.text}
                  >
                    <span className="min-w-0 text-sm">{command.title}</span>
                    <code className="shrink-0 font-mono text-xs">{command.text}</code>
                  </div>
                ))}
              </div>
            </section>
          )}
          {visible.length === 0 && typedCommands.length === 0 && (
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
  // omp's /hotkeys and the palette's "Keyboard shortcuts" both open this sheet.
  useEffect(
    () => registry.registerCommand(U0_SHORTCUT_SHEET_COMMAND.id, { run: () => setOpen(true) }),
    [registry],
  );
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
