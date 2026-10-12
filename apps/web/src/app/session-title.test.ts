import type { ThreadId } from "@omp-app/contracts";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { useSessionTitle } from "./session-title";

type Source = NonNullable<Parameters<typeof useSessionTitle>[0]>;

const chat = (id: string) => id as ThreadId;

/** A catalog holding these sessions that can change them and tells its listeners. */
function fakeCatalog(initial: readonly { id: string; title: string | null }[]) {
  let sessions = initial;
  const listeners = new Set<() => void>();
  const fetched: string[] = [];
  const fetchTitles: Record<string, string | null> = {};
  const source = {
    getSnapshot: () => ({
      sessions: sessions.map((session) => ({ ...session, displayTitle: session.title })),
    }),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    fetch: vi.fn(async (id: string) => {
      fetched.push(id);
      return { id, title: fetchTitles[id] ?? null, displayTitle: fetchTitles[id] ?? null };
    }),
  } as unknown as Source;
  return {
    source,
    fetched,
    fetchTitles,
    set(next: readonly { id: string; title: string | null }[]) {
      sessions = next;
      for (const listener of listeners) listener();
    },
  };
}

describe("useSessionTitle", () => {
  test("is the title the loaded list holds for the chat, and fetches nothing", () => {
    const catalog = fakeCatalog([{ id: "a", title: "Fix the login" }]);
    const { result } = renderHook(() => useSessionTitle(catalog.source, chat("a")));
    expect(result.current).toBe("Fix the login");
    expect(catalog.fetched).toEqual([]);
  });

  test("a chat the list does not hold is read on its own; no title is just 'Conversation'", async () => {
    const catalog = fakeCatalog([{ id: "a", title: "Another chat" }]);
    catalog.fetchTitles.deep = "An old chat";
    const { result } = renderHook(() => useSessionTitle(catalog.source, chat("deep")));
    expect(result.current).toBe("Conversation");
    await waitFor(() => expect(result.current).toBe("An old chat"));
    expect(catalog.fetched).toEqual(["deep"]);

    const unnamed = renderHook(() => useSessionTitle(catalog.source, chat("unnamed")));
    await waitFor(() => expect(catalog.fetched).toEqual(["deep", "unnamed"]));
    expect(unnamed.result.current).toBe("Conversation");
  });

  test("follows the list when it refreshes, and prefers it to a slower read of the chat", async () => {
    const catalog = fakeCatalog([{ id: "a", title: null }]);
    const { result } = renderHook(() => useSessionTitle(catalog.source, chat("a")));
    expect(result.current).toBe("Conversation");
    act(() => catalog.set([{ id: "a", title: "Named by omp" }]));
    expect(result.current).toBe("Named by omp");
  });

  test("is 'New conversation' with no chat or no catalog", () => {
    const catalog = fakeCatalog([]);
    expect(renderHook(() => useSessionTitle(catalog.source, undefined)).result.current).toBe(
      "New conversation",
    );
    expect(renderHook(() => useSessionTitle(null, chat("a"))).result.current).toBe(
      "New conversation",
    );
  });
});
