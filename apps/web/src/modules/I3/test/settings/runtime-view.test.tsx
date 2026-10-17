import {
  AppFailure,
  type ConfigEntry,
  type ConfigWriteArgs,
  type ConfigWriteResult,
  type FolderPath,
  type JsonValue,
} from "@omp-app/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { SettingsRuntime } from "../../../S1/runtime";
import type { ConfigChangeSource, ConfigStoreClient } from "../../../S1/settings-kit";
import {
  type MemorySettingsRuntimes,
  useMemorySettingsController,
} from "../../settings/controller";
import { MEMORY_SETTINGS_SECTIONS } from "../../settings/descriptors";
import { MemorySettingsView } from "../../settings/view";

type FakeState = {
  revision: number;
  entries: ConfigEntry[];
  failNextList: boolean;
  failNextWrite: boolean;
  writes: ConfigWriteArgs[];
};
const activeRuntimes: SettingsRuntime[] = [];
afterEach(() => {
  cleanup();
  for (const runtime of activeRuntimes.splice(0)) runtime.dispose();
});

function defaultEntry(
  control: (typeof MEMORY_SETTINGS_SECTIONS)[number]["controls"][number],
): ConfigEntry {
  if (control.secret)
    return { key: control.key, secret: true, isSet: true, source: "global", overrides: [] };
  if (control.kind === "boolean")
    return { key: control.key, secret: false, value: false, source: "global", overrides: [] };
  if (control.kind === "enum")
    return {
      key: control.key,
      secret: false,
      value: String(control.options?.[0]?.value ?? ""),
      source: "global",
      overrides: [],
    };
  const value = control.key === "hindsight.bankId" ? "old-bank" : "";
  return { key: control.key, secret: false, value, source: "global", overrides: [] };
}

function runtimeFor(
  descriptor: (typeof MEMORY_SETTINGS_SECTIONS)[number],
  state: FakeState,
): SettingsRuntime {
  const client: ConfigStoreClient = {
    read: async ({ key }) => {
      const entry = state.entries.find((candidate) => candidate.key === key);
      if (!entry) throw new Error(`Missing setting ${key}`);
      return entry;
    },
    list: async () => {
      if (state.failNextList) {
        state.failNextList = false;
        throw new AppFailure({
          code: "internal",
          message: "Temporary settings read failure",
          retryable: true,
        });
      }
      return { entries: [...state.entries], revision: `revision-${state.revision}` };
    },
    write: async (args): Promise<ConfigWriteResult> => {
      state.writes.push(args as ConfigWriteArgs);
      if (state.failNextWrite) {
        state.failNextWrite = false;
        throw new AppFailure({
          code: "internal",
          message: "Temporary settings save failure",
          retryable: true,
        });
      }
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
            value: args.value.value as JsonValue,
            source: args.layer,
            overrides: [],
          };
      const index = state.entries.findIndex((candidate) => candidate.key === args.key);
      if (index < 0) state.entries.push(entry);
      else state.entries[index] = entry;
      state.revision += 1;
      return {
        key: args.key,
        layer: args.layer,
        folder: args.folder as FolderPath | null,
        revision: `revision-${state.revision}`,
        previousRevision: args.expectedRevision,
        entry,
      };
    },
  };
  const changes: ConfigChangeSource = { subscribe: () => () => undefined };
  const runtime = new SettingsRuntime(client, changes, {
    descriptor,
    folder: null,
    layer: "global",
  });
  activeRuntimes.push(runtime);
  return runtime;
}

function makeHarness(
  options: {
    readonly failLoad?: string;
    readonly failSave?: string;
    readonly unsetSecrets?: readonly string[];
  } = {},
) {
  const states = new Map<string, FakeState>();
  const entries = MEMORY_SETTINGS_SECTIONS.flatMap((section) => section.controls.map(defaultEntry));
  const runtimes = Object.fromEntries(
    MEMORY_SETTINGS_SECTIONS.map((descriptor) => {
      const state: FakeState = {
        revision: 1,
        entries: entries.map((entry) =>
          entry.secret && options.unsetSecrets?.includes(entry.key) && entry.isSet
            ? { ...entry, isSet: false }
            : { ...entry },
        ),
        failNextList: options.failLoad === descriptor.id,
        failNextWrite: options.failSave === descriptor.id,
        writes: [],
      };
      states.set(descriptor.id, state);
      return [descriptor.id, runtimeFor(descriptor, state)];
    }),
  ) as MemorySettingsRuntimes;
  render(<RuntimeSettings runtimes={runtimes} />);
  return { runtimes, states };
}

function RuntimeSettings({ runtimes }: { readonly runtimes: MemorySettingsRuntimes }) {
  const controller = useMemorySettingsController(runtimes);
  return <MemorySettingsView model={controller.model} actions={controller.actions} />;
}

describe("I3 memory settings through SettingsRuntime", () => {
  test("failed load is shown, Retry succeeds, and Cancel discards staged edits", async () => {
    const { states } = makeHarness({ failLoad: "I3.memoryGeneral" });
    expect(await screen.findByText("Temporary settings read failure")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Memory Backend")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Hindsight" }));
    const bank = await screen.findByLabelText("Bank ID");
    fireEvent.change(bank, { target: { value: "discard-me" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect((screen.getByLabelText("Bank ID") as HTMLInputElement).value).toBe("old-bank");
    expect(states.get("I3.memoryHindsight")?.writes).toHaveLength(0);
  });

  test("failed save stays visible and a retry saves the staged edit", async () => {
    const { states } = makeHarness({ failSave: "I3.memoryHindsight" });
    fireEvent.click(await screen.findByRole("tab", { name: "Hindsight" }));
    fireEvent.change(await screen.findByLabelText("Bank ID"), { target: { value: "new-bank" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Temporary settings save failure")).toBeTruthy();
    expect(screen.getByText(/Not saved: Bank ID\./)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => {
      const bankEntry = states
        .get("I3.memoryHindsight")
        ?.entries.find((entry) => entry.key === "hindsight.bankId");
      expect(bankEntry?.secret === false ? bankEntry.value : undefined).toBe("new-bank");
    });
    expect(screen.queryByText(/Not saved: Bank ID\./)).toBeNull();
  });

  test("credential Set and Replace require a non-empty typed value; Cancel stages nothing", async () => {
    const { runtimes, states } = makeHarness();
    fireEvent.click(await screen.findByRole("tab", { name: "Hindsight" }));
    fireEvent.click(screen.getByRole("button", { name: "Replace…" }));
    const first = screen.getByLabelText("API Token") as HTMLInputElement;
    expect(first.value).toBe("");
    expect(
      (screen.getByRole("button", { name: "Save credential" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.change(first, { target: { value: "first-secret" } });
    fireEvent.click(screen.getByRole("tab", { name: "Mnemopi" }));
    expect(screen.queryByTestId("secret-editor")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Hindsight" }));
    expect(screen.queryByTestId("secret-editor")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Mnemopi" }));

    const replaceButtons = screen.getAllByRole("button", { name: "Replace…" });
    const firstReplace = replaceButtons[0];
    if (!firstReplace) throw new Error("Missing the embedding credential Replace button");
    fireEvent.click(firstReplace);
    const second = screen.getByLabelText("Embedding API Key") as HTMLInputElement;
    expect(second.value).toBe("");
    expect(
      (screen.getByRole("button", { name: "Save credential" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(
      within(screen.getByTestId("secret-editor")).getByRole("button", { name: "Cancel" }),
    );
    expect(screen.queryByTestId("secret-editor")).toBeNull();
    const mnemopiRuntime = runtimes["I3.memoryMnemopi"];
    if (!mnemopiRuntime) throw new Error("Missing Mnemopi runtime");
    expect(mnemopiRuntime.getSnapshot().staged?.edits).toEqual({});
    expect(states.get("I3.memoryMnemopi")?.writes).toHaveLength(0);
  });

  test("switching secret keys in Mnemopi clears text and saves only the selected key", async () => {
    const { states } = makeHarness();
    fireEvent.click(await screen.findByRole("tab", { name: "Mnemopi" }));
    const replaceButtons = screen.getAllByRole("button", { name: "Replace…" });
    const embeddingReplace = replaceButtons[0];
    if (!embeddingReplace) throw new Error("Missing embedding key Replace button");
    fireEvent.click(embeddingReplace);
    fireEvent.change(screen.getByLabelText("Embedding API Key"), {
      target: { value: "embedding-secret" },
    });

    const llmReplaceButtons = screen.getAllByRole("button", { name: "Replace…" });
    const llmReplace = llmReplaceButtons[1];
    if (!llmReplace) throw new Error("Missing language-model key Replace button");
    fireEvent.click(llmReplace);
    const llmField = screen.getByLabelText("Language Model API Key") as HTMLInputElement;
    expect(llmField.value).toBe("");
    fireEvent.change(llmField, { target: { value: "llm-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Save credential" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(states.get("I3.memoryMnemopi")?.writes).toHaveLength(1);
    });
    expect(states.get("I3.memoryMnemopi")?.writes[0]).toMatchObject({
      key: "mnemopi.llmApiKey",
      value: { secret: true, action: "set", value: "llm-secret" },
    });
  });

  test("renders shared applied and restart-required status labels", async () => {
    const { runtimes } = makeHarness();
    fireEvent.click(await screen.findByRole("tab", { name: "Hindsight" }));
    fireEvent.change(await screen.findByLabelText("Bank ID"), {
      target: { value: "saved-bank" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Applied")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Mnemopi" }));
    await screen.findByText("Embedding Variant");
    const mnemopiRuntime = runtimes["I3.memoryMnemopi"];
    if (!mnemopiRuntime) throw new Error("Missing Mnemopi runtime");
    fireEvent.change(screen.getByLabelText("Embedding Variant"), {
      target: { value: "multilingual" },
    });
    expect(mnemopiRuntime.getSnapshot().staged?.edits).toEqual({
      "mnemopi.embeddingVariant": { secret: false, value: "multilingual" },
    });
    await act(async () => {
      await mnemopiRuntime.save();
    });
    expect(mnemopiRuntime.getSnapshot().applyStatus).toBe("restart-required");
    expect(screen.getByText("Restart required")).toBeTruthy();
  });
  test("Replace stages and saves a non-empty credential value only after typing", async () => {
    const { states } = makeHarness();
    fireEvent.click(await screen.findByRole("tab", { name: "Hindsight" }));
    fireEvent.click(screen.getByRole("button", { name: "Replace…" }));
    fireEvent.change(screen.getByLabelText("API Token"), {
      target: { value: "replacement-token" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save credential" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => {
      const token = states
        .get("I3.memoryHindsight")
        ?.entries.find((entry) => entry.key === "hindsight.apiToken");
      expect(token?.secret === true ? token.isSet : false).toBe(true);
    });
    expect(states.get("I3.memoryHindsight")?.writes[0]?.value).toEqual({
      secret: true,
      action: "set",
      value: "replacement-token",
    });
  });
  test("Set on one Mnemopi key cannot stage its value for the next key", async () => {
    const { states } = makeHarness({
      unsetSecrets: ["mnemopi.embeddingApiKey", "mnemopi.llmApiKey"],
    });
    fireEvent.click(await screen.findByRole("tab", { name: "Mnemopi" }));
    const setButtons = screen.getAllByRole("button", { name: "Set…" });
    const embeddingSet = setButtons[0];
    if (!embeddingSet) throw new Error("Missing embedding key Set button");
    fireEvent.click(embeddingSet);
    const embeddingField = screen.getByLabelText("Embedding API Key") as HTMLInputElement;
    expect(embeddingField.value).toBe("");
    fireEvent.change(embeddingField, { target: { value: "embedding-secret" } });

    const llmSet = screen.getAllByRole("button", { name: "Set…" })[1];
    if (!llmSet) throw new Error("Missing language model key Set button");
    fireEvent.click(llmSet);
    const llmField = screen.getByLabelText("Language Model API Key") as HTMLInputElement;
    expect(llmField.value).toBe("");
    fireEvent.change(llmField, { target: { value: "llm-secret" } });
    fireEvent.click(screen.getByRole("button", { name: "Save credential" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(states.get("I3.memoryMnemopi")?.writes).toHaveLength(1);
    });
    expect(states.get("I3.memoryMnemopi")?.writes[0]).toMatchObject({
      key: "mnemopi.llmApiKey",
      value: { secret: true, action: "set", value: "llm-secret" },
    });
  });
});
