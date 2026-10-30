import { z } from "zod";
import { definePort } from "../../core/envelope";
import { Revision } from "./shared";

/**
 * A model as omp names it, `provider/id` (its model browser's selector, `buildBrowserItems`); an id may hold more
 * slashes (`openrouter/anthropic/...`).
 */
export const ModelKey = z
  .string()
  .min(3)
  .max(512)
  .regex(/^[^/\s]+\/\S+$/);
export type ModelKey = z.infer<typeof ModelKey>;

/**
 * How the person keeps the model menu: the models they starred and the ones they hid. The app's own, kept on its
 * server, so every device that opens it lists the models the same way; omp has no favorites or hidden models.
 */
export const ModelPreferences = z.strictObject({
  /** Starred models, in the order they were starred. A starred model is never hidden. */
  favorites: z.array(ModelKey),
  /** Models kept out of the menu's lists (still found under Hidden). A hidden model is never starred. */
  hidden: z.array(ModelKey),
  revision: Revision,
});
export type ModelPreferences = z.infer<typeof ModelPreferences>;

export const ModelPreferenceSetArgs = z.strictObject({
  model: ModelKey,
  /** Star or unstar it; starring a hidden model shows it again. */
  favorite: z.boolean().optional(),
  /** Hide or show it; hiding a starred model unstars it. */
  hidden: z.boolean().optional(),
  /** The revision the caller read (a read gives one also before anything is saved). Another device's change is a `conflict`. */
  expectedRevision: Revision,
});
export type ModelPreferenceSetArgs = z.infer<typeof ModelPreferenceSetArgs>;

/**
 * The stars and hidden models after a change, the one rule the server saves by and a page shows a change by at once:
 * starring a hidden model shows it, hiding a starred one unstars it, a model starred (or hidden) again keeps its place,
 * and a new one goes last.
 */
export function applyModelPreferenceChange(
  preferences: { readonly favorites: readonly string[]; readonly hidden: readonly string[] },
  model: string,
  change: { readonly favorite?: boolean; readonly hidden?: boolean },
): { favorites: string[]; hidden: string[] } {
  const starred = preferences.favorites.includes(model);
  const wasHidden = preferences.hidden.includes(model);
  const favorite = change.favorite ?? (change.hidden === true ? false : starred);
  const hidden = change.hidden ?? (change.favorite === true ? false : wasHidden);
  const place = (keys: readonly string[], keep: boolean, had: boolean): string[] =>
    keep ? (had ? [...keys] : [...keys, model]) : keys.filter((key) => key !== model);
  return {
    favorites: place(preferences.favorites, favorite, starred),
    hidden: place(preferences.hidden, hidden, wasHidden),
  };
}

export const ModelPreferenceStore = definePort({
  name: "A1.modelPreferenceStore",
  methods: {
    read: {
      args: z.strictObject({}),
      result: ModelPreferences,
      capability: "host.model-preferences",
    },
    set: {
      args: ModelPreferenceSetArgs,
      result: ModelPreferences,
      capability: "host.model-preferences",
    },
  },
  events: {
    /** The preferences after a change from any device. */
    changed: {
      payload: ModelPreferences,
      capability: "host.model-preferences",
    },
  },
});
