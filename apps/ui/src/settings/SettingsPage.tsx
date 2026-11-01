import type { AppClient } from "@omp-app/client";
import type { ConfigWriteLayer, ConfigWriteValue, FolderPath } from "@omp-app/contracts";
import { ChevronLeft, ChevronRight, Search, TriangleAlert } from "lucide-react";
import { Fragment, type ReactNode, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ChatController } from "../chat/controller";
import { AppPage } from "./AppPage";
import { loadSettingsData, type SettingDef, type SettingsData, type SettingsTab } from "./data";
import { changedHere, type Entries, inForce, matches, sections, shown, valueText } from "./model";
import { SettingControl, wide } from "./SettingControl";
import { SignIn } from "./SignIn";
import { type Config, useConfig } from "./useConfig";

/** The app's own tab, before omp's. */
const APP_TAB = "app";
const words = (failure: unknown): string =>
  failure instanceof Error ? failure.message : String(failure);

/** Where the settings open: the app's tab, or its Server section with the cursor in the link field. */
export type SettingsPlace = "app" | "server";

/**
 * omp's settings in one sheet, as Tern's prefs page: tabs with what changed, search, and each row's Reset. On a phone it
 * fills the screen as iOS Settings does: the sections as rows with ›, each opening a screen of its own with ‹ back.
 */
export function SettingsPage({
  client,
  folder,
  controller,
  phone,
  place,
  open,
  onOpenChange,
  onWhatsNew,
}: {
  readonly client: AppClient;
  /** The open folder, whose own settings the scope switch reaches. */
  readonly folder: FolderPath;
  /** The chat focused when the settings opened: provider sign-in runs in it. */
  readonly controller: ChatController | null;
  readonly phone: boolean;
  readonly place: SettingsPlace;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Opens What's new: on a phone the App page has its row, as the list has no menu for it. */
  readonly onWhatsNew: () => void;
}): ReactNode {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && (
        <SettingsSheet
          client={client}
          folder={folder}
          controller={controller}
          phone={phone}
          place={place}
          onClose={() => onOpenChange(false)}
          onWhatsNew={onWhatsNew}
        />
      )}
    </Dialog>
  );
}

function SettingsSheet({
  client,
  folder,
  controller,
  phone,
  place,
  onClose,
  onWhatsNew,
}: {
  readonly client: AppClient;
  readonly folder: FolderPath;
  readonly controller: ChatController | null;
  readonly phone: boolean;
  readonly place: SettingsPlace;
  readonly onClose: () => void;
  readonly onWhatsNew: () => void;
}): ReactNode {
  const [data, setData] = useState<SettingsData | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    loadSettingsData().then(
      (loaded) => alive && setData(loaded),
      (failure: unknown) =>
        alive && setProblem(`The settings could not be loaded: ${words(failure)}`),
    );
    return () => {
      alive = false;
    };
  }, []);
  const [thisFolder, setThisFolder] = useState(false);
  const layer: ConfigWriteLayer = thisFolder ? "project" : "global";
  const config = useConfig(client, thisFolder ? { layer, folder } : { layer, folder: null });
  // On a phone the tab list comes first, then the chosen tab; elsewhere, or for the Server section, the app's own tab.
  const [tabId, setTabId] = useState<string | null>(phone && place === "app" ? null : APP_TAB);
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();

  const byKey = useMemo(() => new Map((data?.settings ?? []).map((def) => [def.key, def])), [data]);
  const read = (key: string): unknown => {
    const def = byKey.get(key);
    if (def !== undefined) return inForce(def, config.entries);
    const entry = config.entries.get(key);
    return entry === undefined || entry.secret ? undefined : entry.value;
  };
  const visible = (data?.settings ?? []).filter((def) => shown(def, read, config.entries));
  const changedIn = (tab: string): number =>
    visible.filter((def) => def.tab === tab && changedHere(config.entries.get(def.key), layer))
      .length;
  const tab = data?.tabs.find((each) => each.id === tabId) ?? null;
  const appOpen = needle === "" && tabId === APP_TAB;
  const showPage = !phone || tabId !== null || needle !== "";
  const choose = (id: string): void => {
    setQuery("");
    setTabId(id);
  };

  /** A phone's Done, 44 px, where a desktop has the sheet's ×. */
  const done = (
    <Button variant="ghost" className="h-11 shrink-0 px-3 text-t1" onClick={onClose}>
      Done
    </Button>
  );
  const nav = (
    <nav
      aria-label="Settings sections"
      className={`flex min-h-0 flex-col gap-2 border-l2 ${phone ? "flex-1 px-3 pt-1 pb-3" : "w-56 shrink-0 border-r p-3"}`}
    >
      {phone ? (
        <div className="flex h-11 items-center">
          <p className="min-w-0 flex-1 px-1 text-base font-semibold text-t1">Settings</p>
          {done}
        </div>
      ) : (
        <p className="px-1 text-sm font-medium text-t1">Settings</p>
      )}
      <label
        className={`flex items-center gap-2 rounded-md border border-l2 px-2 text-t3 focus-within:border-ring ${phone ? "h-11" : "h-8"}`}
      >
        <Search className="size-3.5 shrink-0" />
        <input
          type="search"
          aria-label="Search settings"
          placeholder="Search"
          // biome-ignore lint/a11y/noAutofocus: the sheet opens to find a setting
          autoFocus={!phone}
          value={query}
          className="min-w-0 flex-1 bg-transparent text-sm text-t1 outline-none placeholder:text-t3"
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <ul className="min-h-0 flex-1 overflow-y-auto">
        <li>
          <button
            type="button"
            data-tour="settings-tab-app"
            aria-current={appOpen ? "page" : undefined}
            className={`flex w-full items-center rounded-md px-2 text-left ${phone ? "h-13 text-base text-t1" : `h-8 text-sm ${appOpen ? "bg-l2 text-t1" : "text-t2 hover:bg-l1 hover:text-t1"}`}`}
            onClick={() => choose(APP_TAB)}
          >
            <span className="min-w-0 flex-1 truncate">App</span>
            {phone && <ChevronRight aria-hidden="true" className="size-4 text-t3" />}
          </button>
        </li>
        <li aria-hidden className="px-2 pt-3 pb-1 text-xs text-t3">
          omp
        </li>
        {(data?.tabs ?? []).map((each) => {
          const count = changedIn(each.id);
          const current = needle === "" && each.id === tabId;
          return (
            <li key={each.id}>
              <button
                type="button"
                aria-current={current ? "page" : undefined}
                aria-label={count > 0 ? `${each.label}, ${count} changed` : each.label}
                data-tour={`settings-tab-${each.id}`}
                className={`flex w-full items-center gap-2 rounded-md px-2 text-left ${phone ? "h-13 text-base text-t1" : `h-8 text-sm ${current ? "bg-l2 text-t1" : "text-t2 hover:bg-l1 hover:text-t1"}`}`}
                onClick={() => choose(each.id)}
              >
                <span className="min-w-0 flex-1 truncate">{each.label}</span>
                {count > 0 && <span className="text-xs text-accent-ink">{count} changed</span>}
                {phone && <ChevronRight aria-hidden="true" className="size-4 text-t3" />}
              </button>
            </li>
          );
        })}
      </ul>
      {data !== null && <p className="px-1 text-xs text-t3">omp {data.omp}</p>}
    </nav>
  );

  return (
    <DialogContent
      data-tour="settings-sheet"
      showCloseButton={!phone}
      className={
        phone
          ? // The whole screen, inside the safe areas, as a phone's own Settings.
            "top-0 left-0 flex h-full max-h-none w-full max-w-none translate-x-0 translate-y-0 flex-row gap-0 overflow-hidden rounded-none p-0 pt-(--safe-top) pb-(--safe-bottom) ring-0 sm:max-w-none"
          : "flex h-[min(780px,94dvh)] w-[min(1080px,96vw)] max-w-none flex-row gap-0 overflow-hidden p-0 sm:max-w-none"
      }
    >
      <DialogTitle className="sr-only">Settings</DialogTitle>
      {(!phone || !showPage) && nav}
      {showPage && (
        <main className="flex min-w-0 flex-1 flex-col">
          <header
            className={
              phone
                ? "flex flex-col gap-2 border-b border-l2 px-3 pt-1 pb-3"
                : "flex flex-wrap items-center gap-2 border-b border-l2 px-5 py-2.5 pr-12"
            }
          >
            {phone && (
              <div className="flex h-11 items-center gap-1">
                <Button
                  variant="ghost"
                  className="-ml-2 h-11 shrink-0 text-t2"
                  onClick={() => {
                    setQuery("");
                    setTabId(null);
                  }}
                >
                  <ChevronLeft />
                  Settings
                </Button>
                {/* The page's own heading names it, as iOS Settings' large titles do. */}
                <span className="flex-1" />
                {done}
              </div>
            )}
            {/* omp's settings only: on a phone the App page, whose settings this browser keeps, has no scope. */}
            {!(phone && appOpen) && (
              <>
                <ToggleGroup
                  aria-label="Whose settings"
                  size="sm"
                  spacing={0.5}
                  className={`rounded-lg border border-l2 p-0.5 ${phone ? "w-full" : ""}`}
                  value={[thisFolder ? "folder" : "every"]}
                  onValueChange={(next: string[]) => {
                    if (next[0] !== undefined) setThisFolder(next[0] === "folder");
                  }}
                >
                  <ToggleGroupItem
                    value="every"
                    className={`text-t3 hover:text-t1 aria-pressed:bg-l2 aria-pressed:text-t1 ${phone ? "h-10 flex-1 text-sm" : "h-6 px-2 text-xs"}`}
                  >
                    Every folder
                  </ToggleGroupItem>
                  <ToggleGroupItem
                    value="folder"
                    className={`text-t3 hover:text-t1 aria-pressed:bg-l2 aria-pressed:text-t1 ${phone ? "h-10 flex-1 text-sm" : "h-6 px-2 text-xs"}`}
                  >
                    This folder
                  </ToggleGroupItem>
                </ToggleGroup>
                <span className={`min-w-0 text-xs text-t3 ${phone ? "px-1" : "truncate"}`}>
                  {thisFolder
                    ? `Saved in ${folder.split("/").filter(Boolean).at(-1) ?? folder}/.omp, for this folder only`
                    : "Saved in omp's settings file, for every folder"}
                </span>
              </>
            )}
          </header>
          <div className={`min-h-0 flex-1 overflow-y-auto pb-8 ${phone ? "px-3" : "px-5"}`}>
            {(problem ?? config.problem) !== null && (
              <p role="alert" className="pt-4 text-sm text-bad-ink">
                {problem ?? `The settings could not be read: ${config.problem}`}
              </p>
            )}
            {data !== null && needle !== "" && (
              <SearchResults
                data={data}
                defs={visible}
                needle={needle}
                config={config}
                layer={layer}
              />
            )}
            {appOpen && (
              <AppPage
                client={client}
                focusServerLink={place === "server"}
                onWhatsNew={onWhatsNew}
              />
            )}
            {data !== null && needle === "" && tab !== null && (
              <TabPage
                tab={tab}
                index={data.tabs.indexOf(tab)}
                defs={visible.filter((def) => def.tab === tab.id)}
                config={config}
                layer={layer}
                first={tab.id === "providers" ? <SignIn controller={controller} /> : null}
              />
            )}
          </div>
        </main>
      )}
    </DialogContent>
  );
}

function TabPage({
  tab,
  index,
  defs,
  config,
  layer,
  first,
}: {
  readonly tab: SettingsTab;
  readonly index: number;
  readonly defs: readonly SettingDef[];
  readonly config: Config;
  readonly layer: ConfigWriteLayer;
  /** What the tab shows before omp's settings (the Providers tab's sign-in). */
  readonly first: ReactNode;
}): ReactNode {
  return (
    <section aria-label={tab.label}>
      <p className="pt-5 text-xs text-t3">
        {String(index + 1).padStart(2, "0")} · {tab.label}
      </p>
      <h2 className="mt-1 text-lg font-medium text-t1">{tab.label}</h2>
      <p className="mt-1 text-sm text-t2">{tab.lead}</p>
      {first}
      {sections(tab, defs).map(({ group, defs: rows }) => (
        <Fragment key={group ?? ""}>
          {group !== null && <h3 className="mt-6 text-xs font-medium text-t3">{group}</h3>}
          <div className={group === null ? "mt-4" : "mt-1"}>
            {rows.map((def) => (
              <SettingRow key={def.key} def={def} config={config} layer={layer} needle="" />
            ))}
          </div>
        </Fragment>
      ))}
      {defs.length === 0 && <p className="mt-6 text-sm text-t3">Nothing to set here.</p>}
    </section>
  );
}

function SearchResults({
  data,
  defs,
  needle,
  config,
  layer,
}: {
  readonly data: SettingsData;
  readonly defs: readonly SettingDef[];
  readonly needle: string;
  readonly config: Config;
  readonly layer: ConfigWriteLayer;
}): ReactNode {
  const found = defs.filter((def) => matches(def, needle));
  if (found.length === 0)
    return <p className="pt-5 text-sm text-t3">No settings match “{needle}”.</p>;
  return (
    <section aria-label="Search results">
      {data.tabs.map((tab) => {
        const rows = found.filter((def) => def.tab === tab.id);
        if (rows.length === 0) return null;
        return (
          <Fragment key={tab.id}>
            <h2 className="mt-6 text-xs font-medium text-t3">{tab.label}</h2>
            {rows.map((def) => (
              <SettingRow key={def.key} def={def} config={config} layer={layer} needle={needle} />
            ))}
          </Fragment>
        );
      })}
    </section>
  );
}

/** The search's match marked in a text. */
function marked(text: string, needle: string): ReactNode {
  if (needle === "") return text;
  const at = text.toLowerCase().indexOf(needle);
  if (at < 0) return text;
  return (
    <>
      {text.slice(0, at)}
      <mark className="rounded-sm bg-accent/25 text-t1">{text.slice(at, at + needle.length)}</mark>
      {text.slice(at + needle.length)}
    </>
  );
}

function SettingRow({
  def,
  config,
  layer,
  needle,
}: {
  readonly def: SettingDef;
  readonly config: Config;
  readonly layer: ConfigWriteLayer;
  readonly needle: string;
}): ReactNode {
  const [problem, setProblem] = useState<string | null>(null);
  const entries: Entries = config.entries;
  const entry = entries.get(def.key);
  const changed = changedHere(entry, layer);
  // A variable the setting declares wins over every file while it is set: the row says so and cannot be edited.
  const variable = entry?.source === "env" ? (entry.overriddenBy ?? "a variable") : null;
  const write = (value: ConfigWriteValue | "unset"): void => {
    setProblem(null);
    config
      .write(def.key, value)
      .catch((failure: unknown) => setProblem(`Could not save it: ${words(failure)}`));
  };
  const control = (
    <SettingControl
      def={def}
      entry={entry}
      value={inForce(def, entries)}
      disabled={variable !== null || !config.loaded}
      write={write}
    />
  );
  return (
    <div className="border-b border-l1 py-3 last:border-b-0">
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-sm text-t1">
            <span>{marked(def.label, needle)}</span>
            {changed && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span
                      role="img"
                      aria-label={`Changed from default: ${valueText(def, def.default)}`}
                      className="size-1.5 shrink-0 rounded-full bg-accent-ink"
                    />
                  }
                />
                <TooltipContent side="top">
                  Changed from default: {valueText(def, def.default)}
                </TooltipContent>
              </Tooltip>
            )}
          </div>
          {/* Under 80 characters a line: 54ch, as this font's "0" (what ch measures) is wider than most letters. */}
          <p className="mt-0.5 max-w-[54ch] text-xs leading-relaxed text-pretty text-t3">
            {def.terminalOnly === true && <span className="text-t2">Terminal only. </span>}
            {marked(def.description, needle)}
          </p>
          {def.warning !== undefined && (
            <p className="mt-1 flex max-w-[54ch] items-center gap-1 text-xs text-pretty text-warn-ink">
              <TriangleAlert className="size-3.5 shrink-0" />
              {def.warning}
            </p>
          )}
          {variable !== null && (
            <p className="mt-1 max-w-[54ch] text-xs text-pretty text-t2">
              ${variable} sets it while that variable is set.
            </p>
          )}
          {problem !== null && (
            <p role="alert" className="mt-1 text-xs text-bad-ink">
              {problem}
            </p>
          )}
        </div>
        {!wide(def) && <div className="flex shrink-0 items-center">{control}</div>}
        {changed && variable === null && (
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Reset ${def.label}`}
            onClick={() => write("unset")}
          >
            Reset
          </Button>
        )}
      </div>
      {wide(def) && <div className="mt-2">{control}</div>}
    </div>
  );
}
