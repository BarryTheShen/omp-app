import type { HubModel, HubRole, ModelHub } from "@omp-app/contracts/chat-host";

/**
 * The thinking level an assignment keeps, as omp's hub picks it (`ModelHubComponent#assignRole`, `model-hub.ts`):
 * the role's own level when it has a model of its own, else `inherit`; and `inherit` when the new model cannot apply it.
 */
export function assignLevel(role: HubRole, model: HubModel): string {
  const kept =
    role.model !== null && !role.autoSelected && role.thinkingLevel !== null
      ? role.thinkingLevel
      : "inherit";
  return model.thinkingLevels.includes(kept) ? kept : "inherit";
}

/** A role's model as omp's Roles view writes it: `provider/id`, `auto → provider/id`, or `—` when none fits. */
export function roleValueText(role: HubRole): string {
  if (role.model === null) return "—";
  const selector = `${role.model.provider}/${role.model.modelId}`;
  return role.autoSelected ? `auto → ${selector}` : selector;
}

/** Whether a model's name or `provider/id` holds every word of a search. */
function matches(model: HubModel, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const text = `${model.name} ${model.provider}/${model.modelId}`.toLowerCase();
  return words.every((word) => text.includes(word));
}

/** The models a role takes, in the hub's order, matching every word of the search in their name or `provider/id`. */
export function modelsFor(hub: ModelHub, role: string, query: string): readonly HubModel[] {
  return hub.models.filter((model) => model.roles.includes(role) && matches(model, query));
}

/** omp's kinds of model, in its tab order, with its labels (`MODEL_KINDS`, `model-hub.ts:304-316`). */
export const KIND_LABELS: Readonly<Record<string, string>> = {
  chat: "Chat",
  tiny: "Tiny",
  image: "Image",
  tts: "TTS",
  stt: "STT",
  search: "Search",
  judge: "Judge",
  embedding: "Embedding",
  rerank: "Rerank",
  video: "Video",
};

/** A list of omp's Models view (#2838): the recent models, all of them, or one provider's. */
export type HubList =
  | { readonly kind: "recent" }
  | { readonly kind: "all" }
  | { readonly kind: "provider"; readonly id: string };

/** A list's models in its order (the recent ones newest first), of one kind or every kind (`all`), matching the search. */
export function modelsIn(
  hub: ModelHub,
  list: HubList,
  kind: string,
  query: string,
): readonly HubModel[] {
  const listed =
    list.kind === "recent"
      ? (hub.recent ?? []).flatMap((key) =>
          hub.models.filter((model) => `${model.provider}/${model.modelId}` === key),
        )
      : list.kind === "provider"
        ? hub.models.filter((model) => model.provider === list.id)
        : hub.models;
  return listed.filter((model) => (kind === "all" || model.kind === kind) && matches(model, query));
}

/** The kinds the models are of, in omp's tab order. */
export function kindsIn(models: readonly HubModel[]): readonly string[] {
  const present = new Set(models.map((model) => model.kind));
  return Object.keys(KIND_LABELS).filter((kind) => present.has(kind));
}

/** The roles in the hub's two groups, as omp lists them: the chat roles, then the other kinds of model. */
export function roleGroups(
  hub: ModelHub,
): readonly { readonly title: string; readonly roles: readonly HubRole[] }[] {
  const chat = hub.roles.filter((role) => role.section === "chat");
  const kinds = hub.roles.filter((role) => role.section === "kind");
  return [
    { title: "Chat", roles: chat },
    { title: "Kinds", roles: kinds },
  ].filter((group) => group.roles.length > 0);
}

/** A context window in a few characters: 200000 is "200k", 1048576 is "1M". */
export function windowText(tokens: number | null): string {
  if (tokens === null || tokens <= 0) return "";
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}

/** Whether a pane's Models dialog (omp's Alt+M) is open, and the role it opens at. */
export class ModelHubToggle {
  #open = false;
  #role: string | null = null;
  readonly #listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): boolean => this.#open;

  /** Opens it, at `role` when one is given (the model menu's "Roles and models…" names the chat's role). */
  show(role?: string): void {
    this.#role = role ?? null;
    this.#set(true);
  }

  /** The role asked for by the last `show`; null for the dialog's own choice. */
  roleAsked(): string | null {
    return this.#role;
  }

  hide(): void {
    this.#set(false);
  }

  toggle(): void {
    if (!this.#open) this.#role = null;
    this.#set(!this.#open);
  }

  #set(open: boolean): void {
    if (open === this.#open) return;
    this.#open = open;
    for (const listener of [...this.#listeners]) listener();
  }
}
