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

/** The models a role takes, in the hub's order, matching every word of the search in their name or `provider/id`. */
export function modelsFor(hub: ModelHub, role: string, query: string): readonly HubModel[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return hub.models.filter((model) => {
    if (!model.roles.includes(role)) return false;
    const text = `${model.name} ${model.provider}/${model.modelId}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
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

/** Whether a pane's Models dialog (omp's Alt+M) is open. */
export class ModelHubToggle {
  #open = false;
  readonly #listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): boolean => this.#open;

  show(): void {
    this.#set(true);
  }

  hide(): void {
    this.#set(false);
  }

  toggle(): void {
    this.#set(!this.#open);
  }

  #set(open: boolean): void {
    if (open === this.#open) return;
    this.#open = open;
    for (const listener of [...this.#listeners]) listener();
  }
}
