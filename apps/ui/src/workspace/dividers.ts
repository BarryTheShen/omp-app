/**
 * Keeps a drag of the panes' dividers (dockview's `.dv-sash`) from selecting text. dockview resizes on a held pointer
 * and guards only its own other drags against selecting: WebKit, the desktop window's engine, starts a selection from
 * the press on a divider and stretches it over whatever the pointer crosses, so a resize selected the panes' text. As
 * dockview's guard does (`disableTextSelection`): nothing is selectable and no selection may start until the drag ends;
 * and the press itself is refused as one. dockview's resize goes on: it follows the pointer's events, which still come.
 * Returns the function that stops the guard.
 */
export function keepDividerDragsFromSelecting(doc: Document = document): () => void {
  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    if (!(event.target instanceof Element) || event.target.closest(".dv-sash") === null) return;
    event.preventDefault();
    const root = doc.documentElement;
    const properties = ["user-select", "-webkit-user-select"] as const;
    const previous = properties.map((name) => [name, root.style.getPropertyValue(name)] as const);
    for (const name of properties) root.style.setProperty(name, "none");
    const refuse = (selecting: Event): void => selecting.preventDefault();
    const end = (): void => {
      doc.removeEventListener("selectstart", refuse, true);
      doc.removeEventListener("pointerup", end, true);
      doc.removeEventListener("pointercancel", end, true);
      for (const [name, value] of previous) {
        if (value === "") root.style.removeProperty(name);
        else root.style.setProperty(name, value);
      }
    };
    doc.addEventListener("selectstart", refuse, true);
    doc.addEventListener("pointerup", end, true);
    doc.addEventListener("pointercancel", end, true);
  };
  doc.addEventListener("pointerdown", onPointerDown, true);
  return () => doc.removeEventListener("pointerdown", onPointerDown, true);
}
