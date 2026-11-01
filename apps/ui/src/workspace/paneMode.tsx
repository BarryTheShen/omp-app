import type { IDockviewPanelProps } from "dockview-react";
import { createContext, type ReactNode, use, useEffect, useState } from "react";

/** Pane mode is on (`Workspace.tsx`): its keys act on the focused pane, which shows an outline meanwhile. */
export const PaneModeContext = createContext(false);

/**
 * The outline of the pane that pane mode's keys act on, drawn over the pane while the mode is on and its group is the
 * focused one. A pane draws it itself: dockview draws the panes' content in overlays of its own, outside the group's
 * element, so a style on the focused group would sit under the content.
 */
export function PaneModeOutline({ api }: { readonly api: IDockviewPanelProps["api"] }): ReactNode {
  const on = use(PaneModeContext);
  const [focused, setFocused] = useState(api.isGroupActive);
  useEffect(() => {
    setFocused(api.isGroupActive);
    const listener = api.onDidActiveGroupChange((event) => setFocused(event.isActive));
    return () => listener.dispose();
  }, [api]);
  if (!on || !focused) return null;
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 z-50 ring-2 ring-(--accent) ring-inset"
    />
  );
}
