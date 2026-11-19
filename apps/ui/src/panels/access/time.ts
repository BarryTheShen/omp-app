/** A clock time as "2:47 AM" (or "02:47" where the locale writes it so). */
export const clock = (at: string | number): string =>
  new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** "1 h 45 min left · until 2:47 AM": what is left, then the clock time it ends at. */
export function timeLeft(until: string, now: number = Date.now()): string {
  const end = Date.parse(until);
  const minutes = Math.max(0, Math.ceil((end - now) / 60_000));
  return `${lengthText(minutes)} left · until ${clock(end)}`;
}

/** A length in minutes as "15 min", "1 h" or "1 h 30 min". */
export function lengthText(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours === 0 ? `${rest} min` : rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}
