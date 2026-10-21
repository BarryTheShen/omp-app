import type { ShortcutDescriptor } from "@omp-app/contracts";
import { cleanup, render } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ShortcutRegistryProvider, useShortcutRegistry, useShortcutScope } from "./context";
import { MemoryPreferenceStore } from "./registry";

afterEach(() => cleanup());

// Two scopes bind one chord. Mod+Shift+J is not in the browser-reserved list (Mod+J is).
const earlier = {
  kind: "shortcut",
  id: "U0.earlierScope",
  owner: "U0",
  title: "Earlier scope",
  covers: [],
  requires: [],
  chord: "Mod+Shift+J",
  scope: "earlier",
} as const satisfies ShortcutDescriptor;

const later = {
  kind: "shortcut",
  id: "U0.laterScope",
  owner: "U0",
  title: "Later scope",
  covers: [],
  requires: [],
  chord: "Mod+Shift+J",
  scope: "later",
} as const satisfies ShortcutDescriptor;

/** A scope, and the action its chord runs. */
function Scope({
  id,
  scope,
  run,
}: {
  readonly id: `U0.${string}`;
  readonly scope: string;
  readonly run: () => void;
}) {
  useShortcutScope(scope);
  const registry = useShortcutRegistry();
  useEffect(() => registry.registerAction(id, run), [id, registry, run]);
  return null;
}

describe("useShortcutScope: the scope mounted first still wins a shared chord", () => {
  test("the earlier scope's action runs, and the later scope's action does not", () => {
    const earlierRun = vi.fn();
    const laterRun = vi.fn();
    render(
      <ShortcutRegistryProvider
        descriptors={[earlier, later]}
        preferenceStore={new MemoryPreferenceStore()}
      >
        <Scope id="U0.earlierScope" scope="earlier" run={earlierRun} />
        <Scope id="U0.laterScope" scope="later" run={laterRun} />
      </ShortcutRegistryProvider>,
    );
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "j",
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(earlierRun).toHaveBeenCalledTimes(1);
    expect(laterRun).not.toHaveBeenCalled();
  });
});
