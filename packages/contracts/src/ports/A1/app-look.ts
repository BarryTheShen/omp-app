import { z } from "zod";
import { definePort } from "../../core/envelope";
import { Revision } from "./shared";

/**
 * The app's look for every device (V258): what a device set to **Every device** in Settings → App shows and edits. A
 * device on **This device** keeps its own values in its browser and is not touched by these. Each value left out is
 * the app's own default there.
 */
export const AppLookValues = z.strictObject({
  /** Light, dark, or the system's. */
  themeMode: z.enum(["system", "light", "dark"]).optional(),
  /** The theme light shows (a theme's id, `styles/themes.css`). */
  themeLight: z.string().min(1).max(64).optional(),
  /** The theme dark shows. */
  themeDark: z.string().min(1).max(64).optional(),
  /** How the app is drawn (`theme/style.ts`). */
  style: z.string().min(1).max(32).optional(),
  /** Runs of tool calls drawn as one card. */
  groupTools: z.boolean().optional(),
  /** Hours a workspace may go unused before it closes, or never. */
  closeAfter: z.union([z.number().int().min(1).max(8760), z.literal("never")]).optional(),
});
export type AppLookValues = z.infer<typeof AppLookValues>;

export const AppLook = z.strictObject({ look: AppLookValues, revision: Revision });
export type AppLook = z.infer<typeof AppLook>;

export const AppLookSetArgs = z.strictObject({
  /** The whole look after the change: the caller reads, changes and writes it back. */
  look: AppLookValues,
  /** The revision the caller read; another device's change since is a retryable `conflict`. */
  expectedRevision: Revision,
});
export type AppLookSetArgs = z.infer<typeof AppLookSetArgs>;

export const AppLookStore = definePort({
  name: "A1.appLookStore",
  methods: {
    read: { args: z.strictObject({}), result: AppLook, capability: "host.app-look" },
    set: { args: AppLookSetArgs, result: AppLook, capability: "host.app-look" },
  },
  events: {
    /** The look after a change from any device. */
    changed: { payload: AppLook, capability: "host.app-look" },
  },
});
