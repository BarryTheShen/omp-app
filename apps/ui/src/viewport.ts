/**
 * Keeps the page the height of what is visible while an on-screen keyboard covers part of it. On iOS the keyboard
 * overlays the page instead of shrinking it (WebKit has no `interactive-widget`, bug 259770): only the visual viewport
 * gets shorter, and the message box at the foot of the page stays under the keyboard. So the page takes the visual
 * viewport's height (`--app-height`, read by `styles/index.css`), drops the home indicator's inset, which the keyboard
 * covers (`--app-bottom`), and stays at the top, where Safari would pan it to the focused field. A pinch also shrinks
 * the visual viewport; the page does not follow a zoom.
 */
export function followVisualViewport(viewport = window.visualViewport): () => void {
  if (viewport === null || viewport === undefined) return () => {};
  const root = document.documentElement;
  const release = (): void => {
    root.style.removeProperty("--app-height");
    root.style.removeProperty("--app-bottom");
  };
  const update = (): void => {
    if (Math.abs(viewport.scale - 1) > 0.01) return;
    if (window.innerHeight - viewport.height > 1) {
      root.style.setProperty("--app-height", `${Math.round(viewport.height)}px`);
      root.style.setProperty("--app-bottom", "0px");
      if (window.scrollY !== 0 || viewport.offsetTop !== 0) window.scrollTo(0, 0);
    } else {
      release();
    }
  };
  viewport.addEventListener("resize", update);
  viewport.addEventListener("scroll", update);
  update();
  return () => {
    viewport.removeEventListener("resize", update);
    viewport.removeEventListener("scroll", update);
    release();
  };
}
