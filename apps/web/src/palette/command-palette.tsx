import type { CapabilityKey, CapabilityMap, CommandDescriptor } from "@omp-app/contracts";
import { cn } from "cn";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { type OverlayCloseReason, type OverlayOpenResult, useOverlayHost } from "@/overlay";
import { DESCRIPTORS } from "@/registry";
import { capabilityStatus, isDescriptorAvailable, useCapabilities } from "@/registry-core";
import { useShortcutRegistry, useShortcutScope } from "@/shortcuts";
import { U0_COMMAND_PALETTE_SHORTCUT } from "./descriptor";

export interface CommandPaletteHostProps {
  readonly onCommandSelect: (command: CommandDescriptor) => void;
}

interface CommandEntry {
  readonly descriptor: CommandDescriptor;
  readonly available: boolean;
  readonly reason: string | undefined;
}

const COMMAND_DESCRIPTORS: readonly CommandDescriptor[] = DESCRIPTORS.filter(
  (descriptor): descriptor is CommandDescriptor => descriptor.kind === "command",
);

function unavailableReason(key: CapabilityKey, capabilities: CapabilityMap): string {
  const status = capabilityStatus(capabilities, key);
  switch (status?.via) {
    case "upstream":
      return "This command needs a newer version of omp.";
    case "rpc":
      return "The connected omp process does not support this command.";
    case "host":
      return "The app host does not provide this command.";
    case "client":
      return "This command is not available in this browser.";
    default:
      return "The current session has not confirmed that this command is available.";
  }
}

function commandEntries(capabilities: CapabilityMap): readonly CommandEntry[] {
  return COMMAND_DESCRIPTORS.map((descriptor) => {
    const available = isDescriptorAvailable(descriptor, capabilities);
    if (available) return { descriptor, available, reason: undefined };
    const missing = descriptor.requires.find((key) => {
      const state = capabilityStatus(capabilities, key)?.state;
      return state !== "available" && state !== "fallback";
    });
    return {
      descriptor,
      available,
      reason:
        missing === undefined
          ? "The current session has not confirmed that this command is available."
          : unavailableReason(missing, capabilities),
    };
  });
}

function CommandPaletteDialog({
  close,
  onCommandSelect,
}: {
  readonly close: (reason?: OverlayCloseReason) => void;
  readonly onCommandSelect: (command: CommandDescriptor) => void;
}) {
  const capabilities = useCapabilities();
  const listId = useId();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const entries = commandEntries(capabilities);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleEntries = entries.filter(({ descriptor }) => {
    const searchable = `${descriptor.title} ${descriptor.slash?.name ?? ""}`.toLocaleLowerCase();
    return normalizedQuery.length === 0 || searchable.includes(normalizedQuery);
  });
  const activeEntry = visibleEntries[activeIndex];

  const select = (entry: CommandEntry | undefined) => {
    if (entry === undefined || !entry.available) return;
    setError(null);
    try {
      onCommandSelect(entry.descriptor);
      close("programmatic");
    } catch {
      setError("The command could not be started. Try again.");
    }
  };

  return (
    <section className="flex flex-col gap-(--space-sm)" aria-labelledby={`${listId}-title`}>
      <header className="flex items-start justify-between gap-(--space-sm)">
        <div className="flex min-w-0 flex-col gap-(--space-2xs)">
          <h2 id={`${listId}-title`} className="text-foreground text-base font-semibold">
            Commands
          </h2>
          <p id={`${listId}-help`} className="text-muted-foreground text-xs">
            Search commands. Use the arrow keys to move and Enter to choose.
          </p>
        </div>
      </header>
      <Input
        autoFocus
        type="search"
        role="combobox"
        aria-label="Search commands"
        aria-autocomplete="list"
        aria-expanded="true"
        aria-controls={`${listId}-options`}
        aria-activedescendant={
          activeEntry === undefined ? undefined : `${listId}-option-${activeIndex}`
        }
        aria-describedby={`${listId}-help`}
        placeholder="Search commands"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setActiveIndex(0);
          setError(null);
        }}
        onKeyDown={(event) => {
          if (visibleEntries.length === 0) return;
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setActiveIndex((index) => (index + 1) % visibleEntries.length);
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActiveIndex((index) => (index - 1 + visibleEntries.length) % visibleEntries.length);
          } else if (event.key === "Enter") {
            event.preventDefault();
            select(activeEntry);
          }
        }}
      />
      <div className="flex justify-end">
        <Button type="button" variant="ghost" size="sm" onClick={() => close("programmatic")}>
          Close
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
      {visibleEntries.length === 0 ? (
        <p role="status" className="text-muted-foreground px-(--space-sm) py-(--space-md) text-sm">
          No commands found.
        </p>
      ) : (
        <div
          id={`${listId}-options`}
          role="listbox"
          aria-label="Commands"
          className="max-h-[60vh] overflow-y-auto"
        >
          {visibleEntries.map((entry, index) => {
            const optionId = `${listId}-option-${index}`;
            const reasonId = `${optionId}-reason`;
            return (
              <Button
                id={optionId}
                key={entry.descriptor.id}
                type="button"
                role="option"
                tabIndex={-1}
                aria-selected={activeIndex === index}
                aria-disabled={!entry.available}
                aria-describedby={entry.reason === undefined ? undefined : reasonId}
                variant={activeIndex === index ? "secondary" : "ghost"}
                className={cn(
                  "h-auto w-full flex-col items-stretch justify-start whitespace-normal gap-(--space-2xs) px-(--space-sm) py-(--space-xs) text-start",
                  entry.available
                    ? "cursor-pointer text-foreground"
                    : "cursor-not-allowed text-muted-foreground",
                )}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => select(entry)}
              >
                <span className="flex w-full items-center justify-between gap-(--space-sm)">
                  <span className="truncate">{entry.descriptor.title}</span>
                  {entry.descriptor.slash && (
                    <span className="text-muted-foreground shrink-0 text-xs">
                      /{entry.descriptor.slash.name}
                    </span>
                  )}
                </span>
                {entry.reason !== undefined && (
                  <span id={reasonId} className="text-muted-foreground text-xs">
                    {entry.reason}
                  </span>
                )}
              </Button>
            );
          })}
        </div>
      )}
    </section>
  );
}

/** Opens the descriptor-driven command palette on the registered, non-reserved global chord. */
export function CommandPaletteHost({ onCommandSelect }: CommandPaletteHostProps) {
  const overlay = useOverlayHost();
  const shortcutRegistry = useShortcutRegistry();
  const activeOverlay = useRef<OverlayOpenResult | null>(null);
  useShortcutScope("global");

  useEffect(() => {
    const binding = shortcutRegistry
      .bindings()
      .find(({ id }) => id === U0_COMMAND_PALETTE_SHORTCUT.id);
    if (binding === undefined || shortcutRegistry.isBrowserReserved(binding.chord, binding.scope))
      return;
    return shortcutRegistry.registerAction(U0_COMMAND_PALETTE_SHORTCUT.id, () => {
      if (activeOverlay.current !== null) return;
      const returnFocus =
        document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
      const opened = overlay.open({
        kind: "modal",
        label: "Command palette",
        width: "content",
        ...(returnFocus === undefined ? {} : { restoreFocus: returnFocus }),
        content: ({ close }) => (
          <CommandPaletteDialog close={close} onCommandSelect={onCommandSelect} />
        ),
      });
      activeOverlay.current = opened;
      void opened.closed.then(() => {
        if (activeOverlay.current === opened) activeOverlay.current = null;
      });
    });
  }, [onCommandSelect, overlay, shortcutRegistry]);

  return null;
}
