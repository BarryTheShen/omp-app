import type { Descriptor, DescriptorId } from "@omp-app/contracts";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { ShortcutRegistryProvider, useShortcutRegistry } from "./context";
import { ShortcutPreferenceNotice } from "./preference-notice";
import {
  MemoryPreferenceStore,
  type RebindResult,
  SHORTCUT_PREFERENCES_KEY,
  type ShortcutRegistry,
} from "./registry";

const NOTICE =
  "Could not load saved shortcuts, so the default shortcuts are in use. Open Keyboard shortcuts and choose Reset all.";

const descriptors: readonly Descriptor[] = [
  {
    id: "U1.toggle",
    owner: "U1",
    title: "Toggle thinking",
    kind: "shortcut",
    chord: "Alt+T",
    scope: "transcript",
    covers: [],
    requires: [],
  },
];

/** Renders the notice over a registry that reads `saved` as its saved shortcuts; returns a way to reach that registry. */
function renderNotice(saved: string | undefined): () => ShortcutRegistry {
  const store = new MemoryPreferenceStore();
  if (saved !== undefined) store.set(SHORTCUT_PREFERENCES_KEY, saved);
  let registry: ShortcutRegistry | undefined;
  function Capture() {
    registry = useShortcutRegistry();
    return null;
  }
  render(
    <ShortcutRegistryProvider descriptors={descriptors} preferenceStore={store}>
      <Capture />
      <ShortcutPreferenceNotice />
    </ShortcutRegistryProvider>,
  );
  return () => {
    if (registry === undefined) throw new Error("The shortcut registry did not mount.");
    return registry;
  };
}

afterEach(() => cleanup());

describe("a saved shortcut preference that cannot be read is said in the header until it is reset or rebound", () => {
  test("the notice shows the words that say how to clear it", () => {
    renderNotice("{not json");

    expect(screen.getByRole("alert").textContent).toBe(NOTICE);
  });

  test("nothing shows when the saved preference reads", () => {
    renderNotice(JSON.stringify({ "U1.toggle": "Alt+2" }));

    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("nothing shows when there is no saved preference", () => {
    renderNotice(undefined);

    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("resetting all shortcuts takes the notice away", () => {
    const registry = renderNotice("{not json");
    expect(screen.getByRole("alert")).toBeTruthy();

    act(() => registry().resetAll());

    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("a successful rebind takes the notice away", () => {
    const registry = renderNotice("{not json");
    let result: RebindResult | undefined;

    act(() => {
      result = registry().rebind("U1.toggle" as DescriptorId, "Alt+2");
    });

    expect(result?.ok).toBe(true);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
