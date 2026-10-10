import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { P1_AGENT_HUB_DESCRIPTORS } from "@/modules/P1/hub/descriptors";
import { ShortcutRegistryProvider, useShortcutRegistry } from "@/shortcuts";
import type { ShortcutRegistry } from "@/shortcuts/registry";
import { useAgentHubShortcut } from "./agent-hub-shortcut";

afterEach(() => cleanup());

function Probe({
  open,
  onRegistry,
}: {
  readonly open: () => void;
  readonly onRegistry: (registry: ShortcutRegistry) => void;
}) {
  useAgentHubShortcut(open);
  onRegistry(useShortcutRegistry());
  return null;
}

describe("the Agent Hub command and Alt+A", () => {
  test("Alt+A and the palette's Agent Hub command open the hub; unmounting removes both", () => {
    const open = vi.fn();
    let registry: ShortcutRegistry | undefined;
    const view = render(
      <ShortcutRegistryProvider descriptors={P1_AGENT_HUB_DESCRIPTORS}>
        <Probe
          onRegistry={(next) => {
            registry = next;
          }}
          open={open}
        />
      </ShortcutRegistryProvider>,
    );
    const altA = () =>
      new KeyboardEvent("keydown", { key: "a", altKey: true, bubbles: true, cancelable: true });

    expect(registry?.dispatch(altA(), "global").handled).toBe(true);
    expect(open).toHaveBeenCalledTimes(1);

    expect(registry?.commandFor("P1.agentHub")?.shortcut).toBe("P1.agentHubShortcut");
    registry?.commandFor("P1.agentHub")?.run();
    expect(open).toHaveBeenCalledTimes(2);

    view.unmount();
    expect(registry?.dispatch(altA(), "global").handled).toBe(false);
    expect(registry?.commandFor("P1.agentHub")).toBeUndefined();
    expect(open).toHaveBeenCalledTimes(2);
  });
});
