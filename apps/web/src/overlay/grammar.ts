/**
 * U0 overlay grammar (Plan item 4).
 *
 * One host owns the stack for dialogs, popovers, menus and toasts. Modal requests are serialized
 * FIFO (one active modal at a time), trap focus, lock page scrolling and make the background inert.
 * Dialogs and interactive non-modal overlays close on an outside press, a press on the dimmed backdrop
 * included; a dialog with unsaved changes asks first. Toasts are passive: they preserve focus and never
 * close another overlay. Escape always targets the topmost visible overlay, and each overlay's rule
 * decides whether that close is allowed.
 *
 * The z-index values come from U0.2's typed token mirror; components never invent raw layers.
 */
import { type ZIndexToken, zIndexTokens } from "@/tokens";

export const OVERLAY_KINDS = ["modal", "popover", "menu", "toast"] as const;
export type OverlayKind = (typeof OVERLAY_KINDS)[number];

export const OVERLAY_FOCUS_MODES = ["move", "preserve", "trap"] as const;
export type OverlayFocusMode = (typeof OVERLAY_FOCUS_MODES)[number];

export const OVERLAY_DISMISSAL_MODES = ["close", "ignore"] as const;
export type OverlayDismissalMode = (typeof OVERLAY_DISMISSAL_MODES)[number];

export const OVERLAY_WIDTHS = ["viewport", "content", "toast"] as const;
export type OverlayWidth = (typeof OVERLAY_WIDTHS)[number];

export interface OverlayRule {
  readonly zIndex: ZIndexToken;
  readonly focus: OverlayFocusMode;
  readonly outsidePress: OverlayDismissalMode;
  readonly escape: OverlayDismissalMode;
  readonly scrollLock: boolean;
  readonly inertBackground: boolean;
  readonly passive: boolean;
  readonly width: OverlayWidth;
}

/** The normative stacking, focus and dismissal grammar consumed by `OverlayHost`. */
export const OVERLAY_GRAMMAR = {
  modal: {
    zIndex: "modal",
    focus: "trap",
    outsidePress: "close",
    escape: "close",
    scrollLock: true,
    inertBackground: true,
    passive: false,
    width: "viewport",
  },
  popover: {
    zIndex: "popover",
    focus: "move",
    outsidePress: "close",
    escape: "close",
    scrollLock: false,
    inertBackground: false,
    passive: false,
    width: "content",
  },
  menu: {
    zIndex: "popover",
    focus: "move",
    outsidePress: "close",
    escape: "close",
    scrollLock: false,
    inertBackground: false,
    passive: false,
    width: "content",
  },
  toast: {
    zIndex: "toast",
    focus: "preserve",
    outsidePress: "ignore",
    escape: "close",
    scrollLock: false,
    inertBackground: false,
    passive: true,
    width: "toast",
  },
} as const satisfies Record<OverlayKind, OverlayRule>;

/** Numeric layer values are token-backed; creation order is added for deterministic nesting. */
export const OVERLAY_Z_INDEX = {
  modal: zIndexTokens.modal,
  popover: zIndexTokens.popover,
  menu: zIndexTokens.popover,
  toast: zIndexTokens.toast,
} as const satisfies Record<OverlayKind, number>;

/** A DOM element or lazy lookup supplied by a feature when it knows where focus should return. */
export type FocusTarget = HTMLElement | null | (() => HTMLElement | null);

export type OverlayCloseReason = "escape" | "outside-press" | "programmatic" | "unmount";
