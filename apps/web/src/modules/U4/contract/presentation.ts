/**
 * Non-modal presentation handoffs (`modules/U4/README.md` rule 3; `research/modules/U4.md` §3.2).
 * `notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text` and `open_url` never steal
 * focus or block the composer. U4 normalizes the chat host's UI event (`ui_notify`, `ui_status`, `ui_widget`, `ui_title`,
 * `ui_editor_text`, `ui_open_url`) into one of these; U1/N1/U0 own placement and live-region policy for the result.
 */

import type { UiPresentationEvent } from "@omp-app/contracts/chat-host";
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

/** Converts one of the chat host's UI events into a `PresentationHandoff`, keeping omp's fields. */
export function toPresentationHandoff(event: UiPresentationEvent): PresentationHandoff {
  switch (event.type) {
    case "ui_notify":
      return { kind: "notify", message: event.message, notifyType: event.notifyType };
    case "ui_status":
      return { kind: "setStatus", statusKey: event.statusKey, statusText: event.statusText };
    case "ui_widget":
      return {
        kind: "setWidget",
        widgetKey: event.widgetKey,
        widgetLines: event.widgetLines ? [...event.widgetLines] : undefined,
        widgetPlacement: event.widgetPlacement,
      };
    case "ui_title":
      return { kind: "setTitle", title: event.title };
    case "ui_editor_text":
      return { kind: "set_editor_text", text: event.text };
    case "ui_open_url":
      return {
        kind: "open_url",
        url: event.url,
        launchUrl: event.launchUrl,
        instructions: event.instructions,
      };
  }
}
