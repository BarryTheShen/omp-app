import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { U0_SHORTCUT_SHEET_COMMAND } from "@/palette/descriptor";
import { ShortcutRegistryProvider, ShortcutSheetHost, useShortcutRegistry } from "./index";
import type { ShortcutRegistry } from "./registry";

afterEach(() => cleanup());

function Probe({ onRegistry }: { readonly onRegistry: (registry: ShortcutRegistry) => void }) {
  onRegistry(useShortcutRegistry());
  return null;
}

describe("the Keyboard shortcuts command", () => {
  test("running the command opens the sheet, and unmounting removes the command", () => {
    let registry: ShortcutRegistry | undefined;
    const view = render(
      <ShortcutRegistryProvider descriptors={[U0_SHORTCUT_SHEET_COMMAND]}>
        <ShortcutSheetHost>
          <Probe
            onRegistry={(next) => {
              registry = next;
            }}
          />
        </ShortcutSheetHost>
      </ShortcutRegistryProvider>,
    );
    expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).toBeNull();

    act(() => {
      registry?.commandFor(U0_SHORTCUT_SHEET_COMMAND.id)?.run();
    });
    expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeTruthy();

    view.unmount();
    expect(registry?.commandFor(U0_SHORTCUT_SHEET_COMMAND.id)).toBeUndefined();
  });
});
