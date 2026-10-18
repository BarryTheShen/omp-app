import { AppFailure, ConfigEntry } from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { AdvisorConfigController, AdvisorConfigState } from "./advisor";
import { AdvisorConfigurationView } from "./configuration";

afterEach(cleanup);

const state: AdvisorConfigState = {
  phase: "ready",
  entries: [],
  layer: "global",
  revision: "rev-1" as AdvisorConfigState["revision"],
  error: null,
};

function harness(
  options: {
    readonly read?: (publish: (state: AdvisorConfigState) => void) => Promise<AdvisorConfigState>;
    readonly write?: (
      key: string,
      value: unknown,
      publish: (state: AdvisorConfigState) => void,
    ) => Promise<AdvisorConfigState>;
  } = {},
): {
  readonly controller: AdvisorConfigController;
  readonly publish: (state: AdvisorConfigState) => void;
} {
  let current = state;
  const listeners = new Set<() => void>();
  const publish = (next: AdvisorConfigState): void => {
    current = next;
    for (const listener of listeners) listener();
  };
  return {
    controller: {
      getSnapshot: () => current,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      read: async () => (options.read ? options.read(publish) : current),
      write: async (key, value) => (options.write ? options.write(key, value, publish) : current),
      dispose: () => listeners.clear(),
    },
    publish,
  };
}

describe("advisor configuration view", () => {
  test("keeps an unsaved draft for one setting when another setting is saved", async () => {
    const writes: Array<[string, unknown]> = [];
    const store = harness({
      write: async (key, value, publish) => {
        writes.push([key, value]);
        const next = { ...state, revision: "rev-2" as AdvisorConfigState["revision"] };
        publish(next);
        return next;
      },
    });
    render(<AdvisorConfigurationView state={state} controller={store.controller} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Advisor Review Mode" }), {
      target: { value: "agent-end" },
    });
    const saveEnabled = screen.getByRole("button", { name: "Save Enable Advisor" });
    expect(saveEnabled.textContent).toBe("Save");
    expect(saveEnabled.getAttribute("aria-label")).toBe("Save Enable Advisor");
    fireEvent.click(saveEnabled);
    await waitFor(() => expect(writes).toEqual([["advisor.enabled", false]]));
    expect(
      (screen.getByRole("combobox", { name: "Advisor Review Mode" }) as HTMLSelectElement).value,
    ).toBe("agent-end");
  });

  test("reload clears an edited draft and shows the latest stored value", async () => {
    const newestEntry = ConfigEntry.parse({
      key: "advisor.reviewMode",
      secret: false,
      value: "agent-end",
      source: "global",
      overrides: [],
    });
    const newestState: AdvisorConfigState = {
      ...state,
      entries: [{ key: "advisor.reviewMode", value: newestEntry }],
      revision: "rev-2" as AdvisorConfigState["revision"],
    };
    const store = harness({
      read: async (publish) => {
        publish(newestState);
        return newestState;
      },
    });
    render(<AdvisorConfigurationView state={state} controller={store.controller} />);
    const mode = screen.getByRole("combobox", { name: "Advisor Review Mode" }) as HTMLSelectElement;
    fireEvent.change(mode, { target: { value: "turn" } });
    expect(mode.value).toBe("turn");
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(mode.value).toBe("agent-end"));
  });

  test("reads then retries a conflict with the exact staged value", async () => {
    const conflict = new AppFailure({
      code: "conflict",
      message: "This setting changed elsewhere.",
      retryable: true,
    });
    const calls: string[] = [];
    let first = true;
    const store = harness({
      read: async (publish) => {
        calls.push("read");
        const latest = { ...state, revision: "rev-2" as AdvisorConfigState["revision"] };
        publish(latest);
        return latest;
      },
      write: async (key, value, publish) => {
        calls.push(`write:${key}:${value}`);
        if (first) {
          first = false;
          publish({ ...state, phase: "conflict", error: conflict });
          throw conflict;
        }
        const saved = { ...state, revision: "rev-3" as AdvisorConfigState["revision"] };
        publish(saved);
        return saved;
      },
    });
    render(<AdvisorConfigurationView state={state} controller={store.controller} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Advisor Review Mode" }), {
      target: { value: "agent-end" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save Advisor Review Mode" }));
    await screen.findByRole("heading", { name: "These settings changed elsewhere" });
    fireEvent.click(screen.getByRole("button", { name: "Try saving again" }));
    await waitFor(() =>
      expect(calls).toEqual([
        "write:advisor.reviewMode:agent-end",
        "read",
        "write:advisor.reviewMode:agent-end",
      ]),
    );
  });

  test("shows a failed save instead of silently doing nothing", async () => {
    const store = harness({
      write: async () => {
        throw new AppFailure({
          code: "invalid_args",
          message: "Enter a whole number above zero.",
          retryable: false,
        });
      },
    });
    render(<AdvisorConfigurationView state={state} controller={store.controller} />);
    fireEvent.change(screen.getByRole("spinbutton", { name: "Advisor Review Interval" }), {
      target: { value: "0" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save Advisor Review Interval" }));
    await screen.findByText("Enter a whole number above zero.");
  });
});
