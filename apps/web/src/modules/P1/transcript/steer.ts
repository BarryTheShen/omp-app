import type { AppFailure } from "@omp-app/contracts";

/** Two Left presses this close together, on an empty draft, return toward the Hub. */
export const LEFT_LEFT_WINDOW_MS = 600;

/** The steer editor's state. The text is kept on every failure, so typed words are never lost. */
export interface SteerDraft {
  readonly text: string;
  /** A send is in flight; another one is not started meanwhile. */
  readonly sending: boolean;
  /** Why the last send failed, in plain words. */
  readonly failure: string | undefined;
  /** When the last Left was pressed on an empty draft, for the left-left gesture. */
  readonly lastLeftAt: number | undefined;
}

export const EMPTY_STEER_DRAFT: SteerDraft = Object.freeze({
  text: "",
  sending: false,
  failure: undefined,
  lastLeftAt: undefined,
});

export type SteerKey = "enter" | "shift-enter" | "escape" | "left";

export type SteerEffect =
  | { readonly type: "none" }
  | { readonly type: "send"; readonly text: string }
  | { readonly type: "exit" }
  | { readonly type: "back" };

const NO_EFFECT: SteerEffect = Object.freeze({ type: "none" });

/** A keyboard event, reduced to what the editor needs; the view builds it from the DOM event. */
export interface SteerKeyInput {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly composing: boolean;
}

/** Maps a key press to the editor's key; keys the editor does not use map to undefined. */
export function steerKeyOf(input: SteerKeyInput): SteerKey | undefined {
  if (input.composing) return undefined;
  if (input.key === "Enter") return input.shiftKey ? "shift-enter" : "enter";
  if (input.key === "Escape") return "escape";
  if (input.key === "ArrowLeft") return "left";
  return undefined;
}

/**
 * Whether a message may be sent now: the worker is running, the draft is not blank, and no send is
 * already in flight.
 */
export function canSendDraft(draft: SteerDraft, canSteer: boolean): boolean {
  return canSteer && !draft.sending && draft.text.trim().length > 0;
}

/**
 * The reducer for one key press. Enter sends only when `canSendDraft` allows it. Escape clears a
 * draft first and exits focus on the next press. Two Lefts on an empty draft within the window return
 * toward the Hub.
 */
export function pressSteerKey(
  draft: SteerDraft,
  key: SteerKey,
  options: { readonly at: number; readonly canSteer: boolean },
): { readonly draft: SteerDraft; readonly effect: SteerEffect } {
  switch (key) {
    case "enter":
      if (!canSendDraft(draft, options.canSteer)) return { draft, effect: NO_EFFECT };
      return {
        draft: { ...draft, sending: true, failure: undefined },
        effect: { type: "send", text: draft.text.trim() },
      };
    case "shift-enter":
      return { draft, effect: NO_EFFECT };
    case "escape":
      if (draft.text !== "") {
        return {
          draft: { ...draft, text: "", failure: undefined, lastLeftAt: undefined },
          effect: NO_EFFECT,
        };
      }
      return { draft, effect: { type: "exit" } };
    case "left": {
      if (draft.text !== "")
        return { draft: { ...draft, lastLeftAt: undefined }, effect: NO_EFFECT };
      const second =
        draft.lastLeftAt !== undefined && options.at - draft.lastLeftAt <= LEFT_LEFT_WINDOW_MS;
      if (second) return { draft: { ...draft, lastLeftAt: undefined }, effect: { type: "back" } };
      return { draft: { ...draft, lastLeftAt: options.at }, effect: NO_EFFECT };
    }
  }
}

/** Typing changes the text; a changed draft no longer carries the last send's failure. */
export function editSteerDraft(draft: SteerDraft, text: string): SteerDraft {
  return { ...draft, text, failure: undefined, lastLeftAt: undefined };
}

/**
 * A send was accepted. The text is cleared only if it still holds what was sent; text typed while the
 * send was in flight stays.
 */
export function steerSendSettled(draft: SteerDraft, sent: string): SteerDraft {
  const unchanged = draft.text.trim() === sent;
  return { ...draft, sending: false, text: unchanged ? "" : draft.text, failure: undefined };
}

export function steerSendFailed(draft: SteerDraft, failure: string): SteerDraft {
  return { ...draft, sending: false, failure };
}

/** The words a person reads when a message is not sent. Omp's own error text is never shown. */
export function steerFailureMessage(failure: AppFailure): string {
  switch (failure.appError.code) {
    case "conflict":
      return "This worker has finished, so the message was not sent. Your text is still here.";
    case "unavailable":
      return "Sending messages to a worker isn't available in this version of omp.";
    case "invalid_args":
      return "Write a message before sending.";
    default:
      return "The message was not sent. Your text is still here; try again.";
  }
}

/** Why the editor is disabled, in plain words; undefined while a running worker can take a message. */
export function steerUnavailableMessage(status: string): string | undefined {
  if (status === "running") return undefined;
  if (status === "pending") return "This worker hasn't started yet, so it can't take a message.";
  return "This worker has finished, so messages can't be sent.";
}
