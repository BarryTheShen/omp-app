/**
 * Keeps the page the height of what is visible while an on-screen keyboard covers part of it. On iOS the keyboard
 * overlays the page instead of shrinking it (WebKit has no `interactive-widget`, bug 259770): only the visual viewport
 * gets shorter, and the message box at the foot of the page stays under the keyboard. So the page takes the visual
 * viewport's height (`--app-height`, read by `styles/index.css`), drops the home indicator's inset, which the keyboard
 * covers (`--app-bottom`), and stays at the top, where Safari would pan it to the focused field. A pinch also shrinks
 * the visual viewport; the page does not follow a zoom.
 *
 * With the keyboard up, iOS also pans the page under a finger whose drag no box takes. Pulling the page back at every
 * step of that pan fought iOS's own movement and its momentum, and the app shook for about two seconds. So while the
 * keyboard is up a drag no box can take is stopped before it pans the page (`guardTouches`), and a pan that happens
 * anyway is undone once it has stopped. A pan with no finger on the screen (iOS bringing the focused box into view) is
 * undone at once.
 */
export function followVisualViewport(viewport = window.visualViewport): () => void {
  if (viewport === null || viewport === undefined) return () => {};
  const root = document.documentElement;
  let fingers = 0;
  let settling: ReturnType<typeof setTimeout> | undefined;
  let unguard: (() => void) | null = null;
  const toTop = (): void => {
    if (window.scrollY !== 0 || viewport.offsetTop !== 0) window.scrollTo(0, 0);
  };
  /** Undoes a pan once nothing has moved the page for a moment and no finger is on the screen. */
  const settle = (): void => {
    clearTimeout(settling);
    settling = setTimeout(() => {
      settling = undefined;
      if (fingers === 0) toTop();
    }, PAN_SETTLE_MS);
  };
  const release = (): void => {
    root.style.removeProperty("--app-height");
    root.style.removeProperty("--app-bottom");
    unguard?.();
    unguard = null;
    clearTimeout(settling);
    settling = undefined;
    fingers = 0;
  };
  const update = (): void => {
    if (Math.abs(viewport.scale - 1) > 0.01) return;
    // The keyboard is up while the visual viewport is shorter than the layout viewport, whose height (the root's
    // `clientHeight`) the keyboard leaves alone. `innerHeight` does not do: a Home Screen app on iOS 27 reports it as
    // short as the visual viewport (478 of 812) the moment the keyboard opens.
    if (root.clientHeight - viewport.height > 1) {
      root.style.setProperty("--app-height", `${Math.round(viewport.height)}px`);
      root.style.setProperty("--app-bottom", "0px");
      unguard ??= guardTouches((count) => {
        fingers = count;
        if (count === 0) settle();
      });
      if (fingers > 0 || settling !== undefined) settle();
      else toTop();
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

/** How long the page must have been still, with no finger on the screen, before a pan of it is undone. */
export const PAN_SETTLE_MS = 150;

type Axis = "x" | "y";

/** What `scrollerAlong` reads of an element: its parent, its sizes and its overflow. */
interface Box {
  readonly parentElement: Box | null;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  readonly scrollWidth: number;
  readonly clientWidth: number;
}

/**
 * The nearest box from `target` up that scrolls along `axis` (its overflow lets it, and its content is larger than it),
 * short of the page itself; null when only the page would move.
 */
export function scrollerAlong(
  target: Box | null,
  axis: Axis,
  page: { readonly documentElement: unknown; readonly body: unknown } = document,
  overflowOf: (box: Box) => { readonly overflowX: string; readonly overflowY: string } = (box) =>
    getComputedStyle(box as unknown as Element),
): Box | null {
  for (let at = target; at !== null; at = at.parentElement) {
    if (at === page.documentElement || at === page.body) return null;
    const style = overflowOf(at);
    const overflow = axis === "y" ? style.overflowY : style.overflowX;
    if (overflow !== "auto" && overflow !== "scroll") continue;
    if (axis === "y" ? at.scrollHeight > at.clientHeight + 1 : at.scrollWidth > at.clientWidth + 1)
      return at;
  }
  return null;
}

/**
 * A drag the page must not stop: on the focused text field, where iOS moves the caret and the selection with a finger
 * (a pan it makes there is undone once it stops); on a text selection; on a slider.
 */
function adjusting(target: Element | null): boolean {
  if (target === null) return false;
  if (
    (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) &&
    target === document.activeElement
  )
    return true;
  const selection = document.getSelection();
  if (selection !== null && !selection.isCollapsed && selection.containsNode(target, true))
    return true;
  return target instanceof HTMLInputElement && target.type === "range";
}

/**
 * Stops a one-finger drag that no box can take along its direction, so that iOS does not pan the page (React Aria's
 * `usePreventScroll` on iOS does the same for its overlays). Boxes scroll as before, and they hand nothing on to the
 * page at their ends: the page's touch screens give every element `overscroll-behavior: contain` (`styles/index.css`).
 * `fingers` hears how many fingers are on the screen.
 */
function guardTouches(fingers: (count: number) => void): () => void {
  let start: { readonly x: number; readonly y: number; readonly target: Element | null } | null =
    null;
  const down = (event: TouchEvent): void => {
    fingers(event.touches.length);
    const touch = event.touches[0];
    const target = event.target instanceof Element ? event.target : null;
    start =
      touch === undefined || event.touches.length > 1 || adjusting(target)
        ? null
        : { x: touch.clientX, y: touch.clientY, target };
  };
  const move = (event: TouchEvent): void => {
    const touch = event.touches[0];
    if (start === null || touch === undefined || event.touches.length > 1 || !event.cancelable)
      return;
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    if (dx === 0 && dy === 0) return;
    const axis: Axis = Math.abs(dy) >= Math.abs(dx) ? "y" : "x";
    if (scrollerAlong(start.target, axis) === null) event.preventDefault();
  };
  const up = (event: TouchEvent): void => {
    if (event.touches.length === 0) start = null;
    fingers(event.touches.length);
  };
  document.addEventListener("touchstart", down, { capture: true, passive: true });
  document.addEventListener("touchmove", move, { capture: true, passive: false });
  document.addEventListener("touchend", up, { capture: true, passive: true });
  document.addEventListener("touchcancel", up, { capture: true, passive: true });
  return () => {
    document.removeEventListener("touchstart", down, { capture: true });
    document.removeEventListener("touchmove", move, { capture: true });
    document.removeEventListener("touchend", up, { capture: true });
    document.removeEventListener("touchcancel", up, { capture: true });
  };
}
