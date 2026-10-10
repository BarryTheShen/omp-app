import { useEffect, useRef } from "react";
import { U0_MODEL_COMMAND } from "@/palette";
import { useShortcutRegistry } from "@/shortcuts";
import { composerInput } from "./composer-input";

/**
 * Registers the palette's model command for the open header: it opens the model dialog and returns focus
 * to the composer when the dialog closes. The palette closes right after its command runs, so the dialog
 * cannot take the palette's own return point. The registration is removed when the header unmounts.
 */
export function useModelPaletteCommand(openDialog: (restoreFocus?: HTMLElement) => void): void {
  const shortcuts = useShortcutRegistry();
  // A ref keeps the registration steady while the dialog's inputs change.
  const openRef = useRef(openDialog);
  useEffect(() => {
    openRef.current = openDialog;
  });
  useEffect(
    () =>
      shortcuts.registerCommand(U0_MODEL_COMMAND.id, {
        run: () => openRef.current(composerInput() ?? undefined),
      }),
    [shortcuts],
  );
}
