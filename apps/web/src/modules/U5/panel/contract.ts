import type { AbortSignalLike } from "@omp-app/contracts";
import { AppError as AppErrorSchema } from "@omp-app/contracts";
import { z } from "zod";

/** PanelShell lifecycle states every U5-kind panel must render explicitly. */
export const PanelLifecycle = z.enum([
  "closed",
  "loading",
  "empty",
  "populated",
  "updating",
  "unavailable",
  "error",
]);
export type PanelLifecycle = z.infer<typeof PanelLifecycle>;

export const PanelPosition = z.enum(["left", "right", "inline"]);
export type PanelPosition = z.infer<typeof PanelPosition>;

export const PanelOpenReason = z.enum(["trigger", "close-button", "escape", "programmatic"]);
export type PanelOpenReason = z.infer<typeof PanelOpenReason>;

/** Opaque invoking-focus token. U0 FocusScope owns how a token is captured/restored. */
export const PanelFocusToken = z.string().min(1);
export type PanelFocusToken = z.infer<typeof PanelFocusToken>;

export const PanelState = z.strictObject({
  open: z.boolean(),
  lifecycle: PanelLifecycle,
  position: PanelPosition,
  title: z.string().min(1),
  description: z.string().optional(),
  error: AppErrorSchema.nullable(),
  readOnly: z.boolean(),
  pendingUpdates: z.number().int().nonnegative(),
});
export type PanelState = z.infer<typeof PanelState>;

/** Data/slot contract consumed by U5.2's serving-independent PanelShell implementation. */
export interface PanelShellProps<Slot = unknown> {
  readonly state: PanelState;
  readonly onOpenChange: (open: boolean, reason: PanelOpenReason) => void;
  readonly invokingFocus?: PanelFocusToken;
  readonly restoreFocus?: (token: PanelFocusToken) => void;
  readonly toolbar?: Slot;
  readonly body: Slot;
  readonly footer?: Slot;
}

/** A panel action may be unavailable without making historical/read-only data disappear. */
export const PanelActionAvailability = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("available") }),
  z.strictObject({
    state: z.literal("unavailable"),
    reason: z.string().min(1),
    capability: z.string().min(1).optional(),
  }),
]);
export type PanelActionAvailability = z.infer<typeof PanelActionAvailability>;

export interface PanelRetryOptions {
  readonly signal?: AbortSignalLike;
}
