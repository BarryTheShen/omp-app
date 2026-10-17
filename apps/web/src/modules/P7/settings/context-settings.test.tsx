import type { AppClient } from "@omp-app/client";
import type {
  ConfigChanged,
  ConfigEntry,
  ConfigWriteArgs,
  ConfigWriteResult,
  JsonValue,
} from "@omp-app/contracts";
import {
  AppFailure,
  ConfigStore,
  ConfigWriteArgs as ConfigWriteArgsSchema,
} from "@omp-app/contracts";
import {
  act,
  cleanup,
  fireEvent,
  type RenderResult,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type {
  ConfigStoreClient,
  ScalarSettingControl,
  SettingControl,
} from "../../S1/settings-kit";
import { ContextSettings } from "./context-settings";
import { DEFAULT_COMPACTION_METHOD_ORDER, P7_CONTEXT_NUMERIC_SETTINGS } from "./descriptors";
import { P7_CONTEXT_SETTINGS_SECTIONS } from "./index";

afterEach(cleanup);

const COMPACTION_SECTION = "P7.contextCompaction";
const GENERAL_SECTION = "P7.contextGeneral";
const SECTION_IDS = [
  "P7.contextGeneral",
  "P7.contextCompaction",
  "P7.contextRulesTtsr",
  "P7.contextExperimental",
] as const;

interface FakeStore {
  readonly client: ConfigStoreClient;
  readonly listeners: Set<(change: ConfigChanged) => void>;
  readonly state: {
    entries: ConfigEntry[];
    revision: string;
    outsideCount: number;
    readonly writes: ConfigWriteArgs[];
    failNextWrite: AppFailure | undefined;
    /** Keys whose writes fail with a permission error, so a save can write some settings and then fail. */
    failKeys: Set<string>;
    failLists: AppFailure | undefined;
    /** Runs after each successful write, so a test can make another writer change the file at that moment. */
    afterWrite: ((args: ConfigWriteArgs) => void) | undefined;
    holdLists: Promise<void> | undefined;
  };
}

/** A ConfigStore that keeps entries in memory, with one write that can be made to fail. */
function fakeStore(entries: readonly ConfigEntry[]): FakeStore {
  const state: FakeStore["state"] = {
    entries: [...entries],
    revision: "view-revision-1",
    outsideCount: 0,
    writes: [],
    failNextWrite: undefined,
    failKeys: new Set<string>(),
    failLists: undefined,
    afterWrite: undefined,
    holdLists: undefined,
  };
  const listeners = new Set<(change: ConfigChanged) => void>();
  const client: ConfigStoreClient = {
    async read({ key }) {
      const entry = state.entries.find((candidate) => candidate.key === key);
      if (!entry) {
        throw new AppFailure({
          code: "not_found",
          message: "The requested setting was not found.",
          retryable: false,
        });
      }
      return entry;
    },
    async list() {
      if (state.holdLists) await state.holdLists;
      if (state.failLists) throw state.failLists;
      return { entries: [...state.entries], revision: state.revision };
    },
    async write(input): Promise<ConfigWriteResult> {
      const args = ConfigWriteArgsSchema.parse(input);
      state.writes.push(args);
      if (state.failNextWrite) {
        const failure = state.failNextWrite;
        state.failNextWrite = undefined;
        throw failure;
      }
      if (state.failKeys.has(args.key)) {
        throw new AppFailure({
          code: "internal",
          message: "Cannot write configuration: permission denied.",
          retryable: true,
        });
      }
      if (args.expectedRevision !== state.revision) {
        throw new AppFailure({
          code: "conflict",
          message: "Settings changed elsewhere.",
          retryable: true,
        });
      }
      const previousRevision = state.revision;
      state.revision = `view-revision-${state.writes.length + 1}`;
      const entry: ConfigEntry = args.value.secret
        ? {
            key: args.key,
            secret: true,
            isSet: args.value.action === "set",
            source: args.layer,
            overrides: [],
          }
        : {
            key: args.key,
            secret: false,
            value: args.value.value,
            source: args.layer,
            overrides: ["default"],
          };
      state.entries = [...state.entries.filter((candidate) => candidate.key !== args.key), entry];
      state.afterWrite?.(args);
      return {
        key: args.key,
        layer: args.layer,
        folder: args.folder,
        previousRevision,
        revision: state.revision,
        entry,
      };
    },
  };
  return { client, state, listeners };
}

function isScalar(control: SettingControl): control is ScalarSettingControl {
  return control.kind !== "map" && control.kind !== "rows";
}

/** The value omp reports for a control that has no setting of its own; omp reports numbers as numbers. */
function defaultValue(control: ScalarSettingControl): JsonValue {
  if (control.key === "compaction.methodOrder") return [...DEFAULT_COMPACTION_METHOD_ORDER];
  if (control.kind === "boolean") return false;
  if (control.kind === "enum") {
    const first = control.options?.[0]?.value ?? "";
    return P7_CONTEXT_NUMERIC_SETTINGS.includes(control.key) ? Number(first) : first;
  }
  return [];
}

/** Every key of the section listed with omp's default, then the given overrides, as omp lists them. */
function withDefaults(sectionId: string, overrides: readonly ConfigEntry[]): ConfigEntry[] {
  const section = P7_CONTEXT_SETTINGS_SECTIONS.find((candidate) => candidate.id === sectionId);
  if (!section) throw new Error(`no section ${sectionId}`);
  const byKey = new Map<string, ConfigEntry>();
  for (const control of section.controls.filter(isScalar)) {
    byKey.set(control.key, {
      key: control.key,
      secret: false,
      value: defaultValue(control),
      source: "default",
      overrides: [],
    });
  }
  for (const entry of overrides) byKey.set(entry.key, entry);
  return [...byKey.values()];
}

/** Every Context section at omp's defaults, with the given overrides applied on top. */
function allSectionsStore(overrides: readonly ConfigEntry[] = []): FakeStore {
  const byKey = new Map<string, ConfigEntry>();
  for (const id of SECTION_IDS) {
    for (const entry of withDefaults(id, [])) byKey.set(entry.key, entry);
  }
  for (const entry of overrides) byKey.set(entry.key, entry);
  return fakeStore([...byKey.values()]);
}

/**
 * The app client the view reads through: its ConfigStore port, and a change stream that tests can push
 * changes into.
 */
function appClient(store: FakeStore): AppClient {
  const client = {
    port(port: unknown): ConfigStoreClient {
      if (port !== ConfigStore) throw new Error("the Context view asked for an unexpected port");
      return store.client;
    },
    subscribe() {
      return Promise.resolve({
        unsubscribe: async () => undefined,
        onEvent: (listener: (change: ConfigChanged) => void) => {
          store.listeners.add(listener);
          return () => store.listeners.delete(listener);
        },
      });
    },
  };
  return client as unknown as AppClient;
}

/** Opens one section from the view's chips, as the person does, and returns its element. */
async function openSection(view: RenderResult, id: string): Promise<HTMLElement> {
  const title = P7_CONTEXT_SETTINGS_SECTIONS.find((section) => section.id === id)?.title;
  if (!title) throw new Error(`no section ${id}`);
  fireEvent.click(await view.findByRole("tab", { name: title }));
  return waitFor(() => {
    const found = view.container.querySelector<HTMLElement>(`[data-p7-context-section="${id}"]`);
    expect(found).not.toBeNull();
    if (!found) throw new Error(`the ${id} section did not load`);
    return found;
  });
}

async function renderSection(store: FakeStore, id: string): Promise<HTMLElement> {
  const view = render(<ContextSettings client={appClient(store)} scope={{ layer: "global" }} />);
  return openSection(view, id);
}

/** Lets the view's pending reads and writes finish. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

/** Another writer changes one setting; the change stream reports it under the key A1 reports for it. */
function outsideChange(store: FakeStore, entry: ConfigEntry, reportedKey: string): void {
  silentOutsideChange(store, entry);
  const change: ConfigChanged = {
    key: reportedKey,
    layer: "global",
    folder: null,
    revision: store.state.revision,
    entry,
  };
  for (const listener of store.listeners) listener(change);
}

/** Another writer changes one setting without the change stream reporting it. */
function silentOutsideChange(store: FakeStore, entry: ConfigEntry): void {
  store.state.entries = [
    ...store.state.entries.filter((candidate) => candidate.key !== entry.key),
    entry,
  ];
  store.state.outsideCount += 1;
  store.state.revision = `view-revision-outside-${store.state.outsideCount}`;
}

/** The Auto-Compact value another writer stores while this section holds an edit to it. */
const AUTO_COMPACT_OUTSIDE: ConfigEntry = {
  key: "compaction.enabled",
  secret: false,
  value: true,
  source: "global",
  overrides: [],
};

const MID_TURN_OUTSIDE: ConfigEntry = {
  key: "compaction.midTurnEnabled",
  secret: false,
  value: true,
  source: "global",
  overrides: [],
};

const TTSR_OUTSIDE: ConfigEntry = {
  key: "ttsr.enabled",
  secret: false,
  value: true,
  source: "global",
  overrides: [],
};

function thresholdEntry(value: number): ConfigEntry {
  return {
    key: "compaction.thresholdPercent",
    secret: false,
    value,
    source: "global",
    overrides: ["default"],
  };
}

describe("the Context section keeps the person's edits", () => {
  test("a failed save keeps the staged edit and the controls, and Save saves it again", async () => {
    const store = fakeStore(withDefaults(COMPACTION_SECTION, []));
    store.state.failNextWrite = new AppFailure({
      code: "internal",
      message: "Disk is full.",
      retryable: true,
    });
    const section = await renderSection(store, COMPACTION_SECTION);
    fireEvent.click(within(section).getByRole("checkbox", { name: "Auto-Compact" }));

    fireEvent.click(within(section).getByRole("button", { name: "Save changes" }));

    const alert = await within(section).findByRole("alert");
    expect(alert.textContent).toContain("Disk is full.");
    expect(within(section).queryByRole("button", { name: "Retry" })).toBeNull();
    const autoCompact = within(section).getByRole("checkbox", {
      name: "Auto-Compact",
    }) as HTMLInputElement;
    expect(autoCompact.checked).toBe(true);
    const save = within(section).getByRole("button", { name: "Save changes" }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);

    fireEvent.click(save);

    await waitFor(() => expect(store.state.writes).toHaveLength(2));
    expect(await within(section).findByText("Applied")).toBeTruthy();
  });

  test("a stored value off the menu is shown as its own choice and does not block Save", async () => {
    const store = fakeStore(withDefaults(COMPACTION_SECTION, [thresholdEntry(65)]));
    const section = await renderSection(store, COMPACTION_SECTION);
    const threshold = within(section).getByRole("combobox", {
      name: "Compaction Threshold",
    }) as HTMLSelectElement;
    expect(threshold.value).toBe("65");
    expect(within(threshold).getByRole("option", { name: "65 (current)" })).toBeTruthy();

    fireEvent.click(within(section).getByRole("checkbox", { name: "Auto-Compact" }));

    const save = within(section).getByRole("button", { name: "Save changes" }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    expect(within(section).queryByRole("alert")).toBeNull();
  });

  test("the method buttons' names begin with the words they show", async () => {
    const section = await renderSection(
      fakeStore(withDefaults(COMPACTION_SECTION, [])),
      COMPACTION_SECTION,
    );

    expect(within(section).getAllByRole("button", { name: /^Move up, / }).length).toBeGreaterThan(
      0,
    );
    expect(within(section).getAllByRole("button", { name: /^Move down, / }).length).toBeGreaterThan(
      0,
    );
  });
});

describe("the Context view can be embedded", () => {
  test("without its header, and it reports unsaved edits to its owner", async () => {
    const store = fakeStore(withDefaults(COMPACTION_SECTION, []));
    const dirty: boolean[] = [];
    const view = render(
      <ContextSettings
        client={appClient(store)}
        onDirtyChange={(value) => dirty.push(value)}
        scope={{ layer: "global" }}
        showHeader={false}
      />,
    );
    const section = await openSection(view, COMPACTION_SECTION);

    expect(view.container.querySelector("h1")).toBeNull();
    expect(dirty.at(-1)).toBe(false);
    fireEvent.click(within(section).getByRole("checkbox", { name: "Auto-Compact" }));
    expect(dirty.at(-1)).toBe(true);
  });

  test("unmounting clears the unsaved-edits report", async () => {
    const store = fakeStore(withDefaults(COMPACTION_SECTION, []));
    const dirty: boolean[] = [];
    const view = render(
      <ContextSettings
        client={appClient(store)}
        onDirtyChange={(value) => dirty.push(value)}
        scope={{ layer: "global" }}
        showHeader={false}
      />,
    );
    const section = await openSection(view, COMPACTION_SECTION);
    fireEvent.click(within(section).getByRole("checkbox", { name: "Auto-Compact" }));
    expect(dirty.at(-1)).toBe(true);

    view.unmount();
    expect(dirty.at(-1)).toBe(false);
  });
});

describe("the Context tab is laid out like the Appearance tab", () => {
  test("one section at a time, with a chip for each section", async () => {
    const view = render(
      <ContextSettings client={appClient(allSectionsStore())} scope={{ layer: "global" }} />,
    );
    await openSection(view, GENERAL_SECTION);

    expect(view.getAllByRole("tab")).toHaveLength(4);
    expect(view.container.querySelectorAll("[data-p7-context-section]")).toHaveLength(1);
  });

  test("staged edits survive switching to another section and back", async () => {
    const view = render(
      <ContextSettings client={appClient(allSectionsStore())} scope={{ layer: "global" }} />,
    );
    const compaction = await openSection(view, COMPACTION_SECTION);
    fireEvent.click(within(compaction).getByRole("checkbox", { name: "Auto-Compact" }));

    await openSection(view, GENERAL_SECTION);
    const back = await openSection(view, COMPACTION_SECTION);

    expect(
      (within(back).getByRole("checkbox", { name: "Auto-Compact" }) as HTMLInputElement).checked,
    ).toBe(true);
    expect(
      (within(back).getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  test("the search box leaves only the sections that match", async () => {
    const view = render(
      <ContextSettings client={appClient(allSectionsStore())} scope={{ layer: "global" }} />,
    );
    await openSection(view, GENERAL_SECTION);

    fireEvent.change(view.getByRole("searchbox"), { target: { value: "threshold" } });
    expect(view.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Compaction"]);

    fireEvent.change(view.getByRole("searchbox"), { target: { value: "no such setting" } });
    expect(view.getByText("No settings match this search.")).toBeTruthy();
  });
});

describe("a save keeps the other sections in step with omp", () => {
  test("a second section saves after the first without a false conflict", async () => {
    const store = allSectionsStore();
    const view = render(<ContextSettings client={appClient(store)} scope={{ layer: "global" }} />);
    const compaction = await openSection(view, COMPACTION_SECTION);

    fireEvent.click(within(compaction).getByRole("checkbox", { name: "Auto-Compact" }));
    fireEvent.click(within(compaction).getByRole("button", { name: "Save changes" }));
    await within(compaction).findByText("Applied");

    const general = await openSection(view, GENERAL_SECTION);
    fireEvent.click(within(general).getByRole("checkbox", { name: "Extended Context" }));
    fireEvent.click(within(general).getByRole("button", { name: "Save changes" }));
    await within(general).findByText("Applied");

    expect(view.container.querySelector('[role="alert"]')).toBeNull();
    expect(store.state.writes.map((write) => write.key)).toEqual([
      "compaction.enabled",
      "extendedContext",
    ]);
  });

  test("both sections staged, then saved one after the other: the second save is not a false conflict", async () => {
    const store = allSectionsStore();
    const view = render(<ContextSettings client={appClient(store)} scope={{ layer: "global" }} />);
    let general = await openSection(view, GENERAL_SECTION);
    fireEvent.click(within(general).getByRole("checkbox", { name: "Extended Context" }));
    const compactionFirst = await openSection(view, COMPACTION_SECTION);
    fireEvent.click(within(compactionFirst).getByRole("checkbox", { name: "Auto-Compact" }));

    general = await openSection(view, GENERAL_SECTION);
    fireEvent.click(within(general).getByRole("button", { name: "Save changes" }));
    await within(general).findByText("Applied");
    await settle();

    const compaction = await openSection(view, COMPACTION_SECTION);
    fireEvent.click(within(compaction).getByRole("button", { name: "Save changes" }));
    await within(compaction).findByText("Applied");

    expect(view.container.querySelector('[role="alert"]')).toBeNull();
    expect(store.state.writes.map((write) => write.key)).toEqual([
      "extendedContext",
      "compaction.enabled",
    ]);
  });

  test("a staged key another writer changed is still a conflict, and nothing is overwritten", async () => {
    const store = allSectionsStore();
    const view = render(<ContextSettings client={appClient(store)} scope={{ layer: "global" }} />);
    let general = await openSection(view, GENERAL_SECTION);
    fireEvent.click(within(general).getByRole("checkbox", { name: "Extended Context" }));
    const compactionFirst = await openSection(view, COMPACTION_SECTION);
    fireEvent.change(
      within(compactionFirst).getByRole("combobox", { name: "Compaction Threshold" }),
      { target: { value: "50" } },
    );
    store.state.afterWrite = (args) => {
      if (args.key === "extendedContext") silentOutsideChange(store, thresholdEntry(80));
    };
    general = await openSection(view, GENERAL_SECTION);
    fireEvent.click(within(general).getByRole("button", { name: "Save changes" }));
    await within(general).findByText("Applied");
    await settle();

    const compaction = await openSection(view, COMPACTION_SECTION);
    expect(within(compaction).queryByRole("alert")).toBeNull();
    expect(
      (
        within(compaction).getByRole("combobox", {
          name: "Compaction Threshold",
        }) as HTMLSelectElement
      ).value,
    ).toBe("50");
    fireEvent.click(within(compaction).getByRole("button", { name: "Save changes" }));

    const alert = await within(compaction).findByRole("alert");
    expect(alert.textContent).toContain("Settings changed elsewhere");
    expect(
      store.state.entries.find((entry) => entry.key === "compaction.thresholdPercent"),
    ).toEqual(thresholdEntry(80));
  });

  test("an outside change to a nested setting reaches a section with nothing staged", async () => {
    const store = fakeStore(withDefaults(COMPACTION_SECTION, []));
    const view = render(<ContextSettings client={appClient(store)} scope={{ layer: "global" }} />);
    const section = await openSection(view, COMPACTION_SECTION);
    const midTurn = () =>
      within(section).getByRole("checkbox", { name: "Mid-Turn Compaction" }) as HTMLInputElement;
    expect(midTurn().checked).toBe(false);

    await act(async () => {
      outsideChange(store, MID_TURN_OUTSIDE, "compaction");
    });

    await waitFor(() => expect(midTurn().checked).toBe(true));
  });

  test("an outside change to a staged key shows the conflict at once and keeps the edit", async () => {
    const store = fakeStore(withDefaults(COMPACTION_SECTION, []));
    const view = render(<ContextSettings client={appClient(store)} scope={{ layer: "global" }} />);
    const section = await openSection(view, COMPACTION_SECTION);
    fireEvent.change(within(section).getByRole("combobox", { name: "Compaction Threshold" }), {
      target: { value: "50" },
    });

    await act(async () => {
      outsideChange(store, thresholdEntry(80), "compaction");
    });

    const alert = await within(section).findByRole("alert");
    expect(alert.textContent).toContain("Settings changed elsewhere");
    expect(
      (within(section).getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (within(section).getByRole("combobox", { name: "Compaction Threshold" }) as HTMLSelectElement)
        .value,
    ).toBe("50");
  });

  test("an outside change to a key nobody staged does not conflict a section with staged edits", async () => {
    const store = fakeStore(withDefaults(COMPACTION_SECTION, []));
    const view = render(<ContextSettings client={appClient(store)} scope={{ layer: "global" }} />);
    const compaction = await openSection(view, COMPACTION_SECTION);
    fireEvent.click(within(compaction).getByRole("checkbox", { name: "Auto-Compact" }));

    await act(async () => {
      outsideChange(store, TTSR_OUTSIDE, "ttsr.enabled");
    });
    await settle();

    expect(within(compaction).queryByRole("alert")).toBeNull();
    expect(
      (within(compaction).getByRole("checkbox", { name: "Auto-Compact" }) as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect(
      (within(compaction).getByRole("button", { name: "Save changes" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });
});

describe("a save that finds a conflict", () => {
  test("locks the section until the person keeps or reloads the edit", async () => {
    const store = fakeStore(withDefaults(COMPACTION_SECTION, []));
    const section = await renderSection(store, COMPACTION_SECTION);
    fireEvent.click(within(section).getByRole("checkbox", { name: "Auto-Compact" }));
    silentOutsideChange(store, AUTO_COMPACT_OUTSIDE);
    fireEvent.click(within(section).getByRole("button", { name: "Save changes" }));

    const alert = await within(section).findByRole("alert");
    expect(alert.textContent).toContain("Settings changed elsewhere");
    expect(
      (within(section).getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (within(section).getByRole("checkbox", { name: "Auto-Compact" }) as HTMLInputElement)
        .disabled,
    ).toBe(true);

    fireEvent.click(within(alert).getByRole("button", { name: "Keep my edits" }));
    expect(
      (within(section).getByRole("checkbox", { name: "Auto-Compact" }) as HTMLInputElement).checked,
    ).toBe(true);
    fireEvent.click(within(section).getByRole("button", { name: "Save changes" }));
    await within(section).findByText("Applied");
    expect(within(section).queryByRole("alert")).toBeNull();
  });

  test("Reload latest drops the staged edit and shows what omp has stored", async () => {
    const store = fakeStore(withDefaults(COMPACTION_SECTION, []));
    const section = await renderSection(store, COMPACTION_SECTION);
    fireEvent.click(within(section).getByRole("checkbox", { name: "Auto-Compact" }));
    silentOutsideChange(store, AUTO_COMPACT_OUTSIDE);
    fireEvent.click(within(section).getByRole("button", { name: "Save changes" }));

    const alert = await within(section).findByRole("alert");
    fireEvent.click(within(alert).getByRole("button", { name: "Reload latest" }));

    expect(
      (within(section).getByRole("checkbox", { name: "Auto-Compact" }) as HTMLInputElement).checked,
    ).toBe(true);
    expect(within(section).queryByRole("alert")).toBeNull();
    expect(
      (within(section).getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  test("Cancel puts back the stored values", async () => {
    const store = fakeStore(withDefaults(COMPACTION_SECTION, []));
    const section = await renderSection(store, COMPACTION_SECTION);
    fireEvent.click(within(section).getByRole("checkbox", { name: "Auto-Compact" }));
    fireEvent.click(within(section).getByRole("button", { name: "Cancel" }));

    expect(
      (within(section).getByRole("checkbox", { name: "Auto-Compact" }) as HTMLInputElement).checked,
    ).toBe(false);
    expect(
      (within(section).getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe("loading and load failures are shown once for the page", () => {
  test("one error and one Retry for the whole page, and Retry loads every section", async () => {
    const store = allSectionsStore();
    store.state.failLists = new AppFailure({
      code: "internal",
      message: "The settings file could not be read.",
      retryable: true,
    });
    const view = render(<ContextSettings client={appClient(store)} scope={{ layer: "global" }} />);

    const alert = await view.findByRole("alert");
    expect(alert.textContent).toContain("The settings file could not be read.");
    expect(view.getAllByRole("button", { name: "Retry" })).toHaveLength(1);

    store.state.failLists = undefined;
    fireEvent.click(view.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(view.getAllByRole("tab")).toHaveLength(4));
    expect(view.queryByRole("alert")).toBeNull();
  });

  test("while the sections load, the page says so once", async () => {
    const store = allSectionsStore();
    let release: () => void = () => undefined;
    store.state.holdLists = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    const view = render(<ContextSettings client={appClient(store)} scope={{ layer: "global" }} />);

    expect(view.getAllByText("Loading context settings…")).toHaveLength(1);
    release();
    await waitFor(() => expect(view.getAllByRole("tab")).toHaveLength(4));
    expect(view.queryByText("Loading context settings…")).toBeNull();
  });
});

describe("a failed save", () => {
  test("shows its message below the Save button, and the section has one Save button", async () => {
    const store = fakeStore(withDefaults(COMPACTION_SECTION, []));
    store.state.failNextWrite = new AppFailure({
      code: "internal",
      message: "Disk is full.",
      retryable: true,
    });
    const section = await renderSection(store, COMPACTION_SECTION);
    fireEvent.click(within(section).getByRole("checkbox", { name: "Auto-Compact" }));
    fireEvent.click(within(section).getByRole("button", { name: "Save changes" }));

    const alert = await within(section).findByRole("alert");
    const save = within(section).getByRole("button", { name: "Save changes" });
    expect(save.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(within(section).getAllByRole("button", { name: "Save changes" })).toHaveLength(1);
  });
});

describe("stored values and menus", () => {
  test("a stored value omp ignores does not block Save, and its row says omp uses the default", async () => {
    const store = fakeStore(
      withDefaults(COMPACTION_SECTION, [
        {
          key: "compaction.thresholdPercent",
          secret: false,
          value: "auto",
          source: "global",
          overrides: ["default"],
        },
      ]),
    );
    const section = await renderSection(store, COMPACTION_SECTION);
    fireEvent.click(within(section).getByRole("checkbox", { name: "Auto-Compact" }));

    expect(
      (within(section).getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(
      within(section).getByText(/omp ignores this saved value and uses the default\./),
    ).toBeTruthy();
    expect(within(section).queryByRole("alert")).toBeNull();
  });

  test("a saved value stays on the menu after another value is picked", async () => {
    const store = fakeStore(withDefaults(COMPACTION_SECTION, [thresholdEntry(65)]));
    const section = await renderSection(store, COMPACTION_SECTION);
    const threshold = within(section).getByRole("combobox", {
      name: "Compaction Threshold",
    }) as HTMLSelectElement;
    fireEvent.change(threshold, { target: { value: "70" } });

    expect(threshold.value).toBe("70");
    expect(within(threshold).getByRole("option", { name: "65 (current)" })).toBeTruthy();
  });

  test("a menu choice is saved as a number", async () => {
    const store = fakeStore(withDefaults(COMPACTION_SECTION, []));
    const section = await renderSection(store, COMPACTION_SECTION);
    fireEvent.change(within(section).getByRole("combobox", { name: "Compaction Threshold" }), {
      target: { value: "50" },
    });
    fireEvent.click(within(section).getByRole("button", { name: "Save changes" }));
    await within(section).findByText("Applied");

    expect(store.state.writes.at(-1)?.value).toEqual({ secret: false, value: 50 });
  });
});

describe("the compaction method order and the list fields", () => {
  test("each list field is drawn inside its section's card, above Save changes and Cancel", async () => {
    const store = allSectionsStore();
    const view = render(<ContextSettings client={appClient(store)} scope={{ layer: "global" }} />);
    const lists = [
      { id: GENERAL_SECTION, title: "General", field: "Additional Workspace Directories" },
      { id: COMPACTION_SECTION, title: "Compaction", field: "Compaction Method Order" },
      { id: "P7.contextRulesTtsr", title: "Rules (TTSR)", field: "Disabled Rules" },
    ];
    for (const { id, title, field } of lists) {
      const section = await openSection(view, id);
      const card = within(section).getByRole("region", { name: title });
      const listField = within(card).getByText(field, { exact: true });
      const save = within(card).getByRole("button", { name: "Save changes" });
      const cancel = within(card).getByRole("button", { name: "Cancel" });
      expect(
        listField.compareDocumentPosition(save) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(
        listField.compareDocumentPosition(cancel) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
  });

  test("Move down reorders the methods and saves the new order", async () => {
    const store = fakeStore(withDefaults(COMPACTION_SECTION, []));
    const section = await renderSection(store, COMPACTION_SECTION);
    fireEvent.click(
      within(section).getAllByRole("button", { name: /^Move down, / })[0] as HTMLElement,
    );
    fireEvent.click(within(section).getByRole("button", { name: "Save changes" }));
    await within(section).findByText("Applied");

    expect(store.state.writes.at(-1)?.value).toEqual({
      secret: false,
      value: ["snapcompact", "remote", "handoff", "shake", "soft"],
    });
  });

  test("Remove drops a method", async () => {
    const store = fakeStore(withDefaults(COMPACTION_SECTION, []));
    const section = await renderSection(store, COMPACTION_SECTION);
    fireEvent.click(within(section).getByRole("button", { name: "Remove Snapcompact" }));
    fireEvent.click(within(section).getByRole("button", { name: "Save changes" }));
    await within(section).findByText("Applied");

    expect(store.state.writes.at(-1)?.value).toEqual({
      secret: false,
      value: ["remote", "handoff", "shake", "soft"],
    });
  });

  test("Use omp's default order restores the default after a removal", async () => {
    const store = fakeStore(withDefaults(COMPACTION_SECTION, []));
    const section = await renderSection(store, COMPACTION_SECTION);
    fireEvent.click(within(section).getByRole("button", { name: "Remove Snapcompact" }));
    fireEvent.click(within(section).getByRole("button", { name: "Use omp's default order" }));
    fireEvent.click(within(section).getByRole("button", { name: "Save changes" }));
    await within(section).findByText("Applied");

    expect(store.state.writes.at(-1)?.value).toEqual({
      secret: false,
      value: ["remote", "snapcompact", "handoff", "shake", "soft"],
    });
  });

  test("choosing a method that is already in the order swaps the two", async () => {
    const store = fakeStore(withDefaults(COMPACTION_SECTION, []));
    const section = await renderSection(store, COMPACTION_SECTION);
    fireEvent.change(within(section).getByRole("combobox", { name: "Method 1" }), {
      target: { value: "handoff" },
    });
    fireEvent.click(within(section).getByRole("button", { name: "Save changes" }));
    await within(section).findByText("Applied");

    expect(store.state.writes.at(-1)?.value).toEqual({
      secret: false,
      value: ["handoff", "snapcompact", "remote", "shake", "soft"],
    });
  });

  test("the list fields ignore blank lines and spaces, and say so", async () => {
    const store = fakeStore(withDefaults(GENERAL_SECTION, []));
    const section = await renderSection(store, GENERAL_SECTION);
    fireEvent.change(
      within(section).getByRole("textbox", { name: "Additional Workspace Directories" }),
      { target: { value: "one\n\n  two words  \n" } },
    );

    expect(within(section).getByText("One entry per line. Blank lines are ignored.")).toBeTruthy();
    fireEvent.click(within(section).getByRole("button", { name: "Save changes" }));
    await within(section).findByText("Applied");
    expect(store.state.writes.at(-1)?.value).toEqual({
      secret: false,
      value: ["one", "two words"],
    });
  });
});

describe("a save that writes some settings and then fails", () => {
  test("names the setting that was not saved, keeps it staged, and saves it on the next save", async () => {
    const store = fakeStore(withDefaults(GENERAL_SECTION, []));
    const section = await renderSection(store, GENERAL_SECTION);
    fireEvent.click(within(section).getByRole("checkbox", { name: "Auto-Promote Context" }));
    fireEvent.click(within(section).getByRole("checkbox", { name: "Extended Context" }));
    store.state.failKeys.add("extendedContext");

    fireEvent.click(within(section).getByRole("button", { name: "Save changes" }));

    const alert = await within(section).findByRole("alert");
    expect(alert.textContent).toContain("Not saved: Extended Context.");
    expect(alert.textContent).toContain("Cannot write configuration: permission denied.");
    expect(
      (within(section).getByRole("checkbox", { name: "Auto-Promote Context" }) as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect(
      (within(section).getByRole("checkbox", { name: "Extended Context" }) as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect(
      (within(section).getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled,
    ).toBe(false);

    store.state.failKeys.clear();
    fireEvent.click(within(section).getByRole("button", { name: "Save changes" }));

    await within(section).findByText("Applied");
    expect(within(section).queryByRole("alert")).toBeNull();
    expect(store.state.writes.map((write) => write.key)).toEqual([
      "contextPromotion.enabled",
      "extendedContext",
      "extendedContext",
    ]);
  });
});
