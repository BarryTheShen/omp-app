import type { EntryId, SessionFilePath, ThreadId } from "@omp-app/contracts";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { OtherVersion } from "@/modules/P3/runs";
import {
  type CatalogSessions,
  createLastUserVersions,
  useOtherVersions,
} from "./use-other-versions";

afterEach(cleanup);

interface FakeSession {
  readonly id: ThreadId;
  readonly sessionFile: SessionFilePath;
  readonly parentSession: SessionFilePath | null;
  readonly title: null;
  readonly displayTitle: string | null;
  readonly firstPrompt: null;
  readonly createdAt: string;
}

function session(id: string, file: string, parent: string | null, title: string): FakeSession {
  return {
    id: id as ThreadId,
    sessionFile: file as SessionFilePath,
    parentSession: parent as SessionFilePath | null,
    title: null,
    displayTitle: title,
    firstPrompt: null,
    createdAt: "2026-10-03T00:00:00.000Z",
  };
}

// The original chat, and an edited copy that names it as its parent (the same lineage as omp's branch helper).
const original = session("chat-original", "/sessions/original.jsonl", null, "Original");
const edit = session("chat-edit", "/sessions/edit.jsonl", "/sessions/original.jsonl", "Edit");
const unrelated = session("chat-other", "/sessions/other.jsonl", null, "Other chat");

/** A catalog that publishes each new session list to its subscribers, as the app's catalog does. */
function fakeCatalog(initial: readonly FakeSession[]) {
  let sessions: readonly FakeSession[] = initial;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => ({ sessions }),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    publish(next: readonly FakeSession[]) {
      sessions = next;
      for (const listener of [...listeners]) listener();
    },
    listenerCount: () => listeners.size,
  } satisfies CatalogSessions & {
    publish(next: readonly FakeSession[]): void;
    listenerCount(): number;
  };
}

/** Renders the hook's result, and records what each render was given. */
function Probe({
  catalog,
  threadId,
  seen,
}: {
  readonly catalog: CatalogSessions;
  readonly threadId: ThreadId;
  readonly seen: (readonly OtherVersion[])[];
}) {
  const versions = useOtherVersions(catalog, threadId);
  seen.push(versions);
  return <output>{versions.map((version) => version.title).join(", ")}</output>;
}

describe("useOtherVersions", () => {
  test("returns the same array while the chat's versions are unchanged", () => {
    const catalog = fakeCatalog([original, edit]);
    const seen: (readonly OtherVersion[])[] = [];
    render(<Probe catalog={catalog} seen={seen} threadId={original.id} />);
    expect(seen).toHaveLength(1);

    // Another chat appears, and the version is published again as a new object with the same content.
    act(() => catalog.publish([original, { ...edit }, unrelated]));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.map((version) => version.threadId)).toEqual([edit.id]);
  });

  test("returns a new list when a version appears or leaves", () => {
    const catalog = fakeCatalog([original]);
    const seen: (readonly OtherVersion[])[] = [];
    const view = render(<Probe catalog={catalog} seen={seen} threadId={original.id} />);
    expect(seen.at(-1)).toEqual([]);

    act(() => catalog.publish([original, edit]));
    expect(seen.at(-1)?.map((version) => version.threadId)).toEqual([edit.id]);

    act(() => catalog.publish([original]));
    expect(seen.at(-1)).toEqual([]);
    expect(view.container.textContent).toBe("");
  });

  test("returns a new list when a version's title changes", () => {
    const catalog = fakeCatalog([original, edit]);
    const seen: (readonly OtherVersion[])[] = [];
    render(<Probe catalog={catalog} seen={seen} threadId={original.id} />);

    act(() => catalog.publish([original, { ...edit, displayTitle: "Renamed edit" }]));
    expect(seen.at(-1)).toEqual([{ threadId: edit.id, title: "Renamed edit" }]);
  });

  test("lists the versions of the chat it is given", () => {
    const catalog = fakeCatalog([original, edit]);
    const seen: (readonly OtherVersion[])[] = [];
    const view = render(<Probe catalog={catalog} seen={seen} threadId={edit.id} />);
    expect(view.container.textContent).toBe("Original");
  });

  test("stops listening to the catalog when the chat closes", () => {
    const catalog = fakeCatalog([original, edit]);
    const seen: (readonly OtherVersion[])[] = [];
    const view = render(<Probe catalog={catalog} seen={seen} threadId={original.id} />);
    expect(catalog.listenerCount()).toBe(1);
    view.unmount();
    expect(catalog.listenerCount()).toBe(0);
  });
});

describe("createLastUserVersions", () => {
  const lastAnswer = "entry-last" as EntryId;
  const earlier = "entry-earlier" as EntryId;
  const versions: readonly OtherVersion[] = [{ threadId: edit.id, title: "Edit" }];

  test("gives the versions only to the message published as the last user message", () => {
    const lastUser = createLastUserVersions();
    lastUser.publish(lastAnswer, versions);
    expect(lastUser.versionsFor(lastAnswer)).toBe(versions);
    expect(lastUser.versionsFor(earlier)).toBeUndefined();
  });

  test("calls subscribers when the last user message or its versions change, and not otherwise", () => {
    const lastUser = createLastUserVersions();
    let calls = 0;
    const stop = lastUser.subscribe(() => {
      calls += 1;
    });

    lastUser.publish(lastAnswer, versions);
    expect(calls).toBe(1);

    lastUser.publish(lastAnswer, versions);
    expect(calls).toBe(1);

    lastUser.publish(earlier, versions);
    expect(calls).toBe(2);

    stop();
    lastUser.publish(lastAnswer, versions);
    expect(calls).toBe(2);
  });
});
