import type { ProviderSignIn } from "@/modules/D3/contract";
import type { ModelDescriptor } from "../contract";

/** Where each sign-in sorts: a stored login, then an API key, then none. */
const SIGN_IN_RANK: Readonly<Record<ProviderSignIn, number>> = { login: 0, "api-key": 1, none: 2 };
/** A provider the app cannot tell how it is signed in sorts after every signed-in one. */
const UNKNOWN_RANK = 3;

function rank(model: ModelDescriptor): number {
  return model.signIn === undefined ? UNKNOWN_RANK : SIGN_IN_RANK[model.signIn];
}

/**
 * The models in the order the list shows them: signed-in providers first (a login, then an API key), then
 * the rest, and one provider's models together. Within a provider the order given is kept.
 */
export function orderBySignIn(models: readonly ModelDescriptor[]): ModelDescriptor[] {
  return [...models].sort(
    (left, right) => rank(left) - rank(right) || left.provider.localeCompare(right.provider),
  );
}

export interface ProviderGroup {
  readonly provider: string;
  readonly models: readonly ModelDescriptor[];
}

/** Consecutive models of one provider, in the order given (an `orderBySignIn` list keeps each provider whole). */
export function groupByProvider(models: readonly ModelDescriptor[]): ProviderGroup[] {
  const groups: { provider: string; models: ModelDescriptor[] }[] = [];
  for (const model of models) {
    const current = groups.at(-1);
    if (current?.provider === model.provider) current.models.push(model);
    else groups.push({ provider: model.provider, models: [model] });
  }
  return groups;
}
