import type { RoleModel } from "@omp-app/contracts/chat-host";
import { cn } from "cn";
import { ChevronDown, ChevronRight, Eye, EyeOff, Star } from "lucide-react";
import {
  type KeyboardEvent,
  memo,
  type ReactNode,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
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

/**
 * Rows built when the menu opens or its search changes, and how many more each time the list scrolls near the last
 * one built: a catalog can list hundreds of models, and building them all at once held the page for seconds.
 */
const FIRST_ROWS = 30;
const MORE_ROWS = 40;
const NO_SECTIONS: ReturnType<typeof menuSections> = { sections: [], hidden: [] };

/** Whether a fresh read lists the same models, and the same recent ones, as the menu shows. */
const sameList = (shown: ListState, menu: MenuList): boolean =>
  shown.kind === "ready" &&
  JSON.stringify(shown.models) === JSON.stringify(menu.models) &&
  JSON.stringify(shown.recent) === JSON.stringify(menu.recent);

/** What a row does when used; read through a ref, so a row stays the same while the menu redraws. */
interface MenuActions {
  readonly choose: (item: ChatModel) => void;
  readonly toggleStar: (key: string) => void;
  readonly toggleHidden: (key: string) => void;
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
/** A row of the menu's Roles: its value starts so, apart from the models' `section|provider/id`. */
const ROLE_ROW = "role|";
const NO_TAGS: readonly string[] = [];
const NO_ROLE_TAGS: ReadonlyMap<string, readonly string[]> = new Map();
const NO_ROLES: readonly RoleModel[] = [];

/** For each model (`provider/id`), the roles that use it, in Ctrl+P's order: the tags on the menu's rows. */
function roleTagsOf(roles: readonly RoleModel[]): ReadonlyMap<string, readonly string[]> {
  const tags = new Map<string, string[]>();
  for (const each of roles) {
    const key = modelKey({ provider: each.provider, id: each.modelId });
    tags.set(key, [...(tags.get(key) ?? []), each.role]);
  }
  return tags;
}

const sameModel = (a: ChatModel | null, b: ChatModel): boolean =>
  a !== null && a.provider === b.provider && a.id === b.id;

/**
 * The chat's model as a chip; it opens the model menu: a search, omp's roles that have a model of their own (Roles: a
 * pick switches this chat to the role's model and level), the models starred (Favorites), the ones omp used most
 * recently (Recent), then each provider's models newest first, a model's roles tagged beside it; the hidden ones fold
 * away at the end, and "Roles and models…" at its foot opens omp's model panel at the chat's role (#2838). A star or a
 * hide is the server's, so every device lists the models alike. Its open state is the pane's, so a failed request's
 * "Switch model" opens it too. A model that is a role's other than `default` (Ctrl+P switches between them) is shown
 * with the role: "slow · Claude Opus".
 */
export function ModelPicker({
  controller,
  model,
  role,
  roles,
  disabled,
  open,
  onOpenChange,
  onError,
}: {
  readonly controller: ChatController;
  readonly model: ChatModel | null;
  readonly role: string | null;
  /** The roles Ctrl+P switches between, each with its model (the chat's snapshot). */
  readonly roles: readonly RoleModel[];
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
        // The same list again leaves the rows as they are.
        if (active)
          setList((shown) => (sameList(shown, menu) ? shown : { kind: "ready", ...menu }));
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
    // omp's roles, read again too (another chat or omp's terminal may have changed them): the menu shows the ones the
    // chat read last at once, so no row moves under the highlight when the answer comes. A failed read keeps those.
    controller.refreshRoles().catch(() => undefined);
    return () => {
      active = false;
    };
  }, [open, controller]);

  const saved = preferences.kind === "ready" ? preferences.preferences : null;
  const searching = query.trim() !== "";
  const { sections, hidden } = useMemo(
    () =>
      list.kind === "ready"
        ? menuSections({
            models: list.models,
            recent: list.recent,
            favorites: saved?.favorites ?? [],
            hidden: saved?.hidden ?? [],
            query,
          })
        : NO_SECTIONS,
    [list, saved, query],
  );
  const hiddenShown = showHidden || searching;
  // The Roles show with two roles or more (with one there is nothing to switch to, as omp's Ctrl+P says), and without a
  // search, which looks for models.
  const switchable = roles.length > 1;
  const listed = switchable && !searching ? roles : NO_ROLES;
  const tags = useMemo(() => (switchable ? roleTagsOf(roles) : NO_ROLE_TAGS), [switchable, roles]);

  // The rows built so far: the first ones when the menu opens or its search changes, then more each time the list
  // scrolls near the last one built (`more`, watched by an IntersectionObserver). Showing the hidden models keeps what
  // is built: their fold is at the end, so the rows above it are all built already.
  const view = `${open}|${query}`;
  const [built, setBuilt] = useState({ view, rows: FIRST_ROWS });
  const rows = built.view === view ? built.rows : FIRST_ROWS;
  // Closing forgets the rows built, so the next opening builds only the first ones again.
  useEffect(() => {
    if (!open) setBuilt({ view: "", rows: FIRST_ROWS });
  }, [open]);
  const sectionRows = sections.reduce((sum, section) => sum + section.models.length, 0);
  const total = sectionRows + (hiddenShown ? hidden.length : 0);
  // State, not refs: the list and the marker mount with the menu's popup, and the observer starts once both are there.
  const [listElement, setListElement] = useState<HTMLDivElement | null>(null);
  const [more, setMore] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open || listElement === null || more === null || rows >= total) return;
    if (typeof IntersectionObserver === "undefined") {
      setBuilt({ view, rows: total });
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting))
          setBuilt({ view, rows: rows + MORE_ROWS });
      },
      // Well ahead of the last row, so scrolling or the arrow keys rarely reach the end of what is built.
      { root: listElement, rootMargin: "0px 0px 320px 0px" },
    );
    observer.observe(more);
    return () => observer.disconnect();
  }, [open, view, rows, total, listElement, more]);

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
  const useRole = (picked: RoleModel): void => {
    onOpenChange(false);
    void controller.useRole(picked).catch(onError);
  };
  const openPanel = (): void => {
    onOpenChange(false);
    controller.modelHubToggle.show(role ?? "default");
  };
  // Alt+S and Alt+H act on the highlighted model while the search keeps the caret; a role's row has neither.
  const onKeyDown = (event: KeyboardEvent): void => {
    if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (
      highlighted === "" ||
      highlighted === HIDDEN_TOGGLE ||
      highlighted.startsWith(ROLE_ROW) ||
      saved === null
    )
      return;
    if (event.code === "KeyS") {
      event.preventDefault();
      toggleStar(modelOfValue(highlighted));
    } else if (event.code === "KeyH") {
      event.preventDefault();
      toggleHidden(modelOfValue(highlighted));
    }
  };

  const actions = useRef<MenuActions>({ choose, toggleStar, toggleHidden });
  actions.current = { choose, toggleStar, toggleHidden };
  const row = (section: string, item: ChatModel, inHidden: boolean): ReactNode => {
    const value = itemValue(section, item);
    const key = modelKey(item);
    return (
      <MenuRow
        key={value}
        value={value}
        item={item}
        itemKey={key}
        inHidden={inHidden}
        selected={value === highlighted}
        tourStar={value === starRow}
        starred={saved?.favorites.includes(key) ?? false}
        checked={sameModel(model, item)}
        marks={saved !== null}
        tags={tags.get(key) ?? NO_TAGS}
        actions={actions}
      />
    );
  };
  let left = rows;
  const builtSections = sections.flatMap((section) => {
    if (left <= 0) return [];
    const models = section.models.slice(0, left);
    left -= models.length;
    return [{ key: section.key, heading: section.heading, models }];
  });
  const builtHidden = hiddenShown ? hidden.slice(0, Math.max(0, rows - sectionRows)) : [];
  // The tour points at the star of the highlighted model's row, or the first model's while a role's row is highlighted.
  const firstSection = builtSections[0];
  const firstModel = firstSection?.models[0];
  const starRow =
    highlighted !== "" && !highlighted.startsWith(ROLE_ROW) && highlighted !== HIDDEN_TOGGLE
      ? highlighted
      : firstSection !== undefined && firstModel !== undefined
        ? itemValue(firstSection.key, firstModel)
        : "";
  // Arrow keys held down can outrun the scroll that builds more rows: within 10 rows of the last one built, ↓ and
  // PageDown build more at once, before cmdk moves the highlight.
  const builtValues = builtSections.flatMap((section) =>
    section.models.map((item) => itemValue(section.key, item)),
  );
  const buildAhead = (event: KeyboardEvent): void => {
    if ((event.key !== "ArrowDown" && event.key !== "PageDown") || rows >= total) return;
    if (builtValues.indexOf(highlighted) >= builtValues.length - 10)
      setBuilt({ view, rows: rows + MORE_ROWS });
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
            // The chip gives way first on a narrow box, so Send stays in it; on a tablet not below a finger's width (#2814).
            className="max-w-56 min-w-0 shrink gap-1 text-t2 hover:text-t1 tablet:h-11 tablet:min-w-11"
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
          onKeyDown={(event) => {
            buildAhead(event);
            onKeyDown(event);
          }}
        >
          <CommandInput placeholder="Find a model" value={query} onValueChange={setQuery} />
          <CommandList ref={setListElement}>
            <CommandEmpty>
              {list.kind === "loading"
                ? "Loading models…"
                : list.kind === "failed"
                  ? `Could not list the models: ${list.message}`
                  : "No model matches."}
            </CommandEmpty>
            {listed.length > 0 && (
              <CommandGroup heading="Roles" data-tour="model-roles">
                {listed.map((each) => (
                  <CommandItem
                    key={each.role}
                    value={`${ROLE_ROW}${each.role}`}
                    data-checked={each.role === role}
                    onSelect={() => useRole(each)}
                  >
                    <span className="w-16 shrink-0 truncate text-t2">{each.role}</span>
                    <span className="min-w-0 flex-1 truncate">{each.name}</span>
                    {each.thinkingLevel !== null && (
                      <span className="shrink-0 text-[11px] text-t3">{each.thinkingLevel}</span>
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {builtSections.map((section) => (
              <CommandGroup key={section.key} heading={section.heading}>
                {section.models.map((item) => row(section.key, item, false))}
              </CommandGroup>
            ))}
            {/* The Hidden fold closes the list: it shows once every row above it is built. */}
            {hidden.length > 0 && rows >= sectionRows && (
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
                {builtHidden.map((item) => row("hidden", item, true))}
              </CommandGroup>
            )}
            {rows < total && <div ref={setMore} aria-hidden="true" className="h-px" />}
          </CommandList>
          <div className="flex items-center gap-2 border-t border-l2 px-3 py-1 text-xs text-t3">
            <p className="min-w-0 flex-1">
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
            <button
              type="button"
              data-tour="model-roles-link"
              className="shrink-0 rounded-sm px-1.5 py-1 text-t2 outline-none hover:bg-l2 hover:text-t1 focus-visible:ring-2 focus-visible:ring-ring max-sm:min-h-11 tablet:min-h-11"
              onClick={openPanel}
            >
              Roles and models…
            </button>
          </div>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/**
 * One model of the menu, with its star and hide buttons beside it. Memoized: moving the highlight redraws only the row
 * it leaves and the row it reaches, not every row of a long catalog.
 */
const MenuRow = memo(function MenuRow({
  value,
  item,
  itemKey,
  inHidden,
  selected,
  tourStar,
  starred,
  checked,
  marks,
  tags,
  actions,
}: {
  /** cmdk's value: the section and the model. */
  readonly value: string;
  readonly item: ChatModel;
  /** The model's key for stars and hides. */
  readonly itemKey: string;
  readonly inHidden: boolean;
  readonly selected: boolean;
  /** The tour points at this row's star: the highlighted model's, or the first model's. */
  readonly tourStar: boolean;
  readonly starred: boolean;
  /** The chat's model. */
  readonly checked: boolean;
  /** Stars and hides can be kept: the server has them. */
  readonly marks: boolean;
  /** omp's roles that use the model ("slow", "task", …). */
  readonly tags: readonly string[];
  readonly actions: RefObject<MenuActions>;
}): ReactNode {
  return (
    <div className="group/row relative">
      <CommandItem
        value={value}
        data-checked={checked}
        className={cn(marks && "pr-16 max-sm:pr-24 tablet:pr-24")}
        onSelect={() => actions.current.choose(item)}
      >
        {/* A hidden model's name is dimmed, but not on the highlighted row, where dim text is too faint to read. */}
        <span className={cn("min-w-0 flex-1 truncate", inHidden && !selected && "text-t3")}>
          {item.name}
        </span>
        {tags.map((tag) => (
          <span key={tag} className="shrink-0 rounded-sm bg-l2 px-1 text-[11px] text-t2">
            {tag}
          </span>
        ))}
        <span className="max-w-32 shrink-0 truncate font-mono text-[11px] text-t3 group-data-selected/command-item:text-t2">
          {item.id}
        </span>
      </CommandItem>
      {marks && (
        // Beside the item, not in it: an option holds no buttons, and a click here must not choose the model.
        <div className="absolute inset-y-0 right-1 flex items-center gap-0.5">
          <RowButton
            label={starred ? `Unstar ${item.name}` : `Star ${item.name}`}
            pressed={starred}
            shown={starred || selected || tourStar}
            tour={tourStar ? "model-star" : undefined}
            onClick={() => actions.current.toggleStar(itemKey)}
          >
            <Star className={cn("size-3.5", starred && "fill-current text-warn")} />
          </RowButton>
          <RowButton
            label={inHidden ? `Show ${item.name}` : `Hide ${item.name}`}
            shown={selected}
            onClick={() => actions.current.toggleHidden(itemKey)}
          >
            {inHidden ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
          </RowButton>
        </div>
      )}
    </div>
  );
});

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
        "grid size-6 place-items-center rounded-sm text-t3 hover:bg-l2 hover:text-t1 max-sm:size-11 tablet:size-11",
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
