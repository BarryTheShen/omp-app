import { cn } from "cn";
import { ChevronDown, ChevronRight, Eye, EyeOff, Star } from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { KEYS, keycap } from "../keys/table";
import { lastSeen } from "../lastSeen";
import { menuSections, modelKey } from "../models/menu";
import type { ChatController } from "./controller";
import type { ChatModel } from "./store";

interface MenuList {
  readonly models: readonly ChatModel[];
  readonly recent: readonly string[];
}

type ListState =
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly message: string }
  | ({ readonly kind: "ready" } & MenuList);

const isModel = (value: unknown): value is ChatModel =>
  typeof value === "object" &&
  value !== null &&
  ["provider", "id", "name"].every(
    (key) => typeof (value as Record<string, unknown>)[key] === "string",
  );

/** The menu's list as it was last read, also after a reload. */
const lastMenu = lastSeen<MenuList>("model-menu", (stored) => {
  if (typeof stored !== "object" || stored === null) return undefined;
  const { models, recent } = stored as Record<string, unknown>;
  return Array.isArray(models) &&
    models.every(isModel) &&
    Array.isArray(recent) &&
    recent.every((key) => typeof key === "string")
    ? { models, recent }
    : undefined;
});

/** An item's value: its section and its model, so a model listed twice (under Favorites and its provider) is two items. */
const itemValue = (section: string, model: ChatModel): string => `${section}|${modelKey(model)}`;
const modelOfValue = (value: string): string => value.slice(value.indexOf("|") + 1);
const HIDDEN_TOGGLE = "toggle|hidden";

const sameModel = (a: ChatModel | null, b: ChatModel): boolean =>
  a !== null && a.provider === b.provider && a.id === b.id;

/**
 * The chat's model as a chip; it opens the model menu: a search, the models starred (Favorites), the ones omp used
 * most recently (Recent), then each provider's models newest first; the hidden ones fold away at the end. A star or a
 * hide is the server's, so every device lists the models alike. Its open state is the pane's, so a failed request's
 * "Switch model" opens it too. A model that is a role's other than `default` (Ctrl+P switches between them) is shown
 * with the role: "slow · Claude Opus".
 */
export function ModelPicker({
  controller,
  model,
  role,
  disabled,
  open,
  onOpenChange,
  onError,
}: {
  readonly controller: ChatController;
  readonly model: ChatModel | null;
  readonly role: string | null;
  readonly disabled: boolean;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onError: (failure: unknown) => void;
}): ReactNode {
  const [list, setList] = useState<ListState>(() => {
    const kept = lastMenu.get();
    return kept === undefined ? { kind: "loading" } : { kind: "ready", ...kept };
  });
  const store = controller.modelPreferences;
  const preferences = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const named = model !== null && role !== null && role !== "default" ? role : null;

  // The list is read each time it opens: omp refreshes its models in the background. Until the read answers, the menu
  // shows the list it showed last; a read that fails leaves that list.
  useEffect(() => {
    if (!open) return;
    // Each opening starts afresh: no search, Hidden folded, and cmdk's highlight on the first row.
    setQuery("");
    setShowHidden(false);
    setHighlighted("");
    let active = true;
    controller
      .modelMenu()
      .then((menu) => {
        lastMenu.set(menu);
        if (active) setList({ kind: "ready", ...menu });
      })
      .catch((failure: unknown) => {
        if (active)
          setList((shown) =>
            shown.kind === "ready"
              ? shown
              : {
                  kind: "failed",
                  message: failure instanceof Error ? failure.message : String(failure),
                },
          );
      });
    return () => {
      active = false;
    };
  }, [open, controller]);

  const saved = preferences.kind === "ready" ? preferences.preferences : null;
  const searching = query.trim() !== "";
  const { sections, hidden } =
    list.kind === "ready"
      ? menuSections({
          models: list.models,
          recent: list.recent,
          favorites: saved?.favorites ?? [],
          hidden: saved?.hidden ?? [],
          query,
        })
      : { sections: [], hidden: [] };
  const hiddenShown = showHidden || searching;

  const change = (key: string, update: { favorite?: boolean; hidden?: boolean }): void => {
    store.change(key, update).catch(onError);
  };
  const toggleStar = (key: string): void => {
    if (saved !== null) change(key, { favorite: !saved.favorites.includes(key) });
  };
  const toggleHidden = (key: string): void => {
    if (saved !== null) change(key, { hidden: !saved.hidden.includes(key) });
  };
  const choose = (item: ChatModel): void => {
    onOpenChange(false);
    void controller.setModel(item).catch(onError);
  };
  // Alt+S and Alt+H act on the highlighted model while the search keeps the caret.
  const onKeyDown = (event: KeyboardEvent): void => {
    if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (highlighted === "" || highlighted === HIDDEN_TOGGLE || saved === null) return;
    if (event.code === "KeyS") {
      event.preventDefault();
      toggleStar(modelOfValue(highlighted));
    } else if (event.code === "KeyH") {
      event.preventDefault();
      toggleHidden(modelOfValue(highlighted));
    }
  };

  const row = (section: string, item: ChatModel, inHidden: boolean): ReactNode => {
    const key = modelKey(item);
    const starred = saved?.favorites.includes(key) ?? false;
    const selected = itemValue(section, item) === highlighted;
    return (
      <div key={itemValue(section, item)} className="group/row relative">
        <CommandItem
          value={itemValue(section, item)}
          data-checked={sameModel(model, item)}
          className={cn(saved !== null && "pr-16")}
          onSelect={() => choose(item)}
        >
          {/* A hidden model's name is dimmed, but not on the highlighted row, where dim text is too faint to read. */}
          <span className={cn("min-w-0 flex-1 truncate", inHidden && !selected && "text-t3")}>
            {item.name}
          </span>
          <span className="max-w-32 shrink-0 truncate font-mono text-[11px] text-t3 group-data-selected/command-item:text-t2">
            {item.id}
          </span>
        </CommandItem>
        {saved !== null && (
          // Beside the item, not in it: an option holds no buttons, and a click here must not choose the model.
          <div className="absolute inset-y-0 right-1 flex items-center gap-0.5">
            <RowButton
              label={starred ? `Unstar ${item.name}` : `Star ${item.name}`}
              pressed={starred}
              shown={starred || selected}
              // The tour points at the star of the highlighted row, the one shown.
              tour={selected ? "model-star" : undefined}
              onClick={() => toggleStar(key)}
            >
              <Star className={cn("size-3.5", starred && "fill-current text-warn")} />
            </RowButton>
            <RowButton
              label={inHidden ? `Show ${item.name}` : `Hide ${item.name}`}
              shown={selected}
              onClick={() => toggleHidden(key)}
            >
              {inHidden ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
            </RowButton>
          </div>
        )}
      </div>
    );
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        render={
          <Button
            data-tour="model"
            type="button"
            variant="ghost"
            size="sm"
            // The chip gives way first on a narrow box, so Send stays in it.
            className="max-w-56 min-w-0 shrink gap-1 text-t2 hover:text-t1"
            aria-label={`Model: ${model?.name ?? "none"}${named === null ? "" : ` (${named})`}`}
            disabled={disabled}
          />
        }
      >
        <span className="truncate">
          {named === null ? "" : `${named} · `}
          {model?.name ?? "Choose a model"}
        </span>
        <ChevronDown />
      </PopoverTrigger>
      <PopoverContent
        data-tour="model-menu"
        align="start"
        side="top"
        className="w-96 max-w-[calc(100vw-1rem)] p-0"
      >
        <Command
          shouldFilter={false}
          value={highlighted}
          onValueChange={setHighlighted}
          onKeyDown={onKeyDown}
        >
          <CommandInput placeholder="Find a model" value={query} onValueChange={setQuery} />
          <CommandList>
            <CommandEmpty>
              {list.kind === "loading"
                ? "Loading models…"
                : list.kind === "failed"
                  ? `Could not list the models: ${list.message}`
                  : "No model matches."}
            </CommandEmpty>
            {sections.map((section) => (
              <CommandGroup key={section.key} heading={section.heading}>
                {section.models.map((item) => row(section.key, item, false))}
              </CommandGroup>
            ))}
            {hidden.length > 0 && (
              <CommandGroup heading="Hidden">
                {!searching && (
                  <CommandItem
                    value={HIDDEN_TOGGLE}
                    aria-expanded={hiddenShown}
                    className="text-t3"
                    onSelect={() => setShowHidden((shown) => !shown)}
                  >
                    {hiddenShown ? <ChevronDown /> : <ChevronRight />}
                    <span className="flex-1">
                      {hiddenShown
                        ? "Fold them away"
                        : `Show ${hidden.length} hidden ${hidden.length === 1 ? "model" : "models"}`}
                    </span>
                  </CommandItem>
                )}
                {hiddenShown && hidden.map((item) => row("hidden", item, true))}
              </CommandGroup>
            )}
          </CommandList>
          <p className="border-t border-l2 px-3 py-1.5 text-xs text-t3">
            {preferences.kind === "unavailable" ? (
              "This app server cannot keep stars or hidden models yet; it needs an update."
            ) : (
              <>
                <span className="[@media(hover:none)]:hidden">
                  {`${keycap(KEYS.starModel)} star · ${keycap(KEYS.hideModel)} hide · kept on every device`}
                </span>
                <span className="hidden [@media(hover:none)]:inline">
                  Stars and hidden models are kept on every device
                </span>
              </>
            )}
          </p>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/**
 * A star or hide button beside a model: on the highlighted row, the pointed one, and every row of a touch screen; a
 * star that is on, always. The menu tells which row is highlighted (`shown`, from cmdk's value it holds).
 */
function RowButton({
  label,
  pressed,
  shown,
  tour,
  onClick,
  children,
}: {
  readonly label: string;
  readonly pressed?: boolean;
  /** Shown whether pointed at or not: the highlighted row's, or a star that is on. */
  readonly shown: boolean;
  readonly tour?: string;
  readonly onClick: () => void;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      data-tour={tour}
      // Alt+S and Alt+H do this from the keyboard; a Tab stop on every row would make the list a long way round.
      tabIndex={-1}
      className={cn(
        "grid size-6 place-items-center rounded-sm text-t3 hover:bg-l2 hover:text-t1",
        !shown && "opacity-0 group-hover/row:opacity-100 [@media(hover:none)]:opacity-100",
      )}
      // The search keeps the caret, so typing and the arrows go on working after a click here.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
