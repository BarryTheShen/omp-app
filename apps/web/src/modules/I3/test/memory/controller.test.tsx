import {
  AppFailure,
  FolderPath,
  type MemoryChanged,
  type MemoryEntry,
  type MemoryListArgs,
  type MemoryListResult,
  type MemoryScope,
  ThreadId,
} from "@omp-app/contracts";
import { act, cleanup, fireEvent, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { OverlayHost } from "@/overlay";
import { useMemoryCenter } from "../../memory/controller";
import type { MemoryStoreAdapter } from "../../ports";

const threadId = ThreadId.parse("memory-thread");
const folder = FolderPath.parse("/workspace/project");
const entry: MemoryEntry = {
  id: "0123456789abcdef",
  scope: "project",
  folder,
  threadId,
  namespace: "project",
  content: "Keep the release checklist short.",
  metadata: {},
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  sensitive: false,
};

function adapter(overrides: Partial<MemoryStoreAdapter> = {}): MemoryStoreAdapter {
  const list = vi.fn(
    async (_args: MemoryListArgs): Promise<MemoryListResult> => ({
      parsed: true,
      rawText: "",
      entries: [entry],
      nextCursor: null,
      revision: "r1",
    }),
  );
  return {
    list,
    get: vi.fn(),
    write: vi.fn(async (args) => ({
      parsed: true,
      rawText: "",
      entry: { ...entry, content: args.content },
      revision: "r2",
      previousRevision: "r1",
    })),
    delete: vi.fn(async () => ({ parsed: true, rawText: "", revision: "r2" })),
    clear: vi.fn(async () => ({ parsed: true, rawText: "", revision: "r2", deletedCount: 1 })),
    subscribeChanged: vi.fn(
      (
        _scope: { scope: MemoryScope; folder: string | null },
        _listener: (change: MemoryChanged) => void,
      ) =>
        () =>
          undefined,
    ),
    ...overrides,
  } as MemoryStoreAdapter;
}

function wrapper({ children }: { readonly children: React.ReactNode }) {
  return <OverlayHost>{children}</OverlayHost>;
}

afterEach(() => cleanup());

describe("memory control-center controller", () => {
  test("keeps a draft after conflict and retries it against the refreshed revision", async () => {
    let listRevision = "r1";
    const store = adapter({
      list: vi.fn(async () => ({
        parsed: true,
        rawText: "",
        entries: [
          {
            ...entry,
            content: listRevision === "r1" ? entry.content : "Newer memory from elsewhere.",
          },
        ],
        nextCursor: null,
        revision: listRevision,
      })),
      write: vi.fn(async (args) => {
        if (listRevision === "r1") {
          listRevision = "r2";
          throw new AppFailure({
            code: "conflict",
            message: "Memory changed elsewhere.",
            retryable: true,
          });
        }
        return {
          parsed: true,
          rawText: "",
          entry: { ...entry, content: args.content },
          revision: "r3",
          previousRevision: "r2",
        };
      }),
    });
    const { result } = renderHook(
      () => useMemoryCenter({ adapter: store, folder, threadId, open: true }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.state.entries).toHaveLength(1));
    await act(async () => result.current.actions.select(entry.id));
    act(() => result.current.actions.setDraft("Unsaved correction."));
    await act(async () => result.current.actions.save());

    expect(result.current.state.error?.appError.code).toBe("conflict");
    expect(result.current.state.errorAction).toBe("save");
    expect(result.current.state.revision).toBe("r2");
    expect(result.current.state.draftConflict).toBe(true);
    expect(result.current.state.draft).toBe("Unsaved correction.");
    await act(async () => result.current.actions.keepDraft());
    await act(async () => result.current.actions.save());

    expect(store.write).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        id: entry.id,
        content: "Unsaved correction.",
        expectedRevision: "r2",
      }),
      expect.anything(),
    );
    expect(result.current.state.draftDirty).toBe(false);
    expect(result.current.state.entries[0]?.content).toBe("Unsaved correction.");
  });
  test("preserves a dirty draft across external changes and can reload it", async () => {
    let externalChange = false;
    let changed: (() => void) | undefined;
    const store = adapter({
      list: vi.fn(async () => ({
        parsed: true,
        rawText: "",
        entries: [
          { ...entry, content: externalChange ? "Newer memory from elsewhere." : entry.content },
        ],
        nextCursor: null,
        revision: externalChange ? "r2" : "r1",
      })),
      subscribeChanged: vi.fn((_scope, listener) => {
        changed = () => {
          externalChange = true;
          listener({
            folder,
            scope: "project",
            revision: "r2",
            ids: [entry.id],
            reason: "backend",
          });
        };
        return () => undefined;
      }),
    });
    const { result } = renderHook(
      () => useMemoryCenter({ adapter: store, folder, threadId, open: true }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.state.entries).toHaveLength(1));
    await act(async () => result.current.actions.select(entry.id));
    act(() => result.current.actions.setDraft("Keep my draft."));
    act(() => changed?.());
    await waitFor(() => expect(result.current.state.draftConflict).toBe(true));
    expect(result.current.state.draft).toBe("Keep my draft.");
    await act(async () => result.current.actions.reloadDraft());
    expect(result.current.state.draftConflict).toBe(false);
    expect(result.current.state.draft).toBe("Newer memory from elsewhere.");
  });

  test("saves successfully, removes through the confirmed adapter, and shows command failures", async () => {
    const store = adapter();
    const runCommand = vi.fn(async () => {
      throw new AppFailure({ code: "timeout", message: "Memory timed out.", retryable: true });
    });
    const { result } = renderHook(
      () => useMemoryCenter({ adapter: store, folder, threadId, open: true, runCommand }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.state.entries).toHaveLength(1));
    await act(async () => result.current.actions.select(entry.id));
    act(() => result.current.actions.setDraft("Saved content."));
    await act(async () => result.current.actions.save());
    expect(result.current.state.draftDirty).toBe(false);
    await act(async () => result.current.actions.runCommand("stats"));
    expect(result.current.state.command?.error?.appError.message).toBe("Memory timed out.");
    let clearing: Promise<void> | undefined;
    act(() => {
      clearing = result.current.actions.runCommand("clear");
    });
    await screen.findByRole("dialog");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Clear memory" }));
      await clearing;
    });
    expect(store.clear).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "clear", confirmed: true }),
      expect.anything(),
    );
    let removing: Promise<void> | undefined;
    act(() => {
      removing = result.current.actions.remove();
    });
    await screen.findByRole("dialog");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Delete memory" }));
      await removing;
    });
    expect(store.delete).toHaveBeenCalledWith(
      expect.objectContaining({ confirmed: true, id: entry.id }),
      expect.anything(),
    );
  });

  test("changes scope and routes maintenance operations through the typed executor", async () => {
    const store = adapter();
    const runCommand = vi.fn(async (request) => ({
      command: request.command,
      status: "complete" as const,
      message: "Memory maintenance finished.",
    }));
    const { result } = renderHook(
      () =>
        useMemoryCenter({
          adapter: store,
          folder: null,
          threadId,
          open: true,
          runCommand,
        }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.state.entries).toHaveLength(1));
    await act(async () => result.current.actions.setScope("session"));
    await waitFor(() =>
      expect(store.list).toHaveBeenCalledWith(
        expect.objectContaining({ scope: "session" }),
        expect.anything(),
      ),
    );
    await act(async () => result.current.actions.runCommand("stats"));
    expect(runCommand).toHaveBeenCalledWith(
      { command: "stats", scope: "session", memoryId: undefined },
      expect.anything(),
    );
    expect(result.current.state.command?.message).toBe("Memory maintenance finished.");
  });
  test("does not clear after cancellation and reports an unparsed clear result", async () => {
    const clear = vi.fn(async () => ({
      parsed: false,
      rawText: "unrecognized response",
      revision: "r2",
      deletedCount: 0,
    }));
    const store = adapter({ clear });
    const { result } = renderHook(
      () => useMemoryCenter({ adapter: store, folder, threadId, open: true }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.state.entries).toHaveLength(1));

    let declined: Promise<void> | undefined;
    act(() => {
      declined = result.current.actions.runCommand("clear");
    });
    await screen.findByRole("dialog");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      await declined;
    });
    expect(clear).not.toHaveBeenCalled();
    expect(result.current.state.command).toBeNull();

    let unparsed: Promise<void> | undefined;
    act(() => {
      unparsed = result.current.actions.runCommand("clear");
    });
    await screen.findByRole("dialog");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Clear memory" }));
      await unparsed;
    });
    expect(clear).toHaveBeenCalledTimes(1);
    expect(result.current.state.command?.status).toBe("error");
    expect(result.current.state.command?.message).toBe(
      "omp returned a memory result the app could not read.",
    );
  });

  test("uses human labels for reset and queues rebuild through the typed gateway", async () => {
    const store = adapter();
    const runCommand = vi.fn(async ({ command }) => ({
      command,
      status: "complete" as const,
      message: "Memory consolidation enqueued.",
    }));
    const { result } = renderHook(
      () => useMemoryCenter({ adapter: store, folder, threadId, open: true, runCommand }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.state.entries).toHaveLength(1));

    let reset: Promise<void> | undefined;
    act(() => {
      reset = result.current.actions.runCommand("reset");
    });
    await screen.findByRole("dialog");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Clear memory" }));
      await reset;
    });
    expect(store.clear).toHaveBeenLastCalledWith(
      expect.objectContaining({ operation: "reset", confirmed: true }),
      expect.anything(),
    );
    expect(result.current.state.command?.message).toBe(
      "Reset memory completed. Removed 1 memory item.",
    );

    await act(async () => result.current.actions.runCommand("rebuild"));
    expect(runCommand).toHaveBeenCalledWith(
      { command: "enqueue", scope: "project", memoryId: undefined },
      expect.anything(),
    );
    expect(result.current.state.command?.message).toBe("Memory consolidation enqueued.");
  });
  test("does not claim a count when omp clears memory without one", async () => {
    const store = adapter({
      clear: vi.fn(async () => ({
        parsed: true,
        rawText: "Memory cleared.",
        revision: "r2",
        deletedCount: 0,
      })),
    });
    const { result } = renderHook(
      () => useMemoryCenter({ adapter: store, folder, threadId, open: true }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.state.entries).toHaveLength(1));
    let clearing: Promise<void> | undefined;
    act(() => {
      clearing = result.current.actions.runCommand("clear");
    });
    await screen.findByRole("dialog");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Clear memory" }));
      await clearing;
    });
    expect(result.current.state.command?.message).toBe("Clear memory completed.");
  });

  test("asks before adding the built-in mental models, in mental-model words", async () => {
    const store = adapter();
    const runCommand = vi.fn(async ({ command }) => ({
      command,
      status: "complete" as const,
      message: "Mental models added.",
    }));
    const { result } = renderHook(
      () => useMemoryCenter({ adapter: store, folder, threadId, open: true, runCommand }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.state.entries).toHaveLength(1));
    let seeding: Promise<void> | undefined;
    act(() => {
      seeding = result.current.actions.runCommand("mm-seed");
    });
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("Add missing mental models?");
    expect(runCommand).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add mental models" }));
      await seeding;
    });
    expect(runCommand).toHaveBeenCalledWith(
      { command: "mm-seed", scope: "project", memoryId: undefined },
      expect.anything(),
    );
  });

  test("asks before switching away from a dirty draft", async () => {
    const other: MemoryEntry = { ...entry, id: "abcdef0123456789", content: "Another memory." };
    const store = adapter({
      list: vi.fn(async () => ({
        parsed: true,
        rawText: "",
        entries: [entry, other],
        nextCursor: null,
        revision: "r1",
      })),
    });
    const { result } = renderHook(
      () => useMemoryCenter({ adapter: store, folder, threadId, open: true }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.state.entries).toHaveLength(2));
    await act(async () => result.current.actions.select(entry.id));
    act(() => result.current.actions.setDraft("Unsaved change."));

    let selecting: Promise<void> | undefined;
    act(() => {
      selecting = result.current.actions.select(other.id);
    });
    await screen.findByRole("dialog");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      await selecting;
    });
    expect(result.current.state.selected?.id).toBe(entry.id);
    expect(result.current.state.draft).toBe("Unsaved change.");

    let switching: Promise<void> | undefined;
    act(() => {
      switching = result.current.actions.setScope("session");
    });
    await screen.findByRole("dialog");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      await switching;
    });
    expect(result.current.state.scope).toBe("project");
    expect(result.current.state.draft).toBe("Unsaved change.");
  });

  test("clears action state after closing during an in-flight save", async () => {
    const deferred = Promise.withResolvers<never>();
    const store = adapter({ write: vi.fn(() => deferred.promise as never) });
    const { result } = renderHook(
      () => useMemoryCenter({ adapter: store, folder, threadId, open: true }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.state.entries).toHaveLength(1));
    await act(async () => result.current.actions.select(entry.id));
    act(() => result.current.actions.setDraft("In flight."));
    act(() => {
      void result.current.actions.save();
    });
    await waitFor(() => expect(result.current.state.saving).toBe(true));
    act(() => result.current.actions.close());
    act(() => result.current.actions.open());
    expect(result.current.state.saving).toBe(false);
    expect(result.current.state.deleting).toBe(false);
    expect(result.current.state.command).toBeNull();
    deferred.reject(new Error("aborted"));
  });
});
