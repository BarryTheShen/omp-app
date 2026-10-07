import { useLayoutEffect, useRef, useState } from "react";
import { canSteerAgent, type FocusedAgentRuntime } from "@/modules/P1/contract";
import { asAppFailure } from "./failures";
import {
  canSendDraft,
  EMPTY_STEER_DRAFT,
  editSteerDraft,
  pressSteerKey,
  type SteerDraft,
  type SteerKey,
  steerFailureMessage,
  steerSendFailed,
  steerSendSettled,
  steerUnavailableMessage,
} from "./steer";

export interface SteerEditorModel {
  readonly text: string;
  readonly sending: boolean;
  /** Why the last message was not sent, in plain words; the text stays in the editor. */
  readonly failure: string | undefined;
  readonly canSend: boolean;
  /** Why the editor is off, in plain words; undefined while a running worker can take a message. */
  readonly unavailable: string | undefined;
  readonly onTextChange: (text: string) => void;
  readonly onKey: (key: SteerKey) => void;
  readonly onSend: () => void;
}

export interface SteerEditorOptions {
  /** The worker to steer. Its `steer` refuses a worker that is not running. */
  readonly runtime: Pick<FocusedAgentRuntime, "agent" | "steer">;
  /** Escape with an empty draft: leave focus. */
  readonly onExit?: () => void;
  /** Left, Left with an empty draft: return toward the Hub. */
  readonly onBack?: () => void;
  readonly now?: () => number;
}

/**
 * The steer editor's state and its one action. The draft lives here, so a roster update that gives
 * the view a new runtime object never clears what someone is typing.
 */
export function useSteerEditor(options: SteerEditorOptions): SteerEditorModel {
  const [draft, setDraft] = useState<SteerDraft>(EMPTY_STEER_DRAFT);
  const draftRef = useRef(draft);
  const optionsRef = useRef(options);
  useLayoutEffect(() => {
    optionsRef.current = options;
  });

  const commit = (next: SteerDraft): void => {
    draftRef.current = next;
    setDraft(next);
  };

  const send = async (text: string): Promise<void> => {
    try {
      await optionsRef.current.runtime.steer(text);
      commit(steerSendSettled(draftRef.current, text));
    } catch (error) {
      commit(steerSendFailed(draftRef.current, steerFailureMessage(asAppFailure(error))));
    }
  };

  const press = (key: SteerKey): void => {
    const current = optionsRef.current;
    const at = current.now ? current.now() : Date.now();
    const canSteer = canSteerAgent(current.runtime.agent);
    const result = pressSteerKey(draftRef.current, key, { at, canSteer });
    commit(result.draft);
    if (result.effect.type === "send") void send(result.effect.text);
    if (result.effect.type === "exit") current.onExit?.();
    if (result.effect.type === "back") current.onBack?.();
  };

  const canSteer = canSteerAgent(options.runtime.agent);
  return {
    text: draft.text,
    sending: draft.sending,
    failure: draft.failure,
    canSend: canSendDraft(draft, canSteer),
    unavailable: steerUnavailableMessage(options.runtime.agent.status),
    onTextChange: (text) => commit(editSteerDraft(draftRef.current, text)),
    onKey: press,
    onSend: () => press("enter"),
  };
}
