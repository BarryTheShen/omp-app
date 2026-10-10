"use client";

import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Section, Toolbar } from "@/components/blocks";
import { Button } from "@/components/ui/button";
import { Dialog, DialogOverlay, DialogPortal } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { FocusScope, getTabbableElements } from "./focus-scope";
import {
  type FocusTarget,
  OVERLAY_GRAMMAR,
  OVERLAY_KINDS,
  OVERLAY_Z_INDEX,
  type OverlayCloseReason,
  type OverlayKind,
  type OverlayWidth,
} from "./grammar";

export type OverlayContent = ReactNode | ((controls: OverlayControls) => ReactNode);

export interface OverlayOpenOptions {
  readonly kind: OverlayKind;
  readonly content: OverlayContent;
  readonly closeOnEscape?: boolean;
  readonly closeOnOutsidePointer?: boolean;
  /** `move` focuses an interactive surface; `preserve` is the passive/toast behavior. */
  readonly focus?: "move" | "preserve";
  /** `false` disables restoration; omitted captures the focused opener. */
  readonly restoreFocus?: FocusTarget | false;
  readonly width?: OverlayWidth;
  readonly label?: string;
  readonly className?: string;
  /**
   * True while the content holds edits that closing would lose. An outside press, or the content's own
   * requestClose, then asks "Discard unsaved changes?" before a modal closes. Escape is unchanged.
   */
  readonly unsavedChanges?: boolean;
}

export interface OverlayControls {
  readonly id: string;
  readonly close: (reason?: OverlayCloseReason) => void;
  /** Closes the way an outside press does: a modal with unsaved changes asks first. */
  readonly requestClose: () => void;
  readonly update: (patch: Partial<Omit<OverlayOpenOptions, "kind">>) => void;
}

export interface OverlaySnapshot {
  readonly id: string;
  readonly kind: OverlayKind;
  readonly status: "queued" | "open";
  readonly closeOnEscape: boolean;
  readonly closeOnOutsidePointer: boolean;
  readonly focus: "move" | "preserve";
}

export interface OverlayOpenResult {
  readonly id: string;
  readonly closed: Promise<OverlayCloseReason>;
}

export interface OverlayHostApi {
  readonly overlays: readonly OverlaySnapshot[];
  readonly open: (options: OverlayOpenOptions) => OverlayOpenResult;
  readonly close: (id: string, reason?: OverlayCloseReason) => void;
  readonly closeTopmost: (reason?: OverlayCloseReason) => void;
  readonly update: (id: string, patch: Partial<Omit<OverlayOpenOptions, "kind">>) => void;
}

interface OverlayRecord extends OverlaySnapshot {
  readonly content: OverlayContent;
  readonly restoreFocus?: FocusTarget | false;
  readonly width?: OverlayWidth;
  readonly label?: string;
  readonly className?: string;
  readonly unsavedChanges: boolean;
  /** True while the discard question shows for this modal. */
  readonly askingToDiscard: boolean;
  readonly resolveClosed: (reason: OverlayCloseReason) => void;
}

const OverlayHostContext = createContext<OverlayHostApi | null>(null);
let nextOverlayId = 0;

function createOverlayId(): string {
  nextOverlayId += 1;
  return `overlay-${nextOverlayId}`;
}

function visibleOverlays(records: readonly OverlayRecord[]): OverlayRecord[] {
  return records.filter((record) => record.status === "open");
}

function getOverlayContent(record: OverlayRecord, controls: OverlayControls): ReactNode {
  return typeof record.content === "function" ? record.content(controls) : record.content;
}

function useReducedMotion(): boolean {
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(media.matches);
    update();
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);

  return reducedMotion;
}

function layerStyle(kind: OverlayKind, index: number): { zIndex: number } {
  const base = OVERLAY_Z_INDEX[kind];
  const step = kind === "modal" ? index * 2 : index;
  return { zIndex: base + step };
}

function widthClass(width: OverlayWidth): string {
  switch (width) {
    case "viewport":
      return "w-full max-w-lg";
    case "toast":
      return "w-full max-w-sm";
    case "content":
      return "w-fit max-w-sm";
  }
}
function defaultFocusMode(kind: OverlayKind): "move" | "preserve" {
  return OVERLAY_GRAMMAR[kind].focus === "preserve" ? "preserve" : "move";
}

function defaultCloseOnEscape(kind: OverlayKind): boolean {
  return OVERLAY_GRAMMAR[kind].escape === "close";
}

function defaultCloseOnOutsidePointer(kind: OverlayKind): boolean {
  return OVERLAY_GRAMMAR[kind].outsidePress === "close";
}

/** Within this many CSS pixels, a press and its release make a click, not a swipe or a drag. */
const OUTSIDE_CLICK_SLOP_PX = 10;

function OverlayView({
  record,
  index,
  onClose,
  onUpdate,
  onRequestClose,
  onKeepEditing,
  onInside,
}: {
  record: OverlayRecord;
  index: number;
  onClose: (id: string, reason?: OverlayCloseReason) => void;
  onUpdate: (id: string, patch: Partial<Omit<OverlayOpenOptions, "kind">>) => void;
  onRequestClose: (id: string, reason: OverlayCloseReason) => void;
  onKeepEditing: (id: string) => void;
  /** Reports a press that belongs to this overlay, so the host does not read it as an outside press. */
  onInside: (event: Event) => void;
}) {
  const reducedMotion = useReducedMotion();
  const questionId = useId();
  const popupRef = useRef<HTMLDivElement>(null);
  const controls = useMemo<OverlayControls>(
    () => ({
      id: record.id,
      close: (reason = "programmatic") => onClose(record.id, reason),
      requestClose: () => onRequestClose(record.id, "programmatic"),
      update: (patch) => onUpdate(record.id, patch),
    }),
    [onClose, onRequestClose, onUpdate, record.id],
  );
  const content = getOverlayContent(record, controls);
  const grammar = OVERLAY_GRAMMAR[record.kind];
  const focus = record.focus === "move";
  const sharedClassName = cn(
    "isolate max-h-[80dvh] overflow-y-auto outline-none motion-reduce:transition-none",
    widthClass(record.width ?? grammar.width),
    record.className,
  );
  const dataProps = {
    "data-overlay-id": record.id,
    "data-overlay-kind": record.kind,
    "data-overlay-status": record.status,
    "data-overlay-unsaved": record.unsavedChanges ? "true" : undefined,
    "data-reduced-motion": reducedMotion ? "true" : undefined,
  } as const;
  if (record.kind === "modal") {
    const closeFromDialog = (open: boolean, details: { reason: string; cancel: () => void }) => {
      if (open) return;
      if (details.reason === "escapeKey" && !record.closeOnEscape) {
        details.cancel();
        return;
      }
      if (details.reason === "outsidePress" && !record.closeOnOutsidePointer) {
        details.cancel();
        return;
      }
      const reason: OverlayCloseReason =
        details.reason === "escapeKey"
          ? "escape"
          : details.reason === "outsidePress"
            ? "outside-press"
            : "programmatic";
      onClose(record.id, reason);
    };

    // The host decides every outside press, one on the dimmed backdrop included. The base dialog never
    // dismisses by itself: it would close without asking about unsaved changes.
    return (
      <Dialog open modal={false} disablePointerDismissal onOpenChange={closeFromDialog}>
        <DialogPortal>
          <DialogOverlay
            {...dataProps}
            className="bg-foreground/15 motion-reduce:transition-none"
            style={layerStyle(record.kind, index)}
          />
          <DialogPrimitive.Popup
            {...dataProps}
            ref={popupRef}
            role="dialog"
            aria-modal="true"
            aria-label={record.label}
            initialFocus={false}
            finalFocus={false}
            onPointerDown={(event) => onInside(event.nativeEvent)}
            onPointerUp={(event) => onInside(event.nativeEvent)}
            className={cn(
              "fixed top-1/2 left-1/2 grid -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl border border-border bg-popover p-4 text-sm text-popover-foreground shadow-overlay ring-1 ring-foreground/10 outline-none motion-reduce:transition-none",
              sharedClassName,
            )}
            style={layerStyle(record.kind, index + 1)}
          >
            <FocusScope
              trapped={!record.askingToDiscard}
              initialFocus={focus ? undefined : false}
              restoreFocus={record.restoreFocus}
            >
              {content}
            </FocusScope>
          </DialogPrimitive.Popup>
          {record.askingToDiscard ? (
            <div
              {...dataProps}
              className="fixed inset-0 flex items-center justify-center p-4"
              style={layerStyle(record.kind, index + 2)}
              onPointerDown={(event) => onInside(event.nativeEvent)}
              onPointerUp={(event) => onInside(event.nativeEvent)}
            >
              <FocusScope
                trapped
                restoreFocus={() => {
                  const popup = popupRef.current;
                  return popup ? (getTabbableElements(popup)[0] ?? popup) : null;
                }}
              >
                <div
                  role="alertdialog"
                  aria-modal="true"
                  aria-labelledby={questionId}
                  className="w-full max-w-sm rounded-xl border border-border bg-popover p-4 text-popover-foreground shadow-overlay"
                >
                  <Section
                    heading="Discard unsaved changes?"
                    headingId={questionId}
                    variant="dialog"
                    description="Closing now loses the changes you have not saved."
                  >
                    <Toolbar ariaLabel="Unsaved changes" alignment="end">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => onKeepEditing(record.id)}
                      >
                        Keep editing
                      </Button>
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        onClick={() => onClose(record.id, "programmatic")}
                      >
                        Discard changes
                      </Button>
                    </Toolbar>
                  </Section>
                </div>
              </FocusScope>
            </div>
          ) : null}
        </DialogPortal>
      </Dialog>
    );
  }

  const surfaceSemantics =
    record.kind === "toast"
      ? { role: "status" as const, "aria-live": "polite" as const }
      : record.kind === "menu"
        ? { role: "menu" as const }
        : { role: "dialog" as const };
  const surface = (
    <div
      {...dataProps}
      {...surfaceSemantics}
      className={cn(
        "border-border bg-popover text-popover-foreground shadow-overlay motion-reduce:transition-none",
        record.kind === "toast" && "pointer-events-auto",
        sharedClassName,
      )}
      onPointerDown={(event) => onInside(event.nativeEvent)}
      onPointerUp={(event) => onInside(event.nativeEvent)}
      style={layerStyle(record.kind, index)}
    >
      {record.kind === "toast" ? (
        content
      ) : (
        <FocusScope
          trapped={false}
          initialFocus={focus ? undefined : false}
          restoreFocus={record.restoreFocus}
        >
          {content}
        </FocusScope>
      )}
    </div>
  );

  return (
    <div className="pointer-events-none fixed inset-0 flex items-start justify-end p-4">
      {surface}
    </div>
  );
}

export function OverlayHost({ children }: { readonly children: ReactNode }) {
  const [records, setRecords] = useState<OverlayRecord[]>([]);
  const [portal, setPortal] = useState<HTMLDivElement | null>(null);
  // Every change is written here at once, and the state follows. Reading the records inside a state
  // updater would lag behind: a press that lands before React renders a change (a flag reported from
  // an effect, say) must still see that change.
  const recordsRef = useRef<OverlayRecord[]>([]);
  const backgroundRef = useRef<HTMLDivElement>(null);
  const commit = useCallback((next: OverlayRecord[]) => {
    recordsRef.current = next;
    setRecords(next);
  }, []);

  const update = useCallback(
    (id: string, patch: Partial<Omit<OverlayOpenOptions, "kind">>) => {
      commit(
        recordsRef.current.map((record) => {
          if (record.id !== id) return record;
          return {
            ...record,
            ...patch,
            closeOnEscape: patch.closeOnEscape ?? record.closeOnEscape,
            closeOnOutsidePointer: patch.closeOnOutsidePointer ?? record.closeOnOutsidePointer,
            focus: patch.focus ?? record.focus,
          };
        }),
      );
    },
    [commit],
  );

  const close = useCallback(
    (id: string, reason: OverlayCloseReason = "programmatic") => {
      const current = recordsRef.current;
      const target = current.find((record) => record.id === id);
      if (!target) return;
      const remaining = current.filter((record) => record.id !== id);
      const shouldPromote = target.kind === "modal" && target.status === "open";
      const nextModal = shouldPromote
        ? remaining.find((record) => record.kind === "modal" && record.status === "queued")
        : undefined;
      commit(
        nextModal
          ? remaining.map((record) =>
              record.id === nextModal.id ? { ...record, status: "open" as const } : record,
            )
          : remaining,
      );
      queueMicrotask(() => target.resolveClosed(reason));
    },
    [commit],
  );

  const closeTopmost = useCallback(
    (reason: OverlayCloseReason = "programmatic") => {
      const visible = visibleOverlays(recordsRef.current);
      const topmost = visible[visible.length - 1];
      if (topmost) close(topmost.id, reason);
    },
    [close],
  );

  // A press on a surface of an overlay (the dialog, its popups, the toasts) is not an outside press.
  // React reports a press from a popup that the dialog opened into a portal through the component
  // tree, so this does not depend on where that popup sits in the DOM. The listener reads the mark.
  const insideEventRef = useRef<Event | null>(null);
  const markInside = useCallback((event: Event) => {
    insideEventRef.current = event;
  }, []);

  const requestClose = useCallback(
    (id: string, reason: OverlayCloseReason) => {
      const target = recordsRef.current.find((record) => record.id === id);
      if (!target || target.askingToDiscard) return;
      if (!target.unsavedChanges) {
        close(id, reason);
        return;
      }
      commit(
        recordsRef.current.map((record) =>
          record.id === id ? { ...record, askingToDiscard: true } : record,
        ),
      );
    },
    [close, commit],
  );

  const keepEditing = useCallback(
    (id: string) => {
      commit(
        recordsRef.current.map((record) =>
          record.id === id ? { ...record, askingToDiscard: false } : record,
        ),
      );
    },
    [commit],
  );

  const open = useCallback(
    (options: OverlayOpenOptions): OverlayOpenResult => {
      const id = createOverlayId();
      let resolvePromise!: (reason: OverlayCloseReason) => void;
      let settled = false;
      const closed = new Promise<OverlayCloseReason>((resolve) => {
        resolvePromise = resolve;
      });
      const resolveClosed = (reason: OverlayCloseReason) => {
        if (settled) return;
        settled = true;
        resolvePromise(reason);
      };
      const current = recordsRef.current;
      const hasOpenModal = current.some(
        (record) => record.kind === "modal" && record.status === "open",
      );
      const record: OverlayRecord = {
        id,
        kind: options.kind,
        status: options.kind === "modal" && hasOpenModal ? "queued" : "open",
        content: options.content,
        closeOnEscape: options.closeOnEscape ?? defaultCloseOnEscape(options.kind),
        closeOnOutsidePointer:
          options.closeOnOutsidePointer ?? defaultCloseOnOutsidePointer(options.kind),
        focus: options.focus ?? defaultFocusMode(options.kind),
        restoreFocus: options.restoreFocus,
        width: options.width,
        label: options.label,
        className: options.className,
        unsavedChanges: options.unsavedChanges ?? false,
        askingToDiscard: false,
        resolveClosed,
      };
      commit([...current, record]);
      return { id, closed };
    },
    [commit],
  );

  const hasOpenModal = records.some(
    (record) => record.kind === "modal" && record.status === "open",
  );
  const visible = visibleOverlays(records);
  const api = useMemo<OverlayHostApi>(
    () => ({
      overlays: records.map(
        ({ id, kind, status, closeOnEscape, closeOnOutsidePointer, focus }) => ({
          id,
          kind,
          status,
          closeOnEscape,
          closeOnOutsidePointer,
          focus,
        }),
      ),
      open,
      close,
      closeTopmost,
      update,
    }),
    [close, closeTopmost, open, records, update],
  );

  useLayoutEffect(() => {
    const background = backgroundRef.current;
    if (!background) return;
    background.inert = hasOpenModal;
    if (hasOpenModal) background.setAttribute("aria-hidden", "true");
    else background.removeAttribute("aria-hidden");
  }, [hasOpenModal]);

  useLayoutEffect(() => {
    if (!hasOpenModal) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [hasOpenModal]);

  useLayoutEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const topmost = visibleOverlays(recordsRef.current).at(-1);
      if (!topmost?.closeOnEscape) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      // While the discard question is up, Escape answers it with the safe choice. Otherwise Escape
      // closes the topmost overlay as it always has, with or without unsaved changes.
      if (topmost.askingToDiscard) keepEditing(topmost.id);
      else close(topmost.id, "escape");
    };
    // A press that starts outside the topmost overlay closes it on release, when the press is a click with
    // the primary button: a swipe, a drag, or a right or middle click does not. Closing on press would take
    // the overlay away under the pointer, so the focus and the click that follow would land on the page
    // behind it. A modal's release click is swallowed too, so it cannot reach whatever is under the pointer.
    // Bubble phase: React has marked the presses that belong to an overlay before these listeners run.
    let press: { id: string; x: number; y: number; drifted: boolean } | null = null;
    const handlePointerDown = (event: PointerEvent) => {
      const topmost = visibleOverlays(recordsRef.current).at(-1);
      press =
        topmost?.closeOnOutsidePointer && insideEventRef.current !== event && event.button === 0
          ? { id: topmost.id, x: event.clientX, y: event.clientY, drifted: false }
          : null;
    };
    const handlePointerMove = (event: PointerEvent) => {
      if (press === null) return;
      if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > OUTSIDE_CLICK_SLOP_PX) {
        press.drifted = true;
      }
    };
    const handlePointerUp = (event: PointerEvent) => {
      const current = press;
      press = null;
      if (current === null || insideEventRef.current === event || event.button !== 0) return;
      const moved = Math.hypot(event.clientX - current.x, event.clientY - current.y);
      if (current.drifted || moved > OUTSIDE_CLICK_SLOP_PX) return;
      const topmost = visibleOverlays(recordsRef.current).at(-1);
      if (topmost?.id !== current.id) return;
      if (topmost.kind === "modal") {
        // A modal's press began on its backdrop, which the release now uncovers: the click the release
        // makes must not reach the page behind it. A popover's click still reaches what was pressed.
        const swallowClick = (click: MouseEvent) => {
          click.preventDefault();
          click.stopPropagation();
        };
        document.addEventListener("click", swallowClick, { capture: true, once: true });
        window.setTimeout(() => document.removeEventListener("click", swallowClick, true), 0);
      }
      requestClose(current.id, "outside-press");
    };
    const handlePointerCancel = () => {
      press = null;
    };
    document.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("pointermove", handlePointerMove);
    document.addEventListener("pointerup", handlePointerUp);
    document.addEventListener("pointercancel", handlePointerCancel);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("pointermove", handlePointerMove);
      document.removeEventListener("pointerup", handlePointerUp);
      document.removeEventListener("pointercancel", handlePointerCancel);
    };
  }, [close, keepEditing, requestClose]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const nextPortal = document.createElement("div");
    nextPortal.dataset.overlayPortal = "true";
    document.body.appendChild(nextPortal);
    setPortal(nextPortal);
    return () => {
      nextPortal.remove();
      setPortal(null);
      for (const record of recordsRef.current) record.resolveClosed("unmount");
    };
  }, []);
  return (
    <OverlayHostContext.Provider value={api}>
      <div ref={backgroundRef} data-overlay-background="true">
        {children}
      </div>
      {portal
        ? createPortal(
            <div data-overlay-stack="true">
              {visible.map((record, index) => (
                <OverlayView
                  key={record.id}
                  record={record}
                  index={index}
                  onClose={close}
                  onUpdate={update}
                  onRequestClose={requestClose}
                  onKeepEditing={keepEditing}
                  onInside={markInside}
                />
              ))}
            </div>,
            portal,
          )
        : null}
    </OverlayHostContext.Provider>
  );
}

export function useOverlayHost(): OverlayHostApi {
  const context = useContext(OverlayHostContext);
  if (!context) throw new Error("useOverlayHost must be used inside OverlayHost");
  return context;
}

/**
 * The overlay API with an identity that never changes. `useOverlayHost()` returns a new object
 * every time any overlay opens, closes or updates, so a controller built from it (and disposed in
 * an effect keyed on it) is torn down whenever anything else opens. Long-lived controllers, such as
 * the dialog host and the extension-UI router, take this handle instead: each call goes to the
 * latest API.
 */
export function useStableOverlayHost(): OverlayHostApi {
  const overlay = useOverlayHost();
  const latest = useRef(overlay);
  useLayoutEffect(() => {
    latest.current = overlay;
  });
  return useMemo<OverlayHostApi>(
    () => ({
      get overlays() {
        return latest.current.overlays;
      },
      open: (options) => latest.current.open(options),
      close: (id, reason) => latest.current.close(id, reason),
      closeTopmost: (reason) => latest.current.closeTopmost(reason),
      update: (id, patch) => latest.current.update(id, patch),
    }),
    [],
  );
}

export { OVERLAY_KINDS };
