import type { ChatModel } from "../chat/store";

/** How many of omp's recently used models the menu lists. */
const RECENT = 5;

/** A model as omp names it and the menu keeps its stars and hidden models: `provider/id`. */
export const modelKey = (model: Pick<ChatModel, "provider" | "id">): string =>
  `${model.provider}/${model.id}`;

export interface MenuSection {
  /** `favorites`, `recent`, `hidden`, or `provider:<id>`. */
  readonly key: string;
  readonly heading: string;
  readonly models: readonly ChatModel[];
}

/**
 * What the model menu lists, in order. Without a search: Favorites (in the order they were starred), Recent (omp's
 * history, newest first, without the starred ones), then each provider's models newest first (the server's order),
 * all without the hidden models, which come last on their own. A search keeps the providers' models and the hidden
 * ones that match every word, in the name or in `provider/id`; Favorites and Recent would only repeat them.
 */
export function menuSections(input: {
  readonly models: readonly ChatModel[];
  readonly recent: readonly string[];
  readonly favorites: readonly string[];
  readonly hidden: readonly string[];
  readonly query: string;
}): { readonly sections: readonly MenuSection[]; readonly hidden: readonly ChatModel[] } {
  const words = input.query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== "");
  const matches = (model: ChatModel): boolean => {
    const text = `${model.name} ${modelKey(model)}`.toLowerCase();
    return words.every((word) => text.includes(word));
  };
  const byKey = new Map(input.models.map((model) => [modelKey(model), model]));
  const hiddenKeys = new Set(input.hidden);
  const shown = input.models.filter((model) => !hiddenKeys.has(modelKey(model)) && matches(model));
  const hidden = input.models.filter((model) => hiddenKeys.has(modelKey(model)) && matches(model));

  const sections: MenuSection[] = [];
  if (words.length === 0) {
    const starred = input.favorites.flatMap((key) => {
      const model = byKey.get(key);
      return model === undefined || hiddenKeys.has(key) ? [] : [model];
    });
    if (starred.length > 0)
      sections.push({ key: "favorites", heading: "Favorites", models: starred });
    const starredKeys = new Set(input.favorites);
    const recent = input.recent
      .filter((key) => !starredKeys.has(key) && !hiddenKeys.has(key))
      .flatMap((key) => {
        const model = byKey.get(key);
        return model === undefined ? [] : [model];
      })
      .slice(0, RECENT);
    if (recent.length > 0) sections.push({ key: "recent", heading: "Recent", models: recent });
  }
  const providers = new Map<string, ChatModel[]>();
  for (const model of shown) {
    const group = providers.get(model.provider);
    if (group === undefined) providers.set(model.provider, [model]);
    else group.push(model);
  }
  for (const [provider, models] of providers) {
    sections.push({ key: `provider:${provider}`, heading: provider, models });
  }
  return { sections, hidden };
}
