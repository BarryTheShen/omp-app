/** A time as a `datetime-local` field takes it, in this browser's time zone (#14: a task's time). */
export function localInput(ms: number): string {
  const at = new Date(ms);
  const two = (value: number): string => String(value).padStart(2, "0");
  return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}T${two(at.getHours())}:${two(at.getMinutes())}`;
}

/** A `datetime-local` field's value as epoch ms, or null when it holds no time. */
export function fromLocalInput(value: string): number | null {
  if (value.trim() === "") return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}
