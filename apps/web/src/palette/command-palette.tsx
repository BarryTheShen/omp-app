import type {
  CapabilityKey,
  CapabilityMap,
  CommandDescriptor,
  DescriptorId,
} from "@omp-app/contracts";
import { cn } from "cn";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { type OverlayCloseReason, type OverlayOpenResult, useOverlayHost } from "@/overlay";
import { DESCRIPTORS } from "@/registry";
import { capabilityStatus, isDescriptorAvailable, useCapabilities } from "@/registry-core";
import { chordLabel, isApplePlatform, useShortcutRegistry, useShortcutScope } from "@/shortcuts";
import type { ShortcutRegistry } from "@/shortcuts/registry";
import { U0_COMMAND_PALETTE_SHORTCUT } from "./descriptor";

/**
 * What a palette command does. The app registers one per command it has actually mounted: the
 * palette lists nothing it cannot run, because a bare slash command sent to omp over RPC often does
 * nothing visible (`/resume`, `/new`, `/branch`, `/tree` return success with no output).
 */
export type CommandPaletteHandler = (signal?: AbortSignal) => Promise<void> | void;

export interface CommandPaletteHostProps {
  /** Commands to list, keyed by their descriptor id. */
  readonly handlers: ReadonlyMap<DescriptorId, CommandPaletteHandler>;
  readonly capabilities?: CapabilityMap;
  readonly unavailableReasons?: ReadonlyMap<DescriptorId, string>;
}

interface CommandEntry {
  readonly descriptor: CommandDescriptor;
  readonly available: boolean;
  readonly reason: string | undefined;
  readonly shortcut: string | undefined;
}

const COMMAND_DESCRIPTORS: readonly CommandDescriptor[] = DESCRIPTORS.filter(
  (descriptor): descriptor is CommandDescriptor => descriptor.kind === "command",
);
const EMPTY_UNAVAILABLE_REASONS: ReadonlyMap<DescriptorId, string> = new Map();

function unavailableReason(key: CapabilityKey, capabilities: CapabilityMap): string {
  const status = capabilityStatus(capabilities, key);
  switch (status?.via) {
    case "upstream":
      return "This command needs a newer version of omp.";
    case "omp":
      return "The connected omp process does not support this command.";
    case "host":
      return "The app host does not provide this command.";
    case "client":
      return "This command is not available in this browser.";
    default:
      return "The current session has not confirmed that this command is available.";
  }
}

function commandEntries(
  capabilities: CapabilityMap,
  handlers: ReadonlyMap<DescriptorId, CommandPaletteHandler>,
  unavailableReasons: ReadonlyMap<DescriptorId, string>,
  shortcuts: ReadonlyMap<DescriptorId, string>,
): readonly CommandEntry[] {
  return COMMAND_DESCRIPTORS.filter((descriptor) => handlers.has(descriptor.id)).map(
    (descriptor) => {
      const available = isDescriptorAvailable(descriptor, capabilities);
      if (available) {
        return { descriptor, available, reason: undefined, shortcut: shortcuts.get(descriptor.id) };
      }
      const missing = descriptor.requires.find((key) => {
        const state = capabilityStatus(capabilities, key)?.state;
        return state !== "available" && state !== "fallback";
      });
      return {
        descriptor,
        available,
        reason:
          unavailableReasons.get(descriptor.id) ??
          (missing === undefined
            ? "The current session has not confirmed that this command is available."
            : unavailableReason(missing, capabilities)),
        shortcut: shortcuts.get(descriptor.id),
      };
    },
  );
}

/**
 * The commands the palette can run: the handlers it was given, plus any command a mounted feature
 * registered on the shortcut registry. A command shows the chord of the shortcut that runs it.
 */
function paletteCommands(
  handlers: ReadonlyMap<DescriptorId, CommandPaletteHandler>,
  registry: ShortcutRegistry,
): {
  readonly handlers: ReadonlyMap<DescriptorId, CommandPaletteHandler>;
  readonly shortcuts: ReadonlyMap<DescriptorId, string>;
} {
  const runnable = new Map(handlers);
  const shortcuts = new Map<DescriptorId, string>();
  for (const descriptor of COMMAND_DESCRIPTORS) {
    const command = registry.commandFor(descriptor.id);
    if (command === undefined) continue;
    if (!runnable.has(descriptor.id)) runnable.set(descriptor.id, () => command.run());
    const chord = registry.bindings().find((binding) => binding.id === command.shortcut)?.chord;
    if (chord !== undefined) shortcuts.set(descriptor.id, chord);
  }
  return { handlers: runnable, shortcuts };
}

function CommandPaletteDialog({
  capabilities,
  close,
  handlers,
  shortcuts,
  unavailableReasons,
}: {
  readonly capabilities: CapabilityMap;
  readonly close: (reason?: OverlayCloseReason) => void;
  readonly handlers: ReadonlyMap<DescriptorId, CommandPaletteHandler>;
  readonly shortcuts: ReadonlyMap<DescriptorId, string>;
  readonly unavailableReasons: ReadonlyMap<DescriptorId, string>;
}) {
  const listId = useId();
  const apple = isApplePlatform();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const activeAction = useRef<AbortController | null>(null);
  const entries = commandEntries(capabilities, handlers, unavailableReasons, shortcuts);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleEntries = entries.filter(({ descriptor }) => {
    const searchable = `${descriptor.title} ${descriptor.slash?.name ?? ""}`.toLocaleLowerCase();
    return normalizedQuery.length === 0 || searchable.includes(normalizedQuery);
  });
  const activeEntry = visibleEntries[activeIndex];

  useEffect(
    () => () => {
      activeAction.current?.abort();
      activeAction.current = null;
    },
    [],
  );

  const select = async (entry: CommandEntry | undefined) => {
    if (entry === undefined || !entry.available || isRunning) return;
    setError(null);
    const controller = new AbortController();
    activeAction.current = controller;
    setIsRunning(true);
    try {
      const handler = handlers.get(entry.descriptor.id);
      if (handler === undefined) return;
      await handler(controller.signal);
      if (activeAction.current === controller) {
        activeAction.current = null;
        close("programmatic");
      }
    } catch {
      if (!controller.signal.aborted) setError("The command could not be started. Try again.");
    } finally {
      if (activeAction.current === controller) {
        activeAction.current = null;
        setIsRunning(false);
      }
    }
  };
  return (
    <section className="flex flex-col gap-(--space-sm)" aria-labelledby={`${listId}-title`}>
      <header className="flex items-start justify-between gap-(--space-sm)">
        <div className="flex min-w-0 flex-col gap-(--space-2xs)">
          <h2 id={`${listId}-title`} className="text-sm font-medium text-foreground">
            Commands
          </h2>
          <p id={`${listId}-help`} className="text-muted-foreground text-sm">
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
        className="rounded-control text-sm"
        value={query}
        disabled={isRunning}
        onChange={(event) => {
          setQuery(event.target.value);
          setActiveIndex(0);
          setError(null);
        }}
        onKeyDown={(event) => {
          // An Enter or arrow an IME uses to commit or pick a word belongs to the IME, not to the palette (issue 1334).
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (visibleEntries.length === 0) return;
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setActiveIndex((index) => (index + 1) % visibleEntries.length);
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActiveIndex((index) => (index - 1 + visibleEntries.length) % visibleEntries.length);
          } else if (event.key === "Enter") {
            event.preventDefault();
            void select(activeEntry);
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
                disabled={isRunning || !entry.available}
                aria-selected={activeIndex === index}
                aria-disabled={!entry.available || isRunning}
                aria-describedby={entry.reason === undefined ? undefined : reasonId}
                variant="ghost"
                className={cn(
                  "h-auto w-full flex-col items-stretch justify-start gap-(--space-2xs) rounded-sm px-2 py-1.5 text-sm whitespace-normal text-start hover:bg-muted focus:bg-muted",
                  // The highlighted row is the panel tinted 8% toward the text colour, opaque so its colour does not depend on what is behind it.
                  // The secondary surface gives 1.06:1 against the panel in light (tokens.css --secondary), so it cannot mark the row there.
                  // The dark theme keeps the accent surface.
                  activeIndex === index &&
                    "bg-[color-mix(in_oklch,var(--popover),var(--foreground)_8%)] hover:bg-[color-mix(in_oklch,var(--popover),var(--foreground)_8%)] dark:bg-accent dark:hover:bg-accent",
                  entry.available && !isRunning
                    ? "cursor-pointer text-foreground"
                    : "cursor-not-allowed text-muted-foreground",
                )}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => void select(entry)}
              >
                <span className="flex w-full items-center justify-between gap-(--space-sm)">
                  <span className="truncate">{entry.descriptor.title}</span>
                  <span className="flex shrink-0 items-center gap-(--space-xs)">
                    {entry.shortcut === undefined ? null : (
                      <kbd className="border-border text-muted-foreground rounded-md border px-1.5 text-xs">
                        {chordLabel(entry.shortcut, { mac: apple })}
                      </kbd>
                    )}
                    {entry.descriptor.slash && (
                      <span className="text-muted-foreground text-xs">
                        /{entry.descriptor.slash.name}
                      </span>
                    )}
                  </span>
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
export function CommandPaletteHost({
  handlers,
  capabilities,
  unavailableReasons = EMPTY_UNAVAILABLE_REASONS,
}: CommandPaletteHostProps) {
  const overlay = useOverlayHost();
  const shortcutRegistry = useShortcutRegistry();
  const contextCapabilities = useCapabilities();
  const paletteCapabilities = capabilities ?? contextCapabilities;
  const activeOverlay = useRef<OverlayOpenResult | null>(null);
  useShortcutScope("global");

  // Registered in the commit that paints the shell, not after it: a Ctrl+K pressed as the shell appears needs this action
  // already in place (issue 2266).
  useLayoutEffect(() => {
    const binding = shortcutRegistry
      .bindings()
      .find(({ id }) => id === U0_COMMAND_PALETTE_SHORTCUT.id);
    if (binding === undefined || shortcutRegistry.isBrowserReserved(binding.chord, binding.scope))
      return;
    return shortcutRegistry.registerAction(U0_COMMAND_PALETTE_SHORTCUT.id, () => {
      if (activeOverlay.current !== null) return;
      const commands = paletteCommands(handlers, shortcutRegistry);
      const returnFocus =
        document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
      const opened = overlay.open({
        kind: "modal",
        label: "Command palette",
        width: "content",
        ...(returnFocus === undefined ? {} : { restoreFocus: returnFocus }),
        content: ({ close }) => (
          <CommandPaletteDialog
            capabilities={paletteCapabilities}
            close={close}
            handlers={commands.handlers}
            shortcuts={commands.shortcuts}
            unavailableReasons={unavailableReasons}
          />
        ),
      });
      activeOverlay.current = opened;
      void opened.closed.then(() => {
        if (activeOverlay.current === opened) activeOverlay.current = null;
      });
    });
  }, [handlers, overlay, paletteCapabilities, shortcutRegistry, unavailableReasons]);

  return null;
}
