import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { U2_EXTERNAL_EDITOR_SHORTCUT } from "@/modules/U2/shortcuts/shortcuts";
import {
  MemoryPreferenceStore,
  type ShortcutRegistry,
  ShortcutRegistryProvider,
  useShortcutRegistry,
} from "@/shortcuts";
import {
  type ExternalEditorShortcutOptions,
  useExternalEditorShortcut,
} from "./external-editor-dialog";

afterEach(() => cleanup());

function Harness({
  options,
  registry,
}: {
  readonly options: ExternalEditorShortcutOptions;
  readonly registry: { current?: ShortcutRegistry };
}) {
  registry.current = useShortcutRegistry();
  useExternalEditorShortcut(options);
  return null;
}

function Provided({
  options,
  registry,
}: {
  readonly options: ExternalEditorShortcutOptions;
  readonly registry: { current?: ShortcutRegistry };
}) {
  return (
    <ShortcutRegistryProvider
      descriptors={[U2_EXTERNAL_EDITOR_SHORTCUT]}
      preferenceStore={new MemoryPreferenceStore()}
    >
      <Harness options={options} registry={registry} />
    </ShortcutRegistryProvider>
  );
}

/** Ctrl+G pressed in the message box, as the browser delivers it to the registry. */
function pressCtrlG(registry: { current?: ShortcutRegistry }): void {
  const box = document.createElement("div");
  box.dataset.focusScope = "composer-input";
  const textarea = document.createElement("textarea");
  box.append(textarea);
  const event = new KeyboardEvent("keydown", {
    key: "g",
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  textarea.dispatchEvent(event);
  registry.current?.dispatch(event, "composer-input");
}

describe("useExternalEditorShortcut", () => {
  test("the kept text goes to the draft that is current when Use this text is pressed, not the one Ctrl+G started with", async () => {
    const applyAtCtrlG = vi.fn();
    const applyNow = vi.fn();
    let finishEditing: (text: string) => void = () => undefined;
    const edit = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finishEditing = resolve;
        }),
    );
    const readDraft = () => "first line of the draft";
    const registry: { current?: ShortcutRegistry } = {};
    const { rerender } = render(
      <Provided options={{ readDraft, edit, apply: applyAtCtrlG }} registry={registry} />,
    );

    pressCtrlG(registry);
    expect(edit).toHaveBeenCalledTimes(1);
    expect(edit).toHaveBeenCalledWith("first line of the draft");

    // A new chat finishes opening while the editor is open: the composer now shows another draft controller.
    rerender(<Provided options={{ readDraft, edit, apply: applyNow }} registry={registry} />);
    await act(async () => finishEditing("edited in the editor"));

    expect(applyNow).toHaveBeenCalledTimes(1);
    expect(applyNow).toHaveBeenCalledWith("edited in the editor");
    expect(applyAtCtrlG).not.toHaveBeenCalled();
  });

  test("Cancel keeps the draft as it was: nothing is applied", async () => {
    const apply = vi.fn();
    let finishEditing: (text: string) => void = () => undefined;
    const edit = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finishEditing = resolve;
        }),
    );
    const readDraft = () => "keep the draft";
    const registry: { current?: ShortcutRegistry } = {};
    render(<Provided options={{ readDraft, edit, apply }} registry={registry} />);

    pressCtrlG(registry);
    await act(async () => finishEditing("keep the draft"));

    expect(apply).not.toHaveBeenCalled();
  });
});
