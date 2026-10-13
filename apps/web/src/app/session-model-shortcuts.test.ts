import type { AppClient } from "@omp-app/client";
import type { CapabilityMap } from "@omp-app/contracts";
import { AppFailure, CapabilityStatus, ThreadId } from "@omp-app/contracts";
import { afterEach, describe, expect, test, vi } from "vitest";
import { D1_SHORTCUT_DESCRIPTORS } from "@/modules/D1/shortcuts/descriptors";
import type { OmpRuntimeStore } from "@/modules/R0/store";
import { ShortcutRegistry } from "@/shortcuts/registry";
import {
  registerSessionModelShortcuts,
  type SessionModelShortcutOptions,
} from "./session-model-shortcuts";

const THREAD = ThreadId.parse("0199a2f0-7a4b-7d1f-9a6c-111111111111");
const MODEL = { provider: "fake", id: "fast", name: "Fast", reasoning: true };

const CAPABILITIES: CapabilityMap = {
  "omp.cmd.set_model": CapabilityStatus.parse({ state: "available", via: "rpc" }),
  "omp.cmd.cycle_model": CapabilityStatus.parse({ state: "available", via: "rpc" }),
  "omp.cmd.get_available_thinking_levels": CapabilityStatus.parse({
    state: "available",
    via: "rpc",
  }),
  "omp.cmd.cycle_thinking_level": CapabilityStatus.parse({ state: "available", via: "rpc" }),
};

/** omp's answers to the commands the chords send; a test replaces one to make omp refuse it. */
const ANSWERS: Record<string, () => unknown> = {
  cycle_model: () => ({ model: MODEL, thinkingLevel: "off", isScoped: false }),
  cycle_thinking_level: () => ({ level: "low" }),
  get_available_thinking_levels: () => ({ levels: ["off", "low", "high"] }),
  get_state: () => ({ model: MODEL }),
};

interface Sent {
  readonly threadId: string;
  readonly command: { readonly type: string };
}

afterEach(() => {
  for (const node of document.querySelectorAll("textarea")) node.remove();
});

function setup(answers: Record<string, () => unknown> = {}) {
  const sent: Sent[] = [];
  const rpc = {
    send: async (request: Sent) => {
      sent.push(request);
      const answer = answers[request.command.type] ?? ANSWERS[request.command.type];
      if (answer === undefined) throw new Error(`no answer for ${request.command.type}`);
      return answer();
    },
  };
  const client = { port: () => rpc } as unknown as AppClient;
  const store = {
    getSnapshot: () => ({ lastSeq: 1, session: { model: MODEL, thinkingLevel: "off" } }),
    subscribe: () => () => undefined,
    applySessionState: vi.fn(),
  } as unknown as OmpRuntimeStore;
  const options: SessionModelShortcutOptions = {
    client,
    store,
    threadId: THREAD,
    capabilities: CAPABILITIES,
    openDialog: vi.fn(),
    fail: vi.fn(),
  };
  const registry = new ShortcutRegistry(D1_SHORTCUT_DESCRIPTORS);
  const dispose = registerSessionModelShortcuts(registry, () => options);
  return { registry, dispose, options, sent };
}

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

describe("session model and thinking chords", () => {
  test("Mod+P asks omp for the next model of this chat, then reads the chat's state again", async () => {
    const { registry, sent, dispose } = setup();

    expect(pressOn(registry, { key: "p", ctrlKey: true }).handled).toBe(true);

    await vi.waitFor(() =>
      expect(sent.map((request) => request.command.type)).toEqual(["cycle_model", "get_state"]),
    );
    expect(sent[0]).toEqual({ threadId: THREAD, command: { type: "cycle_model" } });
    dispose();
  });

  test("Alt+K reads the thinking levels of this chat's model, then cycles to the next level", async () => {
    const { registry, sent, dispose } = setup();

    expect(pressOn(registry, { key: "k", altKey: true }).handled).toBe(true);

    await vi.waitFor(() =>
      expect(sent.map((request) => request.command.type)).toEqual([
        "get_available_thinking_levels",
        "cycle_thinking_level",
        "get_state",
      ]),
    );
    dispose();
  });

  test("Alt+M and Alt+P open this chat's model dialog from the composer, which takes focus back", () => {
    const { registry, options, dispose } = setup();
    const composer = document.createElement("textarea");
    composer.setAttribute("aria-label", "Message input");
    document.body.append(composer);

    expect(pressOn(registry, { key: "m", altKey: true }, composer).handled).toBe(true);
    expect(pressOn(registry, { key: "p", altKey: true }, composer).handled).toBe(true);

    expect(options.openDialog).toHaveBeenNthCalledWith(1, composer);
    expect(options.openDialog).toHaveBeenNthCalledWith(2, composer);
    dispose();
  });

  test("a model change omp refuses is named in plain English, and the chat's state is not read again", async () => {
    const { registry, sent, options, dispose } = setup({
      cycle_model: () => {
        throw new AppFailure({
          code: "unavailable",
          capability: "omp.cmd.cycle_model",
          message: "No other model is available.",
          retryable: false,
        });
      },
    });

    pressOn(registry, { key: "p", ctrlKey: true });

    await vi.waitFor(() =>
      expect(options.fail).toHaveBeenCalledWith("No other model is available."),
    );
    expect(sent.map((request) => request.command.type)).toEqual(["cycle_model"]);
    dispose();
  });

  test("disposing the registration stops every model and thinking chord", () => {
    const { registry, options, dispose } = setup();
    dispose();

    expect(pressOn(registry, { key: "m", altKey: true }).handled).toBe(false);
    expect(pressOn(registry, { key: "p", ctrlKey: true }).handled).toBe(false);
    expect(options.openDialog).not.toHaveBeenCalled();
  });
});
