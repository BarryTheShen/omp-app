/**
 * omp's double-tap `←`: two presses of the left arrow in an empty editor, close together, open the Agent Hub.
 * It is a gesture, not a keybinding action (docs/agent-hub.md), so it lives with the composer's keys.
 */
export const DOUBLE_LEFT_MS = 500;

/** When the last ← that could start a double-tap was pressed, or null when none is pending. */
export interface ArrowGesture {
  readonly pendingAt: number | null;
}

export interface ArrowGestureInput {
  readonly key: string;
  /** A held key repeats: a repeat is neither a second tap nor a cancel. */
  readonly repeat: boolean;
  /** The composer holds no text and no attachment. */
  readonly emptyEditor: boolean;
  readonly now: number;
}

export interface ArrowGestureStep {
  readonly gesture: ArrowGesture;
  /** True on the second ← of a double-tap. */
  readonly doubleTap: boolean;
}

export const NO_ARROW_GESTURE: ArrowGesture = { pendingAt: null };

/** One key press through the gesture: returns the state to keep and whether this press completed a double-tap. */
export function arrowGestureStep(
  gesture: ArrowGesture,
  input: ArrowGestureInput,
): ArrowGestureStep {
  if (input.repeat) return { gesture, doubleTap: false };
  if (input.key !== "ArrowLeft" || !input.emptyEditor) {
    return { gesture: NO_ARROW_GESTURE, doubleTap: false };
  }
  if (gesture.pendingAt !== null && input.now - gesture.pendingAt <= DOUBLE_LEFT_MS) {
    return { gesture: NO_ARROW_GESTURE, doubleTap: true };
  }
  return { gesture: { pendingAt: input.now }, doubleTap: false };
}
