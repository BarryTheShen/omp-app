import {
  type HostDialogRequest,
  isOmpQuestion,
  type OmpQuestionRequest,
} from "@omp-app/contracts/chat-host";
import { useMemo, useSyncExternalStore } from "react";
import type { ChatController } from "../chat/controller";
import type { PlanProposal } from "../chat/store";
import type { QuestionsSnapshot } from "./questions";

const NO_QUESTIONS: QuestionsSnapshot = { records: null, open: 0 };
const NO_REQUESTS: readonly HostDialogRequest[] = [];
const noSubscription = (): (() => void) => () => undefined;
const noQuestions = (): QuestionsSnapshot => NO_QUESTIONS;
const noPlan = (): null => null;
const noRequests = (): readonly HostDialogRequest[] => NO_REQUESTS;

/**
 * The plan omp proposed in the chat while plan mode is on, until it is approved or set aside (a replayed, decided one
 * never shows). Read as the proposal itself, so a reply streaming in the chat does not redraw what shows it.
 */
export function usePlan(chat: ChatController | null): PlanProposal | null {
  return useSyncExternalStore(
    chat?.store.subscribe ?? noSubscription,
    chat === null
      ? noPlan
      : () => {
          const snapshot = chat.store.getSnapshot();
          return snapshot.planMode?.enabled === true ? snapshot.proposal : null;
        },
  );
}

/**
 * omp's questions that stop the chat until you answer (`isOmpQuestion`), oldest first, as the chat holds them; read as
 * the chat's list of requests, so a reply streaming in the chat does not redraw what shows them.
 */
export function useOmpQuestions(chat: ChatController | null): readonly OmpQuestionRequest[] {
  const requests = useSyncExternalStore(
    chat?.store.subscribe ?? noSubscription,
    chat === null ? noRequests : () => chat.store.getSnapshot().requests,
  );
  return useMemo(() => requests.filter(isOmpQuestion), [requests]);
}

/**
 * How many things in the chat wait for an answer from you: the questions its agent asked without waiting, omp's
 * questions that stop it, and the plan to review.
 */
export function useWaiting(chat: ChatController | null): number {
  const { open } = useSyncExternalStore(
    chat?.questions.subscribe ?? noSubscription,
    chat?.questions.getSnapshot ?? noQuestions,
  );
  const omp = useOmpQuestions(chat).length;
  return open + omp + (usePlan(chat) === null ? 0 : 1);
}
