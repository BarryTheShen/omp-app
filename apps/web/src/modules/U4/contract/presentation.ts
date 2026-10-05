/**
 * Non-modal presentation handoffs (`modules/U4/README.md` rule 3; `research/modules/U4.md` §3.2).
 * `notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text` and `open_url` never steal
 * focus or block the composer. U4 normalizes the wire request into one of these; U1/N1/U0 own
 * placement and live-region policy for the resulting event.
 */

import type { OmpWire } from "@omp-app/contracts";
import { AppFailure } from "@omp-app/contracts";
import { z } from "zod";

const NotifyTypeSchema = z.enum(["info", "warning", "error"]);
export type NotifyType = z.infer<typeof NotifyTypeSchema>;

export const NotifyHandoffSchema = z.strictObject({
  kind: z.literal("notify"),
  message: z.string().min(1),
  notifyType: NotifyTypeSchema.optional(),
});

export const SetStatusHandoffSchema = z.strictObject({
  kind: z.literal("setStatus"),
  statusKey: z.string().min(1),
  statusText: z.string().min(1).optional(),
});

const WidgetPlacementSchema = z.enum(["aboveEditor", "belowEditor"]);
export type WidgetPlacement = z.infer<typeof WidgetPlacementSchema>;

export const SetWidgetHandoffSchema = z.strictObject({
  kind: z.literal("setWidget"),
  widgetKey: z.string().min(1),
  widgetLines: z.array(z.string()).optional(),
  widgetPlacement: WidgetPlacementSchema.optional(),
});

export const SetTitleHandoffSchema = z.strictObject({
  kind: z.literal("setTitle"),
  title: z.string().min(1),
});

export const SetEditorTextHandoffSchema = z.strictObject({
  kind: z.literal("set_editor_text"),
  /** May be empty: this handoff can clear the editor. */
  text: z.string(),
});

/**
 * `url` is the full address omp provided; it must never reach transcript content, telemetry,
 * error text, fixtures or browser history (`research/modules/U4.md` §6). Prefer `launchUrl` (a
 * short loopback redirect) as the display/copy target when present (`openUrlCopyTarget` below).
 */
export const OpenUrlHandoffSchema = z.strictObject({
  kind: z.literal("open_url"),
  url: z.string().min(1),
  launchUrl: z.string().min(1).optional(),
  instructions: z.string().min(1).optional(),
});
export type OpenUrlHandoff = z.infer<typeof OpenUrlHandoffSchema>;

export const PresentationHandoffSchema = z.discriminatedUnion("kind", [
  NotifyHandoffSchema,
  SetStatusHandoffSchema,
  SetWidgetHandoffSchema,
  SetTitleHandoffSchema,
  SetEditorTextHandoffSchema,
  OpenUrlHandoffSchema,
]);
export type PresentationHandoff = z.infer<typeof PresentationHandoffSchema>;

/**
 * The safe copy/display target for an `open_url` handoff: the short `launchUrl` when omp gave
 * one, the full `url` only otherwise. Callers must still keep the result out of transcript
 * content, telemetry, error text and fixtures (`research/modules/U4.md` §6 INFERENCE).
 */
export function openUrlCopyTarget(handoff: OpenUrlHandoff): string {
  return handoff.launchUrl ?? handoff.url;
}

/**
 * Converts one non-modal, non-cancel `extension_ui_request` into a `PresentationHandoff`. Throws
 * `AppFailure(internal)` for a modal or `cancel` method: callers classify first with
 * `classifyExtensionUiMethod` (`dialog.ts`).
 */
export function toPresentationHandoff(request: OmpWire.ExtensionUiRequest): PresentationHandoff {
  switch (request.method) {
    case "notify":
      return { kind: "notify", message: request.message, notifyType: request.notifyType };
    case "setStatus":
      return {
        kind: "setStatus",
        statusKey: request.statusKey,
        statusText: request.statusText,
      };
    case "setWidget":
      return {
        kind: "setWidget",
        widgetKey: request.widgetKey,
        widgetLines: request.widgetLines,
        widgetPlacement: request.widgetPlacement,
      };
    case "setTitle":
      return { kind: "setTitle", title: request.title };
    case "set_editor_text":
      return { kind: "set_editor_text", text: request.text };
    case "open_url":
      return {
        kind: "open_url",
        url: request.url,
        launchUrl: request.launchUrl,
        instructions: request.instructions,
      };
    default:
      throw new AppFailure({
        code: "internal",
        message: `Expected a presentation extension-UI request; got "${request.method}".`,
        retryable: false,
      });
  }
}
