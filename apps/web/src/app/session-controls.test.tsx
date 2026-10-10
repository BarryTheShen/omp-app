import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { U0_MODEL_COMMAND } from "@/palette";
import {
  MemoryPreferenceStore,
  type ShortcutRegistry,
  ShortcutRegistryProvider,
  useShortcutRegistry,
} from "@/shortcuts";
import { useModelPaletteCommand } from "./palette-model-command";

afterEach(() => cleanup());

// One array for every render: the provider rebuilds its registry whenever this identity changes.
const DESCRIPTORS = [U0_MODEL_COMMAND] as const;

/** Mounts the palette's model command the way the open header does, and exposes the registry it lives in. */
function HeaderModelCommand({
  openDialog,
  registry,
}: {
  readonly openDialog: (restoreFocus?: HTMLElement) => void;
  readonly registry: { current?: ShortcutRegistry };
}) {
  registry.current = useShortcutRegistry();
  useModelPaletteCommand(openDialog);
  return null;
}

describe("the palette's model command", () => {
  test("opens the model dialog with the composer as the place focus returns to", () => {
    const registry: { current?: ShortcutRegistry } = {};
    const opened: Array<HTMLElement | undefined> = [];
    const openDialog = (restoreFocus?: HTMLElement) => {
      opened.push(restoreFocus);
    };
    const preferences = new MemoryPreferenceStore();
    render(
      <ShortcutRegistryProvider descriptors={DESCRIPTORS} preferenceStore={preferences}>
        <textarea aria-label="Message input" />
        <HeaderModelCommand openDialog={openDialog} registry={registry} />
      </ShortcutRegistryProvider>,
    );

    registry.current?.commandFor(U0_MODEL_COMMAND.id)?.run();
    expect(opened).toHaveLength(1);
    expect(opened[0]).toBe(screen.getByRole("textbox", { name: "Message input" }));
  });

  test("keeps the dialog's own return point when the page has no composer", () => {
    const registry: { current?: ShortcutRegistry } = {};
    const opened: Array<HTMLElement | undefined> = [];
    const openDialog = (restoreFocus?: HTMLElement) => {
      opened.push(restoreFocus);
    };
    const preferences = new MemoryPreferenceStore();
    render(
      <ShortcutRegistryProvider descriptors={DESCRIPTORS} preferenceStore={preferences}>
        <HeaderModelCommand openDialog={openDialog} registry={registry} />
      </ShortcutRegistryProvider>,
    );

    registry.current?.commandFor(U0_MODEL_COMMAND.id)?.run();
    expect(opened).toEqual([undefined]);
  });

  test("is removed when the header that registered it unmounts", () => {
    const registry: { current?: ShortcutRegistry } = {};
    const openDialog = () => undefined;
    const preferences = new MemoryPreferenceStore();
    const { rerender } = render(
      <ShortcutRegistryProvider descriptors={DESCRIPTORS} preferenceStore={preferences}>
        <HeaderModelCommand openDialog={openDialog} registry={registry} />
      </ShortcutRegistryProvider>,
    );
    expect(registry.current?.commandFor(U0_MODEL_COMMAND.id)).toBeDefined();

    rerender(
      <ShortcutRegistryProvider descriptors={DESCRIPTORS} preferenceStore={preferences}>
        <p>The chat has no header.</p>
      </ShortcutRegistryProvider>,
    );
    expect(registry.current?.commandFor(U0_MODEL_COMMAND.id)).toBeUndefined();
  });
});
