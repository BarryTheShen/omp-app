import { AppFailure } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import {
  canSendDraft,
  EMPTY_STEER_DRAFT,
  editSteerDraft,
  LEFT_LEFT_WINDOW_MS,
  pressSteerKey,
  type SteerDraft,
  steerFailureMessage,
  steerKeyOf,
  steerSendFailed,
  steerSendSettled,
  steerUnavailableMessage,
} from "../steer";

function typed(text: string): SteerDraft {
  return editSteerDraft(EMPTY_STEER_DRAFT, text);
}

describe("the steer editor", () => {
  test("Enter sends a non-blank draft to a running worker, and a second Enter does not start another send", () => {
    const first = pressSteerKey(typed("  wrap up  "), "enter", { at: 0, canSteer: true });
    expect(first.effect).toEqual({ type: "send", text: "wrap up" });
    expect(first.draft.sending).toBe(true);
    const second = pressSteerKey(first.draft, "enter", { at: 1, canSteer: true });
    expect(second.effect).toEqual({ type: "none" });
  });

  test("Enter does nothing for a blank draft, or for a worker that cannot take a message", () => {
    expect(pressSteerKey(typed("   "), "enter", { at: 0, canSteer: true }).effect).toEqual({
      type: "none",
    });
    expect(pressSteerKey(typed("hi"), "enter", { at: 0, canSteer: false }).effect).toEqual({
      type: "none",
    });
  });

  test("Shift+Enter leaves the newline to the textarea", () => {
    const pressed = pressSteerKey(typed("a"), "shift-enter", { at: 0, canSteer: true });
    expect(pressed.effect).toEqual({ type: "none" });
    expect(pressed.draft.text).toBe("a");
  });

  test("Escape clears the draft first, and leaves focus on the next press", () => {
    const cleared = pressSteerKey(typed("half a thought"), "escape", { at: 0, canSteer: true });
    expect(cleared.draft.text).toBe("");
    expect(cleared.effect).toEqual({ type: "none" });
    expect(pressSteerKey(cleared.draft, "escape", { at: 1, canSteer: true }).effect).toEqual({
      type: "exit",
    });
  });

  test("two Lefts on an empty draft within the window return toward the Hub", () => {
    const once = pressSteerKey(EMPTY_STEER_DRAFT, "left", { at: 1_000, canSteer: true });
    expect(once.effect).toEqual({ type: "none" });
    const twice = pressSteerKey(once.draft, "left", {
      at: 1_000 + LEFT_LEFT_WINDOW_MS,
      canSteer: true,
    });
    expect(twice.effect).toEqual({ type: "back" });
  });

  test("a second Left that comes after the window is only a first Left again", () => {
    const once = pressSteerKey(EMPTY_STEER_DRAFT, "left", { at: 0, canSteer: true });
    const late = pressSteerKey(once.draft, "left", {
      at: LEFT_LEFT_WINDOW_MS + 1,
      canSteer: true,
    });
    expect(late.effect).toEqual({ type: "none" });
  });

  test("a Left while text is typed never starts the gesture", () => {
    const typing = pressSteerKey(typed("abc"), "left", { at: 0, canSteer: true });
    expect(typing.effect).toEqual({ type: "none" });
    expect(pressSteerKey(typing.draft, "left", { at: 10, canSteer: true }).effect).toEqual({
      type: "none",
    });
  });

  test("a failed send keeps the text and says why; a successful one clears it", () => {
    const sending = pressSteerKey(typed("keep me"), "enter", { at: 0, canSteer: true }).draft;
    const failed = steerSendFailed(
      sending,
      steerFailureMessage(new AppFailure({ code: "omp_error", message: "x", retryable: true })),
    );
    expect(failed.text).toBe("keep me");
    expect(failed.sending).toBe(false);
    expect(failed.failure).toBe("The message was not sent. Your text is still here; try again.");

    const sent = steerSendSettled(sending, "keep me");
    expect(sent.text).toBe("");
    expect(sent.failure).toBeUndefined();
  });

  test("text typed while a send is in flight survives the send's success", () => {
    const sending = pressSteerKey(typed("first"), "enter", { at: 0, canSteer: true }).draft;
    const typedMeanwhile = editSteerDraft(sending, "first and more");
    expect(steerSendSettled(typedMeanwhile, "first").text).toBe("first and more");
  });

  test("typing clears the last failure and keeps the words", () => {
    const failed = steerSendFailed(typed("words"), "The message was not sent.");
    const edited = editSteerDraft(failed, "words, edited");
    expect(edited.failure).toBeUndefined();
    expect(edited.text).toBe("words, edited");
  });

  test("a message can be sent only to a running worker, when it is not blank and no send is in flight", () => {
    expect(canSendDraft(typed("hi"), true)).toBe(true);
    expect(canSendDraft(typed("hi"), false)).toBe(false);
    expect(canSendDraft(typed(" "), true)).toBe(false);
    expect(canSendDraft({ ...typed("hi"), sending: true }, true)).toBe(false);
  });

  test("the keyboard maps only the keys the editor uses, and ignores text being composed", () => {
    expect(steerKeyOf({ key: "Enter", shiftKey: false, composing: false })).toBe("enter");
    expect(steerKeyOf({ key: "Enter", shiftKey: true, composing: false })).toBe("shift-enter");
    expect(steerKeyOf({ key: "Escape", shiftKey: false, composing: false })).toBe("escape");
    expect(steerKeyOf({ key: "ArrowLeft", shiftKey: false, composing: false })).toBe("left");
    expect(steerKeyOf({ key: "Enter", shiftKey: false, composing: true })).toBeUndefined();
    expect(steerKeyOf({ key: "a", shiftKey: false, composing: false })).toBeUndefined();
  });

  test("the disabled reason says in plain words why a worker cannot take a message", () => {
    expect(steerUnavailableMessage("running")).toBeUndefined();
    expect(steerUnavailableMessage("pending")).toBe(
      "This worker hasn't started yet, so it can't take a message.",
    );
    expect(steerUnavailableMessage("completed")).toBe(
      "This worker has finished, so messages can't be sent.",
    );
  });

  test("a failure reason never shows omp's own error text", () => {
    const text = steerFailureMessage(
      new AppFailure({
        code: "omp_error",
        message: "Subagent not running: worker-1",
        retryable: false,
      }),
    );
    expect(text).not.toContain("Subagent");
    expect(text).not.toContain("worker-1");
  });
});
