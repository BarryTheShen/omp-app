import { AppFailure, CapabilityStatus, type OmpWire, type Revision } from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { ProviderSignIn } from "@/modules/D3/contract";
import type {
  ModelDescriptor,
  ModelRef,
  ModelSettings,
  ModelSettingsPort,
  ModelSettingsSnapshot,
  ThinkingLevel,
} from "../contract";
import { ModelCatalogModel, type ModelCatalogSource } from "../model/catalog";
import { RecentModels, type RecentModelsPort } from "../model/recents";
import { ModelRoleStore, PRESET_NAME_RULE } from "../model/roles";
import { ModelHubController } from "./model-hub-controller";
import { ModelHubPanel } from "./model-hub-panel";

afterEach(() => cleanup());

const CAPABILITIES = {
  "omp.cmd.set_model": CapabilityStatus.parse({ state: "available", via: "rpc" }),
  "host.config": CapabilityStatus.parse({ state: "available", via: "host" }),
};

/** Words a person must never read in the dialog: internal layers, the revision check and file keys. */
const INTERNAL_TERMS =
  /ConfigStore|\bCAS\b|role map|A1\.4|config layer|\bRPC\b|revision|modelRoles|appDataDir/;

type Efforts = NonNullable<OmpWire.ModelInfo["thinking"]>["efforts"];

function rawModel(
  provider: string,
  id: string,
  name: string,
  options: { readonly reasoning?: boolean; readonly efforts?: readonly string[] } = {},
): OmpWire.ModelInfo {
  return {
    provider,
    id,
    name,
    api: "chat-completions",
    baseUrl: "https://provider.invalid/v1",
    reasoning: options.reasoning ?? true,
    input: ["text"],
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
    ...(options.efforts
      ? { thinking: { mode: "effort", efforts: [...options.efforts] as Efforts } }
      : {}),
  };
}

const DEFAULT_SETTINGS: ModelSettings = {
  enabledModels: [],
  enabledProviders: [],
  disabledProviders: [],
  modelRoleStorage: "global",
  modelRoles: {},
  modelPresets: {},
  modelTags: {},
  modelProviderOrder: [],
  cycleOrder: ["smol", "default", "slow"],
};

/**
 * One saved file, as the ConfigStore keeps it: its revision covers every layer, so a write to the app's
 * recent models moves the revision the role store holds (the review's first major). Roles and recents
 * check the revision they were read at, and a stale write fails as a conflict.
 */
interface SavedFile {
  settings: ModelSettings;
  recents: string[];
  revision: number;
}

function savedFile(initial: Partial<ModelSettings>): SavedFile {
  return { settings: { ...DEFAULT_SETTINGS, ...initial }, recents: [], revision: 1 };
}

function rev(file: SavedFile): Revision {
  return `file-${file.revision}` as Revision;
}

function staleWrite(): AppFailure {
  return new AppFailure({
    code: "conflict",
    message: "Cannot write configuration: the file changed.",
    retryable: true,
  });
}

function rolesPort(file: SavedFile): ModelSettingsPort {
  const snapshot = (): ModelSettingsSnapshot => ({
    settings: structuredClone(file.settings),
    layer: "global",
    revision: rev(file),
    error: null,
  });
  return {
    getSnapshot: snapshot,
    read: async () => snapshot(),
    write: async (next, expectedRevision) => {
      if (expectedRevision !== rev(file)) throw staleWrite();
      file.settings = structuredClone(next);
      file.revision += 1;
      return snapshot();
    },
    subscribe: () => () => undefined,
  };
}

function recentsPort(file: SavedFile, failWith?: string): RecentModelsPort {
  return {
    read: async () => ({ keys: [...file.recents], revision: rev(file) }),
    write: async (keys, expectedRevision) => {
      if (failWith !== undefined) {
        throw new AppFailure({ code: "internal", message: failWith, retryable: true });
      }
      if (expectedRevision !== rev(file)) throw staleWrite();
      file.recents = [...keys];
      file.revision += 1;
      return rev(file);
    },
  };
}

interface HarnessOptions {
  readonly models: readonly OmpWire.ModelInfo[];
  readonly signIns?: Readonly<Record<string, ProviderSignIn>>;
  readonly current?: ModelRef | null;
  readonly file?: Partial<ModelSettings>;
  readonly recentsFailure?: string;
  /** When given, the Roles view lists these project roles instead of the saved ones. */
  readonly projectRoles?: Partial<ModelSettings>;
  readonly capabilities?: typeof CAPABILITIES;
  /** A session thinking level the app cannot set (the callback fails) when true. */
  readonly thinkingFails?: boolean;
}

interface Harness {
  readonly hub: ModelHubController;
  readonly file: SavedFile;
  readonly roles: ModelRoleStore;
  /** Every model the session was switched to, in order. */
  readonly setCalls: ModelRef[];
  /** Every thinking level the session was set to, in order. */
  readonly thinkingCalls: ThinkingLevel[];
}

async function harness({
  models,
  signIns = {},
  current = null,
  file: fileSettings = {},
  recentsFailure,
  projectRoles,
  capabilities = CAPABILITIES,
  thinkingFails = false,
}: HarnessOptions): Promise<Harness> {
  const setCalls: ModelRef[] = [];
  const thinkingCalls: ThinkingLevel[] = [];
  const source: ModelCatalogSource = {
    readSignIns: async () => new Map(Object.entries(signIns)),
    getAvailableModels: async () => models,
    setModel: async (ref) => {
      const found = models.find(
        (model) => model.provider === ref.provider && model.id === ref.modelId,
      );
      if (!found) throw new Error(`Model not found: ${ref.provider}/${ref.modelId}`);
      setCalls.push(ref);
      return found;
    },
  };
  const catalog = new ModelCatalogModel({
    source,
    capabilities,
    liveState: { getSnapshot: () => ({ model: current }), subscribe: () => () => undefined },
  });
  const file = savedFile(fileSettings);
  const projectFile = savedFile(projectRoles ?? {});
  const recentStore = new RecentModels(recentsPort(file, recentsFailure));
  const saved = new ModelRoleStore(rolesPort(file));
  const shown = projectRoles === undefined ? saved : new ModelRoleStore(rolesPort(projectFile));
  const hub = new ModelHubController({
    catalog,
    recents: recentStore,
    capabilities: () => capabilities,
    setSessionThinking: async (level) => {
      if (thinkingFails) throw new Error("The current model does not support thinking levels.");
      thinkingCalls.push(level);
    },
  });
  await catalog.refresh();
  await recentStore.read();
  await saved.read();
  if (shown !== saved) await shown.read();
  hub.attachRoles({ saved, shown });
  return { hub, file, roles: saved, setCalls, thinkingCalls };
}

/** The listed model with this key, as the dialog holds it. */
function listed(h: Harness, key: string): ModelDescriptor {
  const row = h.hub
    .getSnapshot()
    .sections.flatMap((section) => section.rows)
    .find((candidate) => candidate.key === key);
  if (!row) throw new Error(`${key} is not listed`);
  return row.model;
}

describe("ModelHubController", () => {
  test("lists Recent first, then providers signed in first, and marks the session's model", async () => {
    const h = await harness({
      models: [
        rawModel("local", "llama", "Llama"),
        rawModel("anthropic", "claude-a", "Claude A"),
        rawModel("anthropic", "claude-c", "Claude C"),
        rawModel("openai", "gpt-b", "GPT B"),
        rawModel("openai", "gpt-d", "GPT D"),
      ],
      signIns: { local: "login", anthropic: "api-key", openai: "none" },
      current: { provider: "openai", modelId: "gpt-b" },
      file: { modelRoles: { smol: "local/llama" } },
    });
    const view = h.hub.getSnapshot();
    expect(view.sections.map((section) => section.id)).toEqual([
      "recent",
      "provider:anthropic",
      "provider:openai",
    ]);
    expect(view.sections[0]?.rows.map((row) => row.key)).toEqual(["local/llama", "openai/gpt-b"]);
    expect(view.sections[0]?.rows[0]?.roles).toEqual(["Fast"]);
    expect(view.sections[0]?.rows[1]?.current).toBe(true);
    expect(view.sections[1]?.rows.map((row) => row.key)).toEqual([
      "anthropic/claude-a",
      "anthropic/claude-c",
    ]);
    expect(view.sections[2]?.rows.map((row) => row.key)).toEqual(["openai/gpt-d"]);
    expect(view.providers).toEqual([
      { provider: "local", count: 1 },
      { provider: "anthropic", count: 2 },
      { provider: "openai", count: 2 },
    ]);
    expect(view.active).toEqual({ key: "openai/gpt-b", label: "GPT B" });
    h.hub.dispose();
  });

  test("choosing the Default role after a model was picked for the session saves it, with no conflict", async () => {
    // The review's first major: the recent model write moved the file's revision, so the role write used to fail.
    const h = await harness({
      models: [
        rawModel("anthropic", "claude-a", "Claude A"),
        rawModel("anthropic", "claude-c", "Claude C"),
      ],
    });
    await h.hub.setSessionModel(listed(h, "anthropic/claude-a"));
    h.hub.startRoleAssignment("default");
    await h.hub.chooseModel(listed(h, "anthropic/claude-c"));
    const view = h.hub.getSnapshot();
    expect(view.notice).toEqual({ tone: "status", message: "Default now uses Claude C." });
    expect(h.file.settings.modelRoles).toEqual({ default: "anthropic/claude-c" });
    expect(h.setCalls.map((ref) => ref.modelId)).toEqual(["claude-a", "claude-c"]);
    expect(view.roles.status).toBe("ready");
    h.hub.dispose();
  });

  test("a role keeps its thinking level when the new model offers it, and drops it when it does not", async () => {
    const h = await harness({
      models: [
        rawModel("anthropic", "claude-a", "Claude A", { efforts: ["low", "high"] }),
        rawModel("anthropic", "claude-c", "Claude C", { efforts: ["low"] }),
        rawModel("anthropic", "claude-d", "Claude D", { reasoning: false }),
      ],
      file: { modelRoles: { smol: "anthropic/claude-c:low" } },
    });
    h.hub.startRoleAssignment("smol");
    await h.hub.chooseModel(listed(h, "anthropic/claude-a"));
    expect(h.file.settings.modelRoles).toEqual({ smol: "anthropic/claude-a:low" });
    h.hub.startRoleAssignment("smol");
    await h.hub.chooseModel(listed(h, "anthropic/claude-a"));
    h.hub.startRoleAssignment("smol");
    await h.hub.chooseModel(listed(h, "anthropic/claude-d"));
    expect(h.file.settings.modelRoles).toEqual({ smol: "anthropic/claude-d" });
    h.hub.dispose();
  });

  test("a preset whose default model is missing is refused, and nothing is written", async () => {
    const h = await harness({
      models: [rawModel("anthropic", "claude-a", "Claude A")],
      file: {
        modelRoles: { default: "anthropic/claude-a" },
        modelPresets: {
          ghost: { modelRoles: { default: "fake/does-not-exist", smol: "anthropic/claude-a" } },
        },
      },
    });
    const before = structuredClone(h.file);
    await h.hub.switchPreset("ghost");
    expect(h.hub.getSnapshot().notice).toEqual({
      tone: "error",
      message:
        "Preset ghost was not applied: its default model fake/does-not-exist is not available.",
    });
    expect(h.file).toEqual(before);
    expect(h.setCalls).toEqual([]);
    h.hub.dispose();
  });

  test("a preset whose default is an alias or a pattern is refused, and nothing is written", async () => {
    const h = await harness({
      models: [rawModel("anthropic", "claude-a", "Claude A")],
      file: {
        modelPresets: {
          loose: { modelRoles: { default: "@smol" } },
          wild: { modelRoles: { default: "anthropic/*" } },
        },
      },
    });
    const before = structuredClone(h.file);
    await h.hub.switchPreset("loose");
    expect(h.hub.getSnapshot().notice?.message).toBe(
      "Preset loose was not applied: its default model @smol is a role or a pattern, not one model.",
    );
    await h.hub.switchPreset("wild");
    expect(h.hub.getSnapshot().notice?.message).toBe(
      "Preset wild was not applied: its default model anthropic/* is a role or a pattern, not one model.",
    );
    expect(h.file).toEqual(before);
    expect(h.setCalls).toEqual([]);
    h.hub.dispose();
  });

  test("switching a preset writes its roles, switches the session to its default, and sets its thinking level", async () => {
    const h = await harness({
      models: [
        rawModel("anthropic", "claude-a", "Claude A", { efforts: ["low", "high"] }),
        rawModel("anthropic", "claude-c", "Claude C", { efforts: ["low", "high"] }),
      ],
      file: {
        modelRoles: { default: "anthropic/claude-a" },
        modelPresets: {
          fast: {
            modelRoles: { default: "anthropic/claude-c", smol: "anthropic/claude-a" },
            defaultThinkingLevel: "low",
          },
        },
      },
    });
    await h.hub.switchPreset("fast");
    expect(h.hub.getSnapshot().notice).toEqual({
      tone: "status",
      message: "Switched to preset fast.",
    });
    expect(h.file.settings.modelRoles).toEqual({
      default: "anthropic/claude-c",
      smol: "anthropic/claude-a",
    });
    expect(h.setCalls.map((ref) => ref.modelId)).toEqual(["claude-c"]);
    expect(h.thinkingCalls).toEqual(["low"]);
    h.hub.dispose();
  });

  test("a preset thinking level the app cannot set is reported, and the switch still happens", async () => {
    const h = await harness({
      models: [rawModel("anthropic", "claude-a", "Claude A")],
      file: {
        modelPresets: {
          auto: { modelRoles: { default: "anthropic/claude-a" }, defaultThinkingLevel: "auto" },
        },
      },
    });
    await h.hub.switchPreset("auto");
    expect(h.hub.getSnapshot().notice?.message).toBe(
      "Switched to preset auto. The app can't set omp's automatic thinking level yet, so the session keeps its level.",
    );
    expect(h.setCalls).toHaveLength(1);
    h.hub.dispose();
  });

  test("a thinking level that fails to apply is said in words after the switch", async () => {
    const h = await harness({
      models: [rawModel("anthropic", "claude-a", "Claude A", { reasoning: false })],
      file: {
        modelPresets: {
          plain: { modelRoles: { default: "anthropic/claude-a" }, defaultThinkingLevel: "high" },
        },
      },
      thinkingFails: true,
    });
    await h.hub.switchPreset("plain");
    expect(h.hub.getSnapshot().notice).toEqual({
      tone: "status",
      message: "Switched to preset plain. The current model does not support thinking levels.",
    });
    h.hub.dispose();
  });

  test("a preset name omp would refuse is refused with the rule, and nothing is written", async () => {
    const h = await harness({ models: [rawModel("anthropic", "claude-a", "Claude A")] });
    const before = structuredClone(h.file);
    await h.hub.savePreset("My work setup");
    expect(h.hub.getSnapshot().notice).toEqual({ tone: "error", message: PRESET_NAME_RULE });
    expect(h.file).toEqual(before);
    h.hub.dispose();
  });

  test("clearing a role removes it, and the Roles view shows it unset", async () => {
    const h = await harness({
      models: [rawModel("anthropic", "claude-a", "Claude A")],
      file: { modelRoles: { smol: "anthropic/claude-a" } },
    });
    await h.hub.clearRole("smol");
    expect(h.file.settings.modelRoles).toEqual({});
    const view = h.hub.getSnapshot();
    expect(view.roles.rows.find((row) => row.id === "smol")?.assigned).toBeNull();
    expect(view.notice).toEqual({
      tone: "status",
      message: "Fast is cleared. omp picks a model for it.",
    });
    h.hub.dispose();
  });

  test("with roles kept per project, the dialog shows the project's roles and cannot change them yet", async () => {
    const h = await harness({
      models: [rawModel("anthropic", "claude-a", "Claude A")],
      file: { modelRoleStorage: "project" },
      projectRoles: { modelRoles: { smol: "anthropic/claude-a" } },
    });
    const reason =
      "Roles are saved for this project. This app can show them but can't change them yet.";
    expect(h.hub.getSnapshot().roles.changes).toEqual({ allowed: false, reason });
    expect(h.hub.getSnapshot().roles.rows.find((row) => row.id === "smol")?.assigned?.key).toBe(
      "anthropic/claude-a",
    );
    h.hub.startRoleAssignment("default");
    await h.hub.chooseModel(listed(h, "anthropic/claude-a"));
    expect(h.hub.getSnapshot().notice).toEqual({ tone: "error", message: reason });
    expect(h.setCalls).toEqual([]);
    h.hub.dispose();
  });

  test("without the capability to change omp's settings, roles are refused with the reason", async () => {
    const h = await harness({
      models: [rawModel("anthropic", "claude-a", "Claude A")],
      capabilities: {
        "omp.cmd.set_model": CapabilityStatus.parse({ state: "available", via: "rpc" }),
      } as typeof CAPABILITIES,
    });
    expect(h.hub.getSnapshot().roles.changes).toEqual({
      allowed: false,
      reason: "Capability is unavailable.",
    });
    h.hub.dispose();
  });

  test("roles that changed elsewhere are shown as a conflict, and this change writes nothing", async () => {
    const h = await harness({
      models: [rawModel("anthropic", "claude-a", "Claude A")],
      file: { modelRoles: { default: "anthropic/claude-a" } },
    });
    // Another window saved different roles after this dialog read them.
    h.file.settings = {
      ...h.file.settings,
      modelRoles: { default: "anthropic/claude-a", slow: "x/y" },
    };
    h.file.revision += 1;
    h.hub.startRoleAssignment("smol");
    await h.hub.chooseModel(listed(h, "anthropic/claude-a"));
    expect(h.hub.getSnapshot().notice?.tone).toBe("error");
    expect(h.hub.getSnapshot().roles.status).toBe("conflict");
    expect(h.file.settings.modelRoles).toEqual({ default: "anthropic/claude-a", slow: "x/y" });
    h.hub.dispose();
  });

  test("a model change omp refuses keeps the list and shows omp's words", async () => {
    const h = await harness({ models: [rawModel("anthropic", "claude-a", "Claude A")] });
    await h.hub.setSessionModel({
      ...listed(h, "anthropic/claude-a"),
      id: "missing",
      name: "Missing",
    });
    const view = h.hub.getSnapshot();
    expect(view.notice).toEqual({
      tone: "error",
      message: "Model not found: anthropic/missing",
    });
    expect(view.catalog.error).toBeNull();
    expect(view.sections.flatMap((section) => section.rows).map((row) => row.key)).toContain(
      "anthropic/claude-a",
    );
    h.hub.dispose();
  });

  test("a session model change is recorded as recent, and a list that cannot be saved says so", async () => {
    const h = await harness({
      models: [rawModel("anthropic", "claude-a", "Claude A"), rawModel("openai", "gpt-b", "GPT B")],
      recentsFailure: "The recent models file is locked.",
    });
    await h.hub.setSessionModel(listed(h, "openai/gpt-b"));
    expect(h.setCalls).toEqual([{ provider: "openai", modelId: "gpt-b" }]);
    const view = h.hub.getSnapshot();
    expect(view.recentError).toBe("The recent models file is locked.");
    expect(view.sections[0]?.id).toBe("recent");
    expect(view.sections[0]?.rows.map((row) => row.key)).toEqual(["openai/gpt-b"]);
    h.hub.dispose();
  });
});

describe("ModelHubPanel", () => {
  test("shows the lists, the search, Recent, the providers and each role's model in plain words", async () => {
    const h = await harness({
      models: [
        rawModel("anthropic", "claude-a", "Claude A"),
        rawModel("anthropic", "claude-c", "Claude C"),
        rawModel("openai", "gpt-b", "GPT B"),
      ],
      signIns: { anthropic: "api-key", openai: "none" },
      current: { provider: "openai", modelId: "gpt-b" },
      file: { modelRoles: { default: "anthropic/claude-a" } },
    });
    render(<ModelHubPanel controller={h.hub} />);
    expect(screen.getByRole("navigation", { name: "Model lists" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Search models" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Recent models" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "anthropic models" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Set Claude A as a role" })).toBeTruthy();
    expect(screen.getAllByText("Uses an API key").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: /^Roles/ }));
    expect(screen.getByRole("button", { name: "Choose a model for Default" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Saved presets" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Cycle order" })).toBeTruthy();
    expect(screen.getByText(PRESET_NAME_RULE)).toBeTruthy();
    expect(document.body.textContent ?? "").not.toMatch(INTERNAL_TERMS);
    h.hub.dispose();
  });

  test("an empty catalog says there are no models and how to get some", async () => {
    const h = await harness({ models: [] });
    render(<ModelHubPanel controller={h.hub} />);
    expect(screen.getByText("No models are available yet.")).toBeTruthy();
    expect(screen.getByText("Sign in to a provider in omp, then reopen this list.")).toBeTruthy();
    h.hub.dispose();
  });

  test("a failed model list shows the reason and a way to try again", async () => {
    const catalog = new ModelCatalogModel({
      source: {
        getAvailableModels: async () => {
          throw new Error("Model discovery is temporarily unavailable.");
        },
        setModel: async () => {
          throw new Error("unused");
        },
      },
      capabilities: CAPABILITIES,
    });
    const hub = new ModelHubController({
      catalog,
      recents: new RecentModels(recentsPort(savedFile({}))),
      capabilities: () => CAPABILITIES,
    });
    await catalog.refresh().catch(() => undefined);
    render(<ModelHubPanel controller={hub} />);
    expect(screen.getByText("The models could not be loaded.")).toBeTruthy();
    expect(screen.getByText("Model discovery is temporarily unavailable.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    hub.dispose();
  });

  test("roles that could not be read say why, in the Roles view", async () => {
    const h = await harness({ models: [rawModel("anthropic", "claude-a", "Claude A")] });
    h.hub.failRoles("The saved roles could not be read.");
    render(<ModelHubPanel controller={h.hub} />);
    fireEvent.click(screen.getByRole("button", { name: /^Roles/ }));
    expect(screen.getByText("The saved roles could not be read.")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Chat roles" })).toBeTruthy();
    h.hub.dispose();
  });

  test("only one model row is in the tab order, so Tab leaves the list", async () => {
    const h = await harness({
      models: [
        rawModel("anthropic", "claude-a", "Claude A"),
        rawModel("anthropic", "claude-c", "Claude C"),
        rawModel("openai", "gpt-b", "GPT B"),
      ],
    });
    const { container } = render(<ModelHubPanel controller={h.hub} />);
    const rows = [...container.querySelectorAll<HTMLElement>('[data-focus-key^="model-row:"]')];
    expect(rows).toHaveLength(3);
    expect(rows.filter((row) => row.tabIndex >= 0)).toHaveLength(1);
    const setButtons = [...container.querySelectorAll<HTMLElement>('button[aria-label^="Set "]')];
    expect(setButtons.filter((button) => button.tabIndex >= 0)).toHaveLength(1);
    h.hub.dispose();
  });

  test("arrow keys move between model rows, and down from the search box enters the list", async () => {
    const h = await harness({
      models: [
        rawModel("anthropic", "claude-a", "Claude A"),
        rawModel("anthropic", "claude-c", "Claude C"),
      ],
    });
    const { container } = render(<ModelHubPanel controller={h.hub} />);
    const search = screen.getByRole("textbox", { name: "Search models" });
    search.focus();
    fireEvent.keyDown(search, { key: "ArrowDown" });
    const first = document.activeElement as HTMLElement;
    expect(first.dataset.focusKey).toBe("model-row:anthropic/claude-a");
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect((document.activeElement as HTMLElement).dataset.focusKey).toBe(
      "model-row:anthropic/claude-c",
    );
    expect(container.querySelectorAll('[data-focus-key^="model-row:"][tabindex="0"]')).toHaveLength(
      1,
    );
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowUp" });
    expect((document.activeElement as HTMLElement).dataset.focusKey).toBe(
      "model-row:anthropic/claude-a",
    );
    h.hub.dispose();
  });

  test("choosing a model for a role moves focus to the search box, and the picked role's control after the pick", async () => {
    const h = await harness({
      models: [
        rawModel("anthropic", "claude-a", "Claude A"),
        rawModel("anthropic", "claude-c", "Claude C"),
      ],
    });
    render(<ModelHubPanel controller={h.hub} />);
    fireEvent.click(screen.getByRole("button", { name: /^Roles/ }));
    fireEvent.click(screen.getByRole("button", { name: "Choose a model for Default" }));
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Search models" }));
    fireEvent.click(screen.getByRole("button", { name: /anthropic\/claude-c ·/ }));
    await screen.findByText("Default now uses Claude C.");
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Choose a model for Default" }),
    );
    h.hub.dispose();
  });

  test("using a model for the session keeps focus on that model's row", async () => {
    const h = await harness({
      models: [
        rawModel("anthropic", "claude-a", "Claude A"),
        rawModel("anthropic", "claude-c", "Claude C"),
      ],
    });
    render(<ModelHubPanel controller={h.hub} />);
    fireEvent.click(screen.getByRole("button", { name: /anthropic\/claude-c ·/ }));
    await screen.findByText("Now using Claude C.");
    expect((document.activeElement as HTMLElement).dataset.focusKey).toBe(
      "model-row:anthropic/claude-c",
    );
    h.hub.dispose();
  });
});
