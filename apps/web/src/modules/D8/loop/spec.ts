/**
 * The loop controls' input, checked before anything is offered to omp. A loop spec only describes a run:
 * the app never repeats a prompt, starts a timer or evaluates a condition itself.
 */
export type LoopConditionMode = "while" | "until";

export interface LoopSpec {
  readonly count?: number;
  readonly minutes?: number;
  /** `while`: keep going while the command succeeds. `until`: keep going until it succeeds. */
  readonly condition?: { readonly command: string; readonly mode: LoopConditionMode };
}

export interface LoopForm {
  readonly count: string;
  readonly minutes: string;
  readonly command: string;
  readonly mode: LoopConditionMode;
}

export type LoopFormResult =
  | { readonly ok: true; readonly spec: LoopSpec }
  | { readonly ok: false; readonly message: string };

/** A blank field is `undefined`; a value that is not a whole number above zero is `null`. */
function positiveWhole(text: string): number | undefined | null {
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function loopSpecFromForm(form: LoopForm): LoopFormResult {
  const count = positiveWhole(form.count);
  if (count === null) return { ok: false, message: "Count must be a whole number above zero." };
  const minutes = positiveWhole(form.minutes);
  if (minutes === null) {
    return { ok: false, message: "Time limit must be a whole number of minutes above zero." };
  }
  if (count !== undefined && minutes !== undefined) {
    return { ok: false, message: "Choose a count or a time limit, not both." };
  }
  const command = form.command.trim();
  if (count === undefined && minutes === undefined && command === "") {
    return { ok: false, message: "Set a count, a time limit or a condition command." };
  }
  return {
    ok: true,
    spec: {
      ...(count === undefined ? {} : { count }),
      ...(minutes === undefined ? {} : { minutes }),
      ...(command === "" ? {} : { condition: { command, mode: form.mode } }),
    },
  };
}
