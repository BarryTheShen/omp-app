/**
 * The chat host's `get_model_menu`: the models the chat's model menu lists, in omp's own order. omp keeps no favorites
 * (the app keeps those, with the models hidden from the menu, in its own store); its model browser orders the available
 * models by role, then by its history of recently used models, then by provider and recency (`sortModelItems` in omp's
 * `overlays/model-browser.ts`). The menu takes that order without the role and history steps, so each provider's newest
 * models come first, and lists the history apart, as Recent.
 */
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { buildBrowserItems, sortModelItems } from "@oh-my-pi/pi-tui/overlays/model-browser";
import type { ModelMenu } from "@omp-app/contracts/chat-host";

/** How many of omp's recently used models the menu lists. */
const RECENT = 6;

export async function readModelMenu(session: AgentSession): Promise<ModelMenu> {
  await session.modelRegistry.awaitBackgroundRefresh();
  const items = buildBrowserItems(session.getAvailableModels());
  sortModelItems(items, { skipRoleRank: true, mruOrder: [] });
  const available = new Set(items.map((item) => item.selector));
  // omp's history keys each model as `provider/id`, as the items' selectors are (`agent-storage.ts`, `recordModelUsage`).
  const history = session.settings.getStorage()?.getModelUsageOrder() ?? [];
  return {
    models: items.map(({ model }) => ({
      provider: model.provider,
      modelId: model.id,
      name: model.name,
    })),
    recent: history.filter((key) => available.has(key)).slice(0, RECENT),
  };
}
