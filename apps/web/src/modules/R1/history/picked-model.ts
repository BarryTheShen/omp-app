import { ModelChoice, type ThreadId } from "@omp-app/contracts";

/**
 * The model a person picked to open a chat omp could not restore, kept in this browser by chat. When omp refuses the
 * chat's saved model again (after a server restart, say), the chat opens with the model picked for it. A chat whose
 * saved model can still be restored is never changed by this.
 */
const STORAGE_KEY = "omp-app.picked-models";

function readAll(): Record<string, ModelChoice> {
  let raw: string | null;
  try {
    raw = globalThis.localStorage.getItem(STORAGE_KEY);
  } catch (error) {
    console.error("[omp-app] could not read the models picked for chats", error);
    return {};
  }
  if (raw === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  const models: Record<string, ModelChoice> = {};
  if (typeof parsed !== "object" || parsed === null) return models;
  for (const [threadId, value] of Object.entries(parsed)) {
    const choice = ModelChoice.safeParse(value);
    if (choice.success) models[threadId] = choice.data;
  }
  return models;
}

/** Remembers the model a chat was opened with after omp refused its saved model. */
export function rememberPickedModel(threadId: ThreadId, model: ModelChoice): void {
  try {
    globalThis.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...readAll(), [threadId]: model }),
    );
  } catch (error) {
    console.error("[omp-app] could not remember the model picked for a chat", error);
  }
}

/** The model picked for this chat, or undefined when none was picked. */
export function pickedModelFor(threadId: ThreadId): ModelChoice | undefined {
  return readAll()[threadId];
}
