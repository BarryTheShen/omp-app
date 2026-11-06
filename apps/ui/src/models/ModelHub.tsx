import type {
  AssignModelRoleParams,
  ModelHub as Hub,
  HubModel,
  HubRole,
} from "@omp-app/contracts/chat-host";
import { ArrowDown, ArrowUp, Check, X } from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ChatController } from "../chat/controller";
import { lastSeen } from "../lastSeen";
import { assignLevel, modelsFor, roleGroups, roleValueText, windowText } from "./hub";

/** The hub as the dialog showed it last for a folder (its project settings are the folder's), for this page. */
const keptHub = (folder: string) => lastSeen<Hub>(`model-hub:${folder}`);

const failureText = (failure: unknown): string =>
  failure instanceof Error ? failure.message : String(failure);

const keyOf = (model: { readonly provider: string; readonly modelId: string }): string =>
  `${model.provider}/${model.modelId}`;

type Level = NonNullable<AssignModelRoleParams["thinkingLevel"]>;

/** The thinking levels a fallback selector can end with (`provider/id:low`). */
const SELECTOR_LEVELS = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "inherit",
  "auto",
]);

/** A fallback selector as words: its model's name, with its level where it names one; the selector itself otherwise. */
function selectorName(selector: string, hub: Hub): string {
  const exact = hub.models.find((model) => keyOf(model) === selector);
  if (exact !== undefined) return exact.name;
  const cut = selector.lastIndexOf(":");
  const level = cut > 0 ? selector.slice(cut + 1) : "";
  if (!SELECTOR_LEVELS.has(level)) return selector;
  const model = hub.models.find((each) => keyOf(each) === selector.slice(0, cut));
  return model === undefined ? selector : `${model.name} · ${level}`;
}

/**
 * A role's fallback chain (#2838), as omp's hub keeps it: the models omp's retry falls back to, in order, when the role's
 * model fails. Earlier, later and remove change the order; "Add a fallback…" adds one of the models the role takes.
 */
function Fallbacks({
  role,
  hub,
  disabled,
  onChange,
}: {
  readonly role: HubRole;
  readonly hub: Hub;
  readonly disabled: boolean;
  readonly onChange: (chain: readonly string[]) => void;
}): ReactNode {
  const chain = role.fallbacks;
  const label = role.tag ?? role.name;
  const candidates = modelsFor(hub, role.role, "").filter(
    (model) =>
      !chain.includes(keyOf(model)) && (role.model === null || keyOf(model) !== keyOf(role.model)),
  );
  const move = (index: number, by: -1 | 1): void => {
    const next = [...chain];
    const [taken] = next.splice(index, 1);
    if (taken === undefined) return;
    next.splice(index + by, 0, taken);
    onChange(next);
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: a named group of the chain's rows and its add list, not a form's fieldset
    <div
      role="group"
      aria-label="Fallbacks"
      data-tour="role-fallbacks"
      className="flex flex-col gap-1 rounded-md border border-l2 px-2.5 py-2"
    >
      <p className="text-xs text-t3">
        {chain.length === 0
          ? `No fallbacks: when ${label}'s model fails, omp retries it alone.`
          : `When ${label}'s model fails, omp tries these, in order:`}
      </p>
      {chain.length > 0 && (
        <ol className="flex flex-col">
          {chain.map((selector, index) => {
            const name = selectorName(selector, hub);
            // The same selector twice (a chain edited by hand) gets a key of its own each time.
            const earlier = chain.slice(0, index).filter((each) => each === selector).length;
            return (
              <li
                key={`${selector}#${earlier}`}
                className="flex min-h-8 items-center gap-1 text-[0.8125rem]"
              >
                <span className="w-4 shrink-0 text-right text-xs text-t3 tabular-nums">
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1 truncate text-t1" title={selector}>
                  {name}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`${name} earlier`}
                  disabled={disabled || index === 0}
                  onClick={() => move(index, -1)}
                >
                  <ArrowUp />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`${name} later`}
                  disabled={disabled || index === chain.length - 1}
                  onClick={() => move(index, 1)}
                >
                  <ArrowDown />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove ${name}`}
                  disabled={disabled}
                  onClick={() => onChange(chain.filter((_, at) => at !== index))}
                >
                  <X />
                </Button>
              </li>
            );
          })}
        </ol>
      )}
      {candidates.length > 0 && (
        <select
          aria-label="Add a fallback"
          value=""
          disabled={disabled}
          onChange={(event) => {
            if (event.target.value !== "") onChange([...chain, event.target.value]);
          }}
          className="h-8 rounded-md bg-transparent px-2 text-[0.8125rem] text-t2 outline-none ring-1 ring-l2 ring-inset focus-visible:ring-ring"
        >
          <option value="">Add a fallback…</option>
          {candidates.map((model) => (
            <option key={keyOf(model)} value={keyOf(model)}>
              {model.name} ({keyOf(model)})
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

/** Moves the focus among a list's options with the arrows, Home and End; true when the key was one of them. */
function moveFocus(event: KeyboardEvent<HTMLElement>): boolean {
  const options = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="option"]')];
  if (options.length === 0) return false;
  const at = options.indexOf(document.activeElement as HTMLElement);
  const to =
    event.key === "ArrowDown"
      ? at + 1
      : event.key === "ArrowUp"
        ? at - 1
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? options.length - 1
            : null;
  if (to === null) return false;
  event.preventDefault();
  options[Math.max(0, Math.min(options.length - 1, to))]?.focus();
  return true;
}

/** omp's names for presets and roles: a letter, then letters, digits, `-` or `_`. */
const OMP_NAME = /^[a-zA-Z][\w-]*$/;

/**
 * omp's model presets (#2838): the one the role assignments match, a switch to another (its roles are written and the
 * chat moves to its default model), Save as… for the assignments as they are, and Delete for the one picked.
 */
function PresetRow({
  presets,
  disabled,
  onAction,
}: {
  readonly presets: Hub["presets"];
  readonly disabled: boolean;
  readonly onAction: (action: "save" | "apply" | "delete", name: string) => void;
}): ReactNode {
  const [naming, setNaming] = useState<string | null>(null);
  const valid = naming !== null && OMP_NAME.test(naming);
  return (
    // biome-ignore lint/a11y/useSemanticElements: a named group of the preset controls, not a form's fieldset
    <div
      role="group"
      aria-label="Presets"
      data-tour="model-presets"
      className="flex flex-wrap items-center gap-2 border-b border-l2 px-4 py-2"
    >
      <span className="text-xs text-t3">Preset</span>
      <select
        aria-label="Preset"
        value={presets.active ?? ""}
        disabled={disabled || presets.names.length === 0}
        onChange={(event) => {
          if (event.target.value !== "") onAction("apply", event.target.value);
        }}
        className="h-8 min-w-0 max-w-48 rounded-md bg-transparent px-2 text-[0.8125rem] text-t1 outline-none ring-1 ring-l2 ring-inset focus-visible:ring-ring"
      >
        <option value="">{presets.names.length === 0 ? "No presets yet" : "None matches"}</option>
        {presets.names.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
      {naming === null ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => setNaming("")}
        >
          Save as…
        </Button>
      ) : (
        <form
          className="flex items-center gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            if (!valid) return;
            onAction("save", naming);
            setNaming(null);
          }}
        >
          <input
            aria-label="Preset name"
            // biome-ignore lint/a11y/noAutofocus: the field was asked for by the click that opened it
            autoFocus
            value={naming}
            placeholder="name"
            onChange={(event) => setNaming(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              // Esc closes the field, not Models.
              event.stopPropagation();
              setNaming(null);
            }}
            className="h-8 w-32 rounded-md bg-transparent px-2 text-[0.8125rem] text-t1 outline-none ring-1 ring-l2 ring-inset placeholder:text-t3 focus-visible:ring-ring"
          />
          <Button type="submit" size="sm" disabled={disabled || !valid}>
            Save
          </Button>
        </form>
      )}
      {presets.active !== null && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={disabled}
          onClick={() => onAction("delete", presets.active ?? "")}
        >
          Delete {presets.active}
        </Button>
      )}
      {naming !== null && !valid && naming !== "" && (
        <span className="w-full text-xs text-bad-ink">
          A preset's name is a letter, then letters, digits, - or _.
        </span>
      )}
    </div>
  );
}

/** "New role…": a name of the user's own; giving it a model creates it in omp's settings (#2838). */
function NewRole({
  known,
  onPick,
}: {
  readonly known: readonly string[];
  readonly onPick: (name: string) => void;
}): ReactNode {
  const [name, setName] = useState<string | null>(null);
  if (name === null)
    return (
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="self-start"
        onClick={() => setName("")}
      >
        New role…
      </Button>
    );
  const taken = known.includes(name);
  const valid = OMP_NAME.test(name) && !taken;
  return (
    <form
      className="flex flex-col gap-1"
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid) return;
        onPick(name);
        setName(null);
      }}
    >
      <input
        aria-label="New role's name"
        // biome-ignore lint/a11y/noAutofocus: the field was asked for by the click that opened it
        autoFocus
        value={name}
        placeholder="name, then Enter"
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.stopPropagation();
          setName(null);
        }}
        className="h-8 rounded-md bg-transparent px-2 text-[0.8125rem] text-t1 outline-none ring-1 ring-l2 ring-inset placeholder:text-t3 focus-visible:ring-ring"
      />
      {name !== "" && !valid && (
        <span className="text-xs text-bad-ink">
          {taken
            ? "That role is there already."
            : "A role's name is a letter, then letters, digits, - or _."}
        </span>
      )}
    </form>
  );
}

/**
 * omp's model hub (Alt+M) for this pane's chat, its Roles view: the roles on the left with the model each uses (its own,
 * omp's auto-selection, or none), and the picked role's models on the right. A click or Enter on a model gives it to the
 * role (`default` also switches this chat), the thinking chips set the role's level, Clear role (X) returns it to omp's
 * auto-selection. omp's status line shows under the lists.
 */
export function ModelHub({ controller }: { readonly controller: ChatController }): ReactNode {
  const open = useSyncExternalStore(
    controller.modelHubToggle.subscribe,
    controller.modelHubToggle.getSnapshot,
  );
  const [hub, setHub] = useState<Hub | null>(() => keptHub(controller.folder).get() ?? null);
  const [problem, setProblem] = useState<string | null>(null);
  const [picked, setPicked] = useState("default");
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"project" | "global">("project");
  const [status, setStatus] = useState<readonly string[]>([]);
  const [pending, setPending] = useState(false);
  /** A role named with "New role…" that omp does not list yet: its first model creates it. */
  const [created, setCreated] = useState<string | null>(null);
  const rolesRef = useRef<HTMLDivElement>(null);
  const modelsRef = useRef<HTMLDivElement>(null);
  const levelsRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLElement>(null);

  // omp's hub reads the settings again each time it opens: another chat or omp's terminal may have changed them. Until
  // the read answers, the dialog shows the hub it showed last.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setProblem(null);
    setStatus([]);
    setQuery("");
    // Opened from the model menu's "Roles and models…": at the chat's role.
    const asked = controller.modelHubToggle.roleAsked();
    if (asked !== null) setPicked(asked);
    controller
      .modelHub()
      .then((read) => {
        keptHub(controller.folder).set(read);
        if (!alive) return;
        setHub(read);
        // The first read lands after the dialog opened on its header: the picked role takes the focus.
        requestAnimationFrame(() => {
          if (document.activeElement === headerRef.current)
            rolesRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
        });
      })
      .catch((failure: unknown) => alive && setProblem(failureText(failure)));
    return () => {
      alive = false;
    };
  }, [open, controller]);

  const listed = hub?.roles.find((each) => each.role === picked);
  const role: HubRole | undefined =
    listed ??
    (created !== null && created === picked
      ? {
          role: created,
          tag: null,
          name: created,
          section: "chat",
          value: null,
          provenance: "default",
          model: null,
          thinkingLevel: null,
          autoSelected: false,
          fallbacks: [],
        }
      : hub?.roles[0]);
  // A new role takes the chat models, as Default does (omp's `acceptsChat`).
  const models =
    hub === null || role === undefined
      ? []
      : modelsFor(hub, listed === undefined ? "default" : role.role, query);
  /** The role's model of its own (not omp's auto-selection), as the hub lists it: its levels are the role's to set. */
  const ownModel = role !== undefined && !role.autoSelected ? role.model : null;
  const own =
    ownModel === null ? undefined : hub?.models.find((each) => keyOf(each) === keyOf(ownModel));
  const scoped = hub?.storage === "project" ? { scope } : {};

  const reload = async (): Promise<void> => {
    const read = await controller.modelHub();
    keptHub(controller.folder).set(read);
    setHub(read);
  };

  const run = (action: () => Promise<readonly string[]>): void => {
    if (pending) return;
    setPending(true);
    setProblem(null);
    action()
      .then(async (lines) => {
        setStatus(lines);
        await reload();
      })
      .catch((failure: unknown) => setProblem(failureText(failure)))
      .finally(() => setPending(false));
  };

  /** Gives the picked role this model, keeping its level where the model can apply it (omp's rule). */
  const assign = (model: HubModel, level?: string): void => {
    if (role === undefined) return;
    run(async () => {
      const result = await controller.assignRole({
        provider: model.provider,
        modelId: model.modelId,
        role: role.role,
        thinkingLevel: (level ?? assignLevel(role, model)) as Level,
        ...scoped,
      });
      // omp's hub says nothing when it did not apply the model.
      return result.applied ? [result.status] : [];
    });
  };

  const clear = (): void => {
    if (role === undefined || role.value === null) return;
    run(() => controller.clearRole({ role: role.role, ...scoped }));
  };

  const pick = (next: HubRole): void => {
    setPicked(next.role);
    setQuery("");
  };

  /** The roles list's keys: the arrows pick, Enter or Right goes to the models, X, Backspace or Delete clears, T to the levels. */
  const onRoleKeys = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (moveFocus(event)) {
      const focused = document.activeElement as HTMLElement | null;
      const next = hub?.roles.find((each) => each.role === focused?.dataset.role);
      if (next !== undefined) pick(next);
      return;
    }
    if (event.key === "Enter" || event.key === "ArrowRight") {
      event.preventDefault();
      modelsRef.current?.querySelector<HTMLElement>('[tabindex="0"]')?.focus();
    } else if (event.key === "x" || event.key === "Backspace" || event.key === "Delete") {
      event.preventDefault();
      clear();
    } else if (event.key === "t") {
      event.preventDefault();
      const levels = levelsRef.current;
      (
        levels?.querySelector<HTMLElement>('[aria-pressed="true"]') ??
        levels?.querySelector<HTMLElement>("button")
      )?.focus();
    }
  };

  /** The models list's keys: the arrows move and Left goes back to the roles (Enter and Space are each row's). */
  const onModelKeys = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (moveFocus(event)) return;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      rolesRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
    }
  };

  const roleModel = role?.model ?? null;
  const tabbable =
    (roleModel === null ? undefined : models.find((each) => keyOf(each) === keyOf(roleModel))) ??
    models[0];

  return (
    <Dialog
      open={open}
      onOpenChange={(next, details) => {
        if (next) return;
        // omp's Esc ladder: a search is cleared first, then the hub closes.
        if (details.reason === "escape-key" && query !== "") {
          details.cancel();
          setQuery("");
          return;
        }
        controller.modelHubToggle.hide();
      }}
    >
      <DialogContent
        data-tour="model-hub"
        showCloseButton={false}
        // The picked role takes the focus, else the header (the hub is still being read): never a button, whose
        // tooltip would take the first Esc.
        initialFocus={() =>
          rolesRef.current?.querySelector<HTMLElement>('[aria-selected="true"]') ??
          headerRef.current
        }
        className="flex h-[min(680px,92dvh)] w-[min(960px,96vw)] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none"
      >
        <header
          ref={headerRef}
          tabIndex={-1}
          className="flex items-center gap-3 border-b border-l2 px-4 py-3 outline-none"
        >
          <DialogTitle className="text-sm font-semibold text-t1">Models</DialogTitle>
          <DialogDescription className="text-xs text-t3">
            Which model each of omp's roles uses; giving Default a model also switches this chat.
          </DialogDescription>
        </header>
        {hub !== null && (hub.presets as Hub["presets"] | undefined) !== undefined && (
          <PresetRow
            presets={hub.presets}
            disabled={pending}
            onAction={(action, name) =>
              run(async () => {
                const { status } = await controller.modelPreset(action, name);
                return [status];
              })
            }
          />
        )}
        {hub === null ? (
          <p className="flex-1 p-6 text-t3">{problem ?? "Reading the models…"}</p>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
            <div className="flex max-h-48 shrink-0 flex-col border-b border-l2 sm:max-h-none sm:w-72 sm:border-r sm:border-b-0">
              <div
                ref={rolesRef}
                role="listbox"
                aria-label="Roles"
                onKeyDown={onRoleKeys}
                className="min-h-0 flex-1 overflow-y-auto p-1.5"
              >
                {roleGroups(hub).map((group) => (
                  // biome-ignore lint/a11y/useSemanticElements: a listbox's group of options (ARIA), not a fieldset of controls
                  <div key={group.title} role="group" aria-label={group.title}>
                    <p className="px-2.5 pt-2 pb-1 text-[11px] font-medium text-t3">
                      {group.title}
                    </p>
                    {group.roles.map((each) => {
                      const chosen = each.role === role?.role;
                      const level =
                        each.thinkingLevel !== null && each.thinkingLevel !== "inherit"
                          ? ` · ${each.thinkingLevel}`
                          : "";
                      return (
                        <div
                          key={each.role}
                          data-role={each.role}
                          aria-label={`${each.tag === null ? each.name : `${each.tag} ${each.name}`}: ${roleValueText(each)}${level}`}
                          role="option"
                          aria-selected={chosen}
                          tabIndex={chosen ? 0 : -1}
                          onClick={() => pick(each)}
                          onKeyDown={(event) => {
                            if (event.key === " ") {
                              event.preventDefault();
                              pick(each);
                            }
                          }}
                          className={`flex cursor-pointer flex-col gap-0.5 rounded-md px-2.5 py-1.5 outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                            chosen ? "bg-l2" : "hover:bg-l1"
                          }`}
                        >
                          <span className="flex items-baseline gap-2 text-[0.8125rem]">
                            <span className="font-mono text-[11px] tracking-wide text-t1">
                              {each.tag ?? each.name}
                            </span>
                            {each.tag !== null && (
                              <span className={chosen ? "text-t1" : "text-t2"}>{each.name}</span>
                            )}
                          </span>
                          <span
                            className={`truncate font-mono text-[11px] ${
                              each.autoSelected || each.model === null
                                ? chosen
                                  ? "text-t2"
                                  : "text-t3"
                                : "text-t1"
                            }`}
                          >
                            {roleValueText(each)}
                            {level}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
              <div className="border-t border-l2 p-1.5">
                <NewRole
                  known={hub.roles.map((each) => each.role)}
                  onPick={(name) => {
                    setCreated(name);
                    setPicked(name);
                    setQuery("");
                  }}
                />
              </div>
            </div>
            {/* min-w-0: a flex child would otherwise grow to its widest content (the level chips) past the dialog. */}
            <section
              aria-label="Role's model"
              className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 p-3"
            >
              {role !== undefined && (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-[0.8125rem] text-t2">
                      Assigning{" "}
                      <span className="font-semibold text-t1">{role.tag ?? role.name}</span>
                    </h3>
                    <span className="flex-1" />
                    {own !== undefined && own.thinkingLevels.length > 0 && (
                      <div ref={levelsRef} className="flex min-w-0 flex-wrap items-center gap-1.5">
                        <span className="text-xs text-t3">Thinking</span>
                        <ToggleGroup
                          aria-label="Thinking level"
                          className="flex-wrap"
                          value={[role.thinkingLevel ?? "inherit"]}
                          onValueChange={(value: string[]) => {
                            const next = value[0];
                            if (next !== undefined && next !== role.thinkingLevel)
                              assign(own, next);
                          }}
                        >
                          {own.thinkingLevels.map((level) => (
                            <ToggleGroupItem
                              key={level}
                              value={level}
                              size="sm"
                              className="h-6 px-2 text-xs"
                            >
                              {level}
                            </ToggleGroupItem>
                          ))}
                        </ToggleGroup>
                      </div>
                    )}
                    {role.value !== null && (
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              aria-keyshortcuts="x"
                              disabled={pending}
                              onClick={clear}
                            />
                          }
                        >
                          Clear role
                        </TooltipTrigger>
                        <TooltipContent>Back to omp's auto-selection (X)</TooltipContent>
                      </Tooltip>
                    )}
                  </div>
                  {/* A host older than fallbacks sends none: the block waits for its update (#2838). */}
                  {(role.fallbacks as readonly string[] | undefined) !== undefined && (
                    <Fallbacks
                      role={role}
                      hub={hub}
                      disabled={pending}
                      onChange={(chain) =>
                        run(async () => [await controller.setRoleFallbacks(role.role, chain)])
                      }
                    />
                  )}
                  <input
                    type="search"
                    aria-label="Search models"
                    placeholder="Search models"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "ArrowDown") {
                        event.preventDefault();
                        modelsRef.current?.querySelector<HTMLElement>('[role="option"]')?.focus();
                      }
                    }}
                    className="h-8 rounded-md bg-transparent px-2.5 text-[0.8125rem] text-t1 outline-none ring-1 ring-l2 ring-inset placeholder:text-t3 focus-visible:ring-ring"
                  />
                  <div
                    ref={modelsRef}
                    role="listbox"
                    aria-label="Models"
                    onKeyDown={onModelKeys}
                    className="min-h-0 flex-1 overflow-y-auto"
                  >
                    {models.length === 0 && (
                      <p className="px-2.5 py-2 text-[0.8125rem] text-t3">
                        {query === "" ? "No model can take this role." : "No model matches."}
                      </p>
                    )}
                    {models.map((model) => {
                      const key = keyOf(model);
                      const assigned =
                        role.model !== null && !role.autoSelected && key === keyOf(role.model);
                      const inUse = hub.current !== null && key === keyOf(hub.current);
                      return (
                        <div
                          key={key}
                          data-model={key}
                          aria-label={`${model.name}, ${key}${inUse ? ", in use" : ""}`}
                          role="option"
                          aria-selected={assigned}
                          tabIndex={model === tabbable ? 0 : -1}
                          onClick={() => assign(model)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              assign(model);
                            }
                          }}
                          className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 outline-none hover:bg-l1 focus-visible:bg-l1 focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <Check
                            aria-hidden
                            className={`size-3.5 shrink-0 ${assigned ? "text-accent-ink" : "invisible"}`}
                          />
                          <span className="min-w-0 truncate text-[0.8125rem] text-t1">
                            {model.name}
                          </span>
                          <span className="min-w-0 truncate font-mono text-[11px] text-t3 max-sm:hidden">
                            {key}
                          </span>
                          {/* On a phone the name keeps the room; the provider still tells two same-named models apart. */}
                          <span className="shrink-0 font-mono text-[11px] text-t3 sm:hidden">
                            {model.provider}
                          </span>
                          <span className="flex-1" />
                          {inUse && (
                            <span className="shrink-0 text-xs text-accent-ink">in use</span>
                          )}
                          <span className="w-12 shrink-0 text-right text-xs text-t3 tabular-nums">
                            {windowText(model.contextWindow)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </section>
          </div>
        )}
        <footer className="flex items-center gap-2 border-t border-l2 px-4 py-3">
          <p role="status" className="min-w-0 flex-1 truncate text-xs">
            {pending ? (
              <span className="text-t3">Applying model…</span>
            ) : problem !== null && hub !== null ? (
              <span className="text-bad-ink">{problem}</span>
            ) : (
              <span className="text-t2">{status.join(" · ")}</span>
            )}
          </p>
          {hub?.storage === "project" && (
            <ToggleGroup
              aria-label="Save to"
              value={[scope]}
              onValueChange={(value: string[]) => {
                const next = value[0];
                if (next === "project" || next === "global") setScope(next);
              }}
            >
              <ToggleGroupItem value="project" size="sm" className="h-6 px-2 text-xs">
                Project
              </ToggleGroupItem>
              <ToggleGroupItem value="global" size="sm" className="h-6 px-2 text-xs">
                Global
              </ToggleGroupItem>
            </ToggleGroup>
          )}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  aria-keyshortcuts="Escape"
                  onClick={() => controller.modelHubToggle.hide()}
                />
              }
            >
              Close
            </TooltipTrigger>
            <TooltipContent>Close (Esc)</TooltipContent>
          </Tooltip>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
