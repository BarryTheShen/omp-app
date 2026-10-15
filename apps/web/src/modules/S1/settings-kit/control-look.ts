import { cn } from "@/lib/utils";

/*
 * The look of a settings control that cannot be changed right now: dimmed to half opacity, muted, and shown with the
 * not-allowed cursor. Every control in the settings kit that can be disabled takes its look from this module, so the
 * dropdowns and checkbox rows of a plain section and of a structured editor cannot drift apart. The text and number
 * boxes take the same values from the shared Input component.
 */

/** A native select: the disabled look, written as variants on the select itself. */
export const SELECT_DISABLED_LOOK =
  "disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 dark:disabled:bg-input/80";

/**
 * A checkbox row. Its label is not disabled itself, so the row takes its look from the checkbox's disabled state.
 */
export function checkboxRowLook(disabled: boolean): string {
  return cn(
    "border-input has-focus-visible:ring-ring/50 flex min-h-8 items-center gap-2 rounded-lg border px-2.5 text-sm transition-colors has-focus-visible:ring-2",
    disabled
      ? "cursor-not-allowed bg-input/50 opacity-50 dark:bg-input/80"
      : "cursor-pointer bg-background",
  );
}
