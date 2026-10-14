import type { DraftController } from "../../U2/drafts";

/**
 * The chat's composer draft as the interview uses it (U2.4, thread scope). The interview writes the text the person
 * has not sent into it, so that text is kept with the chat's other draft text.
 */
export interface GuidedComposerDraft {
  /** The text the composer holds now. */
  read(): string;
  /** Replaces the composer's text, keeps its attachments, and saves the draft. */
  write(text: string): Promise<void>;
}

/** The part of the chat's draft controller the interview uses. */
export type ComposerDraftController = Pick<DraftController, "flush" | "getSnapshot" | "setDraft">;

/**
 * The sink for the chat's composer draft. `controllerNow` is called at each read and write, because the draft hook
 * replaces its controller when the draft's scope changes: a controller held from earlier would be written to after it
 * stopped being the chat's draft.
 */
export function composerDraftOf(controllerNow: () => ComposerDraftController): GuidedComposerDraft {
  return {
    read: () => controllerNow().getSnapshot().text,
    write: async (text) => {
      const controller = controllerNow();
      controller.setDraft(text, [...controller.getSnapshot().attachments]);
      await controller.flush();
    },
  };
}

/** The reviewed goal as composer text: the objective, then the token budget when there is one. */
export function reviewedGoalText(review: {
  readonly objective: string;
  readonly tokenBudget: number | undefined;
}): string {
  return review.tokenBudget === undefined
    ? review.objective
    : `${review.objective}\n\nToken budget: ${review.tokenBudget} tokens`;
}
