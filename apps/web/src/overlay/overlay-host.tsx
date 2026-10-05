"use client";

import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Dialog, DialogOverlay, DialogPortal } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { FocusScope } from "./focus-scope";
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
}

export interface OverlayControls {
  readonly id: string;
  readonly close: (reason?: OverlayCloseReason) => void;
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

function OverlayView({
  record,
  index,
  onClose,
  onUpdate,
}: {
  record: OverlayRecord;
  index: number;
  onClose: (id: string, reason?: OverlayCloseReason) => void;
  onUpdate: (id: string, patch: Partial<Omit<OverlayOpenOptions, "kind">>) => void;
}) {
  const reducedMotion = useReducedMotion();
  const controls = useMemo<OverlayControls>(
    () => ({
      id: record.id,
      close: (reason = "programmatic") => onClose(record.id, reason),
      update: (patch) => onUpdate(record.id, patch),
    }),
    [onClose, onUpdate, record.id],
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

    return (
      <Dialog
        open
        modal={false}
        disablePointerDismissal={!record.closeOnOutsidePointer}
        onOpenChange={closeFromDialog}
      >
        <DialogPortal>
          <DialogOverlay
            {...dataProps}
            className="bg-foreground/15 motion-reduce:transition-none"
            style={layerStyle(record.kind, index)}
            onPointerDown={() => {
              if (record.closeOnOutsidePointer) onClose(record.id, "outside-press");
            }}
          />
          <DialogPrimitive.Popup
            {...dataProps}
            role="dialog"
            aria-modal="true"
            aria-label={record.label}
            initialFocus={false}
            finalFocus={false}
            className={cn(
              "fixed top-1/2 left-1/2 grid -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl border border-border bg-popover p-4 text-sm text-popover-foreground shadow-overlay ring-1 ring-foreground/10 outline-none motion-reduce:transition-none",
              sharedClassName,
            )}
            style={layerStyle(record.kind, index + 1)}
          >
            <FocusScope
              trapped
              initialFocus={focus ? undefined : false}
              restoreFocus={record.restoreFocus}
            >
              {content}
            </FocusScope>
          </DialogPrimitive.Popup>
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
  const recordsRef = useRef<OverlayRecord[]>([]);
  const backgroundRef = useRef<HTMLDivElement>(null);
  const recordsWithRef = useCallback((next: OverlayRecord[]) => {
    recordsRef.current = next;
    return next;
  }, []);

  const update = useCallback(
    (id: string, patch: Partial<Omit<OverlayOpenOptions, "kind">>) => {
      setRecords((current) =>
        recordsWithRef(
          current.map((record) => {
            if (record.id !== id) return record;
            return {
              ...record,
              ...patch,
              closeOnEscape: patch.closeOnEscape ?? record.closeOnEscape,
              closeOnOutsidePointer: patch.closeOnOutsidePointer ?? record.closeOnOutsidePointer,
              focus: patch.focus ?? record.focus,
            };
          }),
        ),
      );
    },
    [recordsWithRef],
  );

  const close = useCallback(
    (id: string, reason: OverlayCloseReason = "programmatic") => {
      const target = recordsRef.current.find((record) => record.id === id);
      if (!target) return;
      setRecords((current) => {
        const currentTarget = current.find((record) => record.id === id);
        if (!currentTarget) return current;
        const remaining = current.filter((record) => record.id !== id);
        const shouldPromote = currentTarget.kind === "modal" && currentTarget.status === "open";
        if (shouldPromote) {
          const nextModal = remaining.find(
            (record) => record.kind === "modal" && record.status === "queued",
          );
          if (nextModal) {
            return recordsWithRef(
              remaining.map((record) =>
                record.id === nextModal.id ? { ...record, status: "open" as const } : record,
              ),
            );
          }
        }
        return recordsWithRef(remaining);
      });
      queueMicrotask(() => target.resolveClosed(reason));
    },
    [recordsWithRef],
  );

  const closeTopmost = useCallback(
    (reason: OverlayCloseReason = "programmatic") => {
      const visible = visibleOverlays(recordsRef.current);
      const topmost = visible[visible.length - 1];
      if (topmost) close(topmost.id, reason);
    },
    [close],
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
      setRecords((current) => {
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
          resolveClosed,
        };
        return recordsWithRef([...current, record]);
      });
      return { id, closed };
    },
    [recordsWithRef],
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
      close(topmost.id, "escape");
    };
    const handlePointerDown = (event: PointerEvent) => {
      const topmost = visibleOverlays(recordsRef.current).at(-1);
      if (!topmost?.closeOnOutsidePointer) return;
      const target = event.target;
      if (!(target instanceof Node)) return;
      const inside =
        target instanceof Element && target.closest(`[data-overlay-id="${topmost.id}"]`);
      if (!inside) close(topmost.id, "outside-press");
    };
    document.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("pointerdown", handlePointerDown, true);
    };
  }, [close]);

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

export { OVERLAY_KINDS };
