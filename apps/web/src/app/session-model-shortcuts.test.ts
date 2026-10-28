import type { AppClient } from "@omp-app/client";
import type {
  CapabilityMap,
  ConfigEntry,
  ConfigListResult,
  JsonValue,
  Omp,
  Revision,
} from "@omp-app/contracts";
import { AppFailure, CapabilityStatus, ConfigStore, ThreadId } from "@omp-app/contracts";
import { afterEach, describe, expect, test, vi } from "vitest";
import { D1_SHORTCUT_DESCRIPTORS } from "@/modules/D1/shortcuts/descriptors";
import type { OmpRuntimeStore } from "@/modules/R0/store";
import { ShortcutRegistry } from "@/shortcuts/registry";
import {
  registerSessionModelShortcuts,
  type SessionModelShortcutOptions,
} from "./session-model-shortcuts";

const THREAD = ThreadId.parse("0199a2f0-7a4b-7d1f-9a6c-111111111111");

const CAPABILITIES: CapabilityMap = {
  "omp.cmd.get_available_models": CapabilityStatus.parse({ state: "available", via: "rpc" }),
  "omp.cmd.set_model": CapabilityStatus.parse({ state: "available", via: "rpc" }),
  "omp.cmd.get_available_thinking_levels": CapabilityStatus.parse({
    state: "available",
    via: "rpc",
  }),
  "omp.cmd.set_thinking_level": CapabilityStatus.parse({ state: "available", via: "rpc" }),
  "omp.cmd.cycle_thinking_level": CapabilityStatus.parse({ state: "available", via: "rpc" }),
};

/** The three role models of the walk: the Fast role (smol), the Default role and the Thinking role (slow). */
const WALK = { smol: "fake/a", default: "fake/b", slow: "fake/c" };

/** omp's wire record for one model of the fake provider; every model is available and reasons. */
function wire(id: string): Omp.ModelInfo {
  return {
    provider: "fake",
    id,
    name: `Model ${id}`,
    api: "chat-completions",
    baseUrl: "https://provider.invalid/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
}

function setting(key: string, value: unknown): ConfigEntry {
  return {
    key,
    secret: false,
    value: value as JsonValue,
    source: "global",
    overrides: [],
  } as ConfigEntry;
}

interface WorldOptions {
  /** Each role's selector, as the saved settings hold it. */
  readonly roles: Readonly<Record<string, string>>;
  /** The model the chat starts on. */
  readonly start: string;
  /** The thinking levels the current model offers; "off" is always offered. */
  readonly levels?: readonly string[];
  readonly configFails?: boolean;
  readonly refuseModel?: boolean;
}

interface World {
  readonly options: SessionModelShortcutOptions;
  readonly registry: ShortcutRegistry;
  /** The requests omp received, by method, in order. Sign-in reads are not recorded. */
  readonly sent: string[];
  /** The model ids the chat set, in order. */
  readonly modelsSet: string[];
  /** The model id the header shows: the store's copy of omp's state. */
  readonly current: () => string;
  /** The thinking level the header shows. */
  readonly thinking: () => string;
  readonly dispose: () => void;
}

/**
 * One open chat: omp's own state, the app's copy of it in the store, the saved roles, and the chords registered
 * for the chat. omp's state changes at once when a model is set; the store takes it only when the app reads it again.
 */
function world(setup: WorldOptions): World {
  const sent: string[] = [];
  const modelsSet: string[] = [];
  const levels = setup.levels ?? ["off", "low", "high"];
  const omp = { model: wire(setup.start), thinkingLevel: "off" };
  const session = { model: wire(setup.start), thinkingLevel: "off" };
  const listeners = new Set<() => void>();

  const chat = {
    request: async (request: {
      readonly method: string;
      readonly params: Record<string, unknown>;
    }) => {
      const { method, params } = request;
      if (method === "get_login_providers") throw new Error("sign-ins are not read here");
      sent.push(method);
      switch (method) {
        case "get_available_models":
          return { models: ["a", "b", "c"].map(wire) };
        case "set_model": {
          const id = String(params.modelId);
          if (setup.refuseModel) {
            throw new AppFailure({
              code: "internal",
              message: `Model not found: fake/${id}`,
              retryable: false,
            });
          }
          modelsSet.push(id);
          omp.model = wire(id);
          return omp.model;
        }
        case "get_state":
          return { model: omp.model, thinkingLevel: omp.thinkingLevel };
        case "get_available_thinking_levels":
          return { levels: [...levels] };
        case "set_thinking_level":
          omp.thinkingLevel = String(params.level);
          return {};
        case "cycle_thinking_level":
          return { level: "low" };
        default:
          throw new Error(`no answer for ${method}`);
      }
    },
  };
  const config = {
    list: async (): Promise<ConfigListResult> => {
      if (setup.configFails) {
        throw new AppFailure({
          code: "internal",
          message: "The config file could not be read.",
          retryable: false,
        });
      }
      return {
        entries: [
          setting("modelRoles", setup.roles),
          setting("cycleOrder", ["smol", "default", "slow"]),
          setting("modelRoleStorage", "global"),
        ],
        revision: "config-1" as Revision,
      };
    },
    write: async () => {
      throw new Error("roles are not written here");
    },
  };
  const client = {
    port: (token: unknown) => (token === ConfigStore ? config : chat),
    subscribe: async () => ({
      onEvent: () => () => undefined,
      unsubscribe: async () => undefined,
    }),
  } as unknown as AppClient;
  const store = {
    getSnapshot: () => ({ lastSeq: 1, session }),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    applySessionState: (state: {
      readonly model?: Omp.ModelInfo;
      readonly thinkingLevel?: string;
    }) => {
      if (state.model) session.model = state.model;
      if (state.thinkingLevel) session.thinkingLevel = state.thinkingLevel;
      for (const listener of listeners) listener();
    },
  } as unknown as OmpRuntimeStore;

  const options: SessionModelShortcutOptions = {
    client,
    store,
    threadId: THREAD,
    folder: null,
    capabilities: CAPABILITIES,
    openDialog: vi.fn(),
    notify: vi.fn(),
    fail: vi.fn(),
  };
  const registry = new ShortcutRegistry(D1_SHORTCUT_DESCRIPTORS);
  const dispose = registerSessionModelShortcuts(registry, () => options);
  return {
    options,
    registry,
    sent,
    modelsSet,
    current: () => session.model.id,
    thinking: () => session.thinkingLevel,
    dispose,
  };
}

afterEach(() => {
  for (const node of document.querySelectorAll("textarea")) node.remove();
});

/** Presses a key on `target` and runs the registry on it, the way the app's window listeners do. */
function pressOn(
  registry: ShortcutRegistry,
  init: KeyboardEventInit,
  target: EventTarget = document.body,
) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return registry.dispatch(event, "global");
}

describe("session model role cycle", () => {
  test("Ctrl+P sets the next role's model with set_model, then reads the chat's state again", async () => {
    const w = world({ roles: WALK, start: "a" });

    expect(pressOn(w.registry, { key: "p", ctrlKey: true }).handled).toBe(true);

    await vi.waitFor(() => expect(w.current()).toBe("b"));
    expect(w.sent).toEqual(["get_available_models", "set_model", "get_state"]);
    expect(w.modelsSet).toEqual(["b"]);
    expect(w.options.fail).not.toHaveBeenCalled();
    w.dispose();
  });

  test("Shift+Ctrl+P walks back to the last role, and its thinking level is set after its model", async () => {
    const w = world({ roles: { ...WALK, slow: "fake/c:high" }, start: "a" });

    expect(pressOn(w.registry, { key: "P", ctrlKey: true, shiftKey: true }).handled).toBe(true);

    await vi.waitFor(() => expect(w.thinking()).toBe("high"));
    expect(w.sent).toEqual([
      "get_available_models",
      "set_model",
      "get_state",
      "get_available_thinking_levels",
      "set_thinking_level",
      "get_state",
    ]);
    expect(w.current()).toBe("c");
    expect(w.options.fail).not.toHaveBeenCalled();
    w.dispose();
  });

  test("two presses in a row each take one step, the second from the model the first set", async () => {
    const w = world({ roles: WALK, start: "a" });

    pressOn(w.registry, { key: "p", ctrlKey: true });
    pressOn(w.registry, { key: "p", ctrlKey: true });

    await vi.waitFor(() => expect(w.current()).toBe("c"));
    expect(w.modelsSet).toEqual(["b", "c"]);
    w.dispose();
  });

  test("with one role model, Ctrl+P says so in the status line and changes no model", async () => {
    // The chat starts on a model no role names, so the unset default role resolves to nothing: one role is left.
    const w = world({ roles: { smol: "fake/a" }, start: "z" });

    pressOn(w.registry, { key: "p", ctrlKey: true });

    await vi.waitFor(() =>
      expect(w.options.notify).toHaveBeenCalledWith("Only one role model available"),
    );
    expect(w.sent).toEqual(["get_available_models"]);
    expect(w.options.fail).not.toHaveBeenCalled();
    w.dispose();
  });

  test("a thinking level the model does not offer is named in the error line, and the new model stays", async () => {
    const w = world({
      roles: { ...WALK, slow: "fake/c:high" },
      start: "b",
      levels: ["off", "low"],
    });

    pressOn(w.registry, { key: "p", ctrlKey: true });

    await vi.waitFor(() =>
      expect(w.options.fail).toHaveBeenCalledWith(
        "The model changed, but its thinking level could not be set: That thinking level is not supported by the current model.",
      ),
    );
    expect(w.current()).toBe("c");
    w.dispose();
  });

  test("a roles read that fails is named in the error line, and no model is changed", async () => {
    const w = world({ roles: WALK, start: "a", configFails: true });

    pressOn(w.registry, { key: "p", ctrlKey: true });

    await vi.waitFor(() =>
      expect(w.options.fail).toHaveBeenCalledWith("The config file could not be read."),
    );
    expect(w.sent).toEqual(["get_available_models"]);
    expect(w.current()).toBe("a");
    w.dispose();
  });

  test("a model omp refuses is named in the error line, and the chat's state is not read again", async () => {
    const w = world({ roles: WALK, start: "a", refuseModel: true });

    pressOn(w.registry, { key: "p", ctrlKey: true });

    await vi.waitFor(() => expect(w.options.fail).toHaveBeenCalledWith("Model not found: fake/b"));
    expect(w.sent).toEqual(["get_available_models", "set_model"]);
    expect(w.current()).toBe("a");
    w.dispose();
  });

  test("disposing the registration stops every model and thinking chord", () => {
    const w = world({ roles: WALK, start: "a" });
    w.dispose();

    expect(pressOn(w.registry, { key: "p", ctrlKey: true }).handled).toBe(false);
    expect(pressOn(w.registry, { key: "P", ctrlKey: true, shiftKey: true }).handled).toBe(false);
    expect(pressOn(w.registry, { key: "m", altKey: true }).handled).toBe(false);
    expect(w.options.openDialog).not.toHaveBeenCalled();
  });
});

describe("session thinking and dialog chords", () => {
  test("Alt+K reads the thinking levels of this chat's model, then cycles to the next level", async () => {
    const w = world({ roles: WALK, start: "a" });

    expect(pressOn(w.registry, { key: "k", altKey: true }).handled).toBe(true);

    await vi.waitFor(() =>
      expect(w.sent).toEqual([
        "get_available_thinking_levels",
        "cycle_thinking_level",
        "get_state",
      ]),
    );
    w.dispose();
  });

  test("Alt+M and Alt+P open this chat's model dialog from the composer, which takes focus back", () => {
    const w = world({ roles: WALK, start: "a" });
    const composer = document.createElement("textarea");
    composer.setAttribute("aria-label", "Message input");
    document.body.append(composer);

    expect(pressOn(w.registry, { key: "m", altKey: true }, composer).handled).toBe(true);
    expect(pressOn(w.registry, { key: "p", altKey: true }, composer).handled).toBe(true);

    expect(w.options.openDialog).toHaveBeenNthCalledWith(1, composer);
    expect(w.options.openDialog).toHaveBeenNthCalledWith(2, composer);
    w.dispose();
  });
});
