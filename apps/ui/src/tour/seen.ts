import type { Tour } from "./tours";

const KEY = "omp-app.ui.tours";

/** Which tours the app has offered (in the What's new card) and which the person has been through to the end. */
interface Seen {
  readonly offered: readonly string[];
  readonly done: readonly string[];
}

/** What is kept; missing, unreadable or of another shape counts as nothing offered and nothing done. */
function read(): Seen {
  try {
    const kept: unknown = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (typeof kept !== "object" || kept === null) return { offered: [], done: [] };
    const { offered, done } = kept as { offered?: unknown; done?: unknown };
    return {
      offered: Array.isArray(offered) ? offered.filter((id) => typeof id === "string") : [],
      done: Array.isArray(done) ? done.filter((id) => typeof id === "string") : [],
    };
  } catch {
    return { offered: [], done: [] };
  }
}

function write(seen: Seen): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(seen));
  } catch {
    // Storage that refuses a write only means the tours are offered again next time.
  }
}

/** The tours not offered yet, in their order. */
export function unoffered(tours: readonly Tour[]): readonly Tour[] {
  const { offered } = read();
  return tours.filter((tour) => !offered.includes(tour.id));
}

export function markOffered(ids: readonly string[]): void {
  const seen = read();
  write({ ...seen, offered: [...new Set([...seen.offered, ...ids])] });
}

export function markDone(id: string): void {
  const seen = read();
  write({ ...seen, done: [...new Set([...seen.done, id])] });
}

export function isDone(id: string): boolean {
  return read().done.includes(id);
}
