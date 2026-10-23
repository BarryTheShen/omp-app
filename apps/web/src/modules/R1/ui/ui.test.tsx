import type { CapabilityMap, SessionFile } from "@omp-app/contracts";
import { AppFailure, SessionFilePath, ThreadId as ThreadIdSchema } from "@omp-app/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, test } from "vitest";
import { createRegistry } from "@/registry-core";
import { withRegistry } from "@/registry-core/test-support";
import { ShortcutRegistryProvider } from "@/shortcuts";
import { SessionCatalogModel } from "../catalog";
import type { SessionMetadata } from "../contract";
import { R1_DESCRIPTORS } from "../descriptors";
import { createNativeRemoteThreadListAdapter, type RemoteInitializeOptions } from "../remote";
import { SessionCatalogSidebar as Sidebar } from ".";

afterEach(cleanup);

/** The sidebar as the app mounts it: inside the shortcut registry its chords are registered in. */
function SessionCatalogSidebar(props: ComponentProps<typeof Sidebar>) {
  return (
    <ShortcutRegistryProvider descriptors={R1_DESCRIPTORS}>
      <Sidebar {...props} />
    </ShortcutRegistryProvider>
  );
}

const folder = "/workspace/project" as SessionMetadata["cwd"];
const scope = { kind: "folder" as const, folder };

function session(
  id: string,
  updatedAt: string,
  title: string | null = id,
  firstPrompt: string | null = null,
): SessionFile {
  return {
    id: ThreadIdSchema.parse(id),
    sessionFile: SessionFilePath.parse(`${folder}/.omp/${id}.jsonl`),
    version: 3,
    title,
    displayTitle: title,
    firstPrompt,
    cwd: folder,
    createdAt: "2026-10-05T00:00:00.000Z",
    updatedAt,
    parentSession: null,
    messageCount: 2,
    assistantTurns: 1,
    sizeBytes: 100,
    status: "complete",
    liveness: { lease: "free", serverProcess: false },
    subagents: [],
    parseWarnings: [],
  };
}

function modelWithSessions(
  files: SessionFile[] = [
    session("old", "2026-10-01T00:00:00.000Z", "Old chat"),
    session("new", "2026-10-03T00:00:00.000Z", "Newest chat"),
  ],
): SessionCatalogModel {
  return new SessionCatalogModel({
    scope,
    sessionFiles: {
      listSessions: async () => ({ sessions: files, nextCursor: null }),
      readSessionRow: async ({ sessionFile }) =>
        files.find((file) => file.sessionFile === sessionFile) as SessionFile,
    },
  });
}

/** A catalog whose first page holds these chats, and names the chats running with no session file yet. */
function modelWithRunning(
  running: readonly string[],
  files: SessionFile[] = [],
): SessionCatalogModel {
  return new SessionCatalogModel({
    scope,
    sessionFiles: {
      listSessions: async ({ folder: listed }) => ({
        sessions: files,
        nextCursor: null,
        running: running.map((id) => ({ id: ThreadIdSchema.parse(id), folder: listed })),
      }),
      readSessionRow: async ({ sessionFile }) =>
        files.find((file) => file.sessionFile === sessionFile) as SessionFile,
    },
  });
}

/** Omp's rename command is available, so the Rename menu item is enabled. */
const RENAME_AVAILABLE: CapabilityMap = {
  "omp.cmd.set_session_name": { state: "available", via: "rpc" },
};

const DELETE_AVAILABLE: CapabilityMap = {
  "host.session-files": { state: "available", via: "rpc" },
};

function fakeRemote(calls: string[]): ComponentProps<typeof SessionCatalogSidebar>["remote"] {
  return {
    initialize: async (id: string) => {
      calls.push(`initialize:${id}`);
      return { remoteId: id };
    },
    rename: async (id: string, title: string) => {
      calls.push(`rename:${id}:${title}`);
    },
    archive: async () => {},
    unarchive: async () => {},
    delete: async (id: string) => {
      calls.push(`delete:${id}`);
    },
  };
}

/** The runtime's initialize as the adapter runs it: its open reaches omp only once the page's pick has answered yes. */
function gatedRemote(calls: string[]): ComponentProps<typeof SessionCatalogSidebar>["remote"] {
  return {
    ...fakeRemote(calls),
    initialize: async (id: string, options?: RemoteInitializeOptions) => {
      calls.push(`initialize:${id}`);
      if (options?.after !== undefined && !(await options.after)) {
        throw new AppFailure({
          code: "cancelled",
          message: "Not opened by the page",
          retryable: false,
        });
      }
      calls.push(`runtime-open:${id}`);
      return { remoteId: id };
    },
  };
}

function renderSidebar(
  overrides: Partial<ComponentProps<typeof SessionCatalogSidebar>> & {
    readonly renameAvailable?: boolean;
    readonly deleteAvailable?: boolean;
  } = {},
) {
  const { renameAvailable = false, deleteAvailable = false, ...props } = overrides;
  const catalog = props.catalog ?? modelWithSessions();
  const calls: string[] = [];
  const sidebar = (
    <SessionCatalogSidebar
      {...props}
      catalog={catalog}
      remote={props.remote ?? fakeRemote(calls)}
    />
  );
  const capabilities = {
    ...(renameAvailable ? RENAME_AVAILABLE : {}),
    ...(deleteAvailable ? DELETE_AVAILABLE : {}),
  };
  const view = render(
    renameAvailable || deleteAvailable
      ? withRegistry(createRegistry([]), capabilities, sidebar)
      : sidebar,
  );
  return { catalog, calls, rerender: view.rerender };
}

/** Opens a row's More actions and then its Rename item, the way a person does. */
function startRename(title: string): void {
  fireEvent.click(screen.getByRole("button", { name: `More actions for ${title}` }));
  const menu = screen.getByRole("menu", { name: `Actions for ${title}` });
  fireEvent.click(within(menu).getByRole("menuitem", { name: `Rename ${title}` }));
}

describe("SessionCatalogSidebar", () => {
  test("a picked chat is selected at once, before its open finishes", async () => {
    const calls: string[] = [];
    const opened: string[] = [];
    let finishOpen: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      finishOpen = resolve;
    });
    const remote = {
      ...fakeRemote(calls),
      initialize: async (id: string) => {
        calls.push(`initialize:${id}`);
        await held;
        return { remoteId: id };
      },
    };
    renderSidebar({
      remote,
      currentThreadId: ThreadIdSchema.parse("old"),
      onOpenThread: async (threadId) => {
        opened.push(threadId);
      },
    });
    await waitFor(() => expect(screen.getByText("Newest chat")).toBeTruthy());
    fireEvent.click(screen.getByRole("option", { name: /Newest chat/ }));
    // omp is still starting the chat: its row already shows as the selected one, the open chat's row does not.
    expect(screen.getByRole("option", { name: /Newest chat/ }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(screen.getByRole("option", { name: /Old chat/ }).getAttribute("aria-selected")).toBe(
      "false",
    );
    await act(async () => {
      finishOpen();
    });
    await waitFor(() => expect(opened).toEqual(["new"]));
  });
  test("the page opens a picked chat first; the runtime's open waits for the page's answer", async () => {
    const calls: string[] = [];
    const pageOpen = Promise.withResolvers<boolean>();
    renderSidebar({
      remote: gatedRemote(calls),
      onOpenThread: async (threadId) => {
        calls.push(`open:${threadId}`);
        return pageOpen.promise;
      },
    });
    await waitFor(() => expect(screen.getByText("Old chat")).toBeTruthy());
    fireEvent.click(screen.getByRole("option", { name: /Old chat/ }));
    // The runtime numbers its pick at the click; its open waits for the page's answer.
    await waitFor(() => expect(calls).toEqual(["open:old", "initialize:old"]));
    pageOpen.resolve(true);
    await waitFor(() => expect(calls).toEqual(["open:old", "initialize:old", "runtime-open:old"]));
  });
  test("a chat the page did not open is not opened by the runtime, and the pick is over", async () => {
    const calls: string[] = [];
    const pageOpen = Promise.withResolvers<boolean>();
    renderSidebar({
      remote: gatedRemote(calls),
      onOpenThread: async (threadId) => {
        calls.push(`open:${threadId}`);
        return pageOpen.promise;
      },
    });
    await waitFor(() => expect(screen.getByText("Old chat")).toBeTruthy());
    fireEvent.click(screen.getByRole("option", { name: /Old chat/ }));
    await waitFor(() => expect(calls).toEqual(["open:old", "initialize:old"]));
    pageOpen.resolve(false);
    await waitFor(() =>
      expect(screen.getByRole("option", { name: /Old chat/ }).getAttribute("aria-selected")).toBe(
        "false",
      ),
    );
    expect(calls).toEqual(["open:old", "initialize:old"]);
  });
  test("a pick made while another pick's chat opens leaves the earlier pick's runtime open unsent", async () => {
    const calls: string[] = [];
    const earlierOpen = Promise.withResolvers<boolean>();
    renderSidebar({
      remote: gatedRemote(calls),
      onOpenThread: async (threadId) => {
        calls.push(`open:${threadId}`);
        return threadId === "old" ? earlierOpen.promise : true;
      },
    });
    await waitFor(() => expect(screen.getByText("Newest chat")).toBeTruthy());
    fireEvent.click(screen.getByRole("option", { name: /Old chat/ }));
    await waitFor(() => expect(calls).toEqual(["open:old", "initialize:old"]));
    fireEvent.click(screen.getByRole("option", { name: /Newest chat/ }));
    const expected = [
      "open:old",
      "initialize:old",
      "open:new",
      "initialize:new",
      "runtime-open:new",
    ];
    await waitFor(() => expect(calls).toEqual(expected));
    await act(async () => {
      earlierOpen.resolve(true);
    });
    expect(calls).toEqual(expected);
  });
  test("a New chat clicked during a picked chat's page open becomes the chat on screen", async () => {
    const catalog = modelWithSessions([
      session("thread-old", "2026-10-01T00:00:00.000Z", "Old chat"),
      session("thread-newest", "2026-10-03T00:00:00.000Z", "Newest chat"),
    ]);
    const pageOpen = Promise.withResolvers<boolean>();
    const selected: string[] = [];
    const newChatOpened: string[] = [];
    const remote = createNativeRemoteThreadListAdapter({
      catalog,
      open: async (args) => {
        const threadId = "threadId" in args ? args.threadId : ThreadIdSchema.parse("thread-new");
        return {
          threadId,
          sessionFile:
            `/workspace/project/.omp/${threadId}.jsonl` as SessionMetadata["sessionFile"],
          capabilities: {},
        };
      },
      onThreadIdChange: (threadId) => {
        if (threadId) selected.push(threadId);
      },
    });
    renderSidebar({
      catalog,
      remote,
      onOpenThread: async (threadId) => (threadId === "thread-old" ? pageOpen.promise : true),
      onNewChat: async (threadId) => {
        newChatOpened.push(threadId);
      },
    });
    await waitFor(() => expect(screen.getByText("Old chat")).toBeTruthy());
    fireEvent.click(screen.getByRole("option", { name: /Old chat/ }));
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    await waitFor(() => expect(newChatOpened).toEqual(["thread-new"]));
    pageOpen.resolve(true);
    await waitFor(() => expect(remote.getCurrentThreadId()).toBe("thread-new"));
    expect(selected).toEqual(["thread-new"]);
  });
  test("reloads the catalog when a branch becomes the active chat before its row is listed", async () => {
    const source = session("source", "2026-10-05T00:00:00.000Z", "Source session");
    const branch = session("branch", "2026-10-06T00:00:00.000Z", "Branch session");
    const files = [source];
    let listCalls = 0;
    const catalog = new SessionCatalogModel({
      scope,
      sessionFiles: {
        listSessions: async () => {
          listCalls += 1;
          return { sessions: files, nextCursor: null };
        },
        readSessionRow: async ({ sessionFile }) =>
          files.find((file) => file.sessionFile === sessionFile) as SessionFile,
      },
    });
    await catalog.list({ filter: { scope, query: "" }, limit: 50 });
    const calls: string[] = [];
    const { rerender } = renderSidebar({
      catalog,
      currentThreadId: source.id,
      remote: fakeRemote(calls),
    });
    await waitFor(() =>
      expect(screen.getByRole("option", { name: /Source session/ })).toBeTruthy(),
    );
    expect(listCalls).toBe(1);

    files.push(branch);
    await act(async () => {
      rerender(
        <SessionCatalogSidebar
          catalog={catalog}
          currentThreadId={branch.id}
          remote={fakeRemote(calls)}
        />,
      );
    });
    await waitFor(() =>
      expect(screen.getByRole("option", { name: /Branch session/ })).toBeTruthy(),
    );
    expect(screen.getAllByRole("option")).toHaveLength(2);
    expect(
      screen.getByRole("option", { name: /Branch session/ }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(listCalls).toBe(2);
  });

  test("a pick the chat refuses hands the selection back to the chat that is open", async () => {
    const refused: string[] = [];
    const remote = {
      ...fakeRemote([]),
      initialize: async () => {
        throw new AppFailure({
          code: "model_unavailable",
          message: "The chat's model is no longer available.",
          retryable: false,
        });
      },
    };
    renderSidebar({
      remote,
      currentThreadId: ThreadIdSchema.parse("old"),
      onOpenFailed: (threadId) => {
        refused.push(threadId);
      },
    });
    await waitFor(() => expect(screen.getByText("Newest chat")).toBeTruthy());
    fireEvent.click(screen.getByRole("option", { name: /Newest chat/ }));
    await waitFor(() => expect(refused).toEqual(["new"]));
    expect(screen.getByRole("option", { name: /Old chat/ }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(screen.getByRole("option", { name: /Newest chat/ }).getAttribute("aria-selected")).toBe(
      "false",
    );
  });

  test("groups folder rows and keeps catalog's pinned/recent order", async () => {
    const { calls } = renderSidebar();
    await waitFor(() => expect(screen.getByText("Newest chat")).toBeTruthy());
    expect(screen.getByRole("heading", { name: /^project$/ }).getAttribute("title")).toBe(folder);
    const options = screen.getAllByRole("option");
    expect(options[0]?.textContent).toContain("Newest chat");
    expect(options[1]?.textContent).toContain("Old chat");
    expect(calls).toEqual([]);
  });

  test("a chat whose turn is running shows a spinner and a screen-reader Running; an idle chat shows neither", async () => {
    const busy: SessionFile = {
      ...session("busy", "2026-10-03T00:00:00.000Z", "Busy chat"),
      turn: "running",
    };
    const quiet: SessionFile = {
      ...session("quiet", "2026-10-02T00:00:00.000Z", "Quiet chat"),
      turn: "idle",
    };
    renderSidebar({ catalog: modelWithSessions([busy, quiet]) });
    await waitFor(() => expect(screen.getByText("Busy chat")).toBeTruthy());

    const busyRow = screen.getByRole("option", { name: /Busy chat/ });
    expect(within(busyRow).getByText("Running")).toBeTruthy();
    expect(busyRow.querySelector('[data-slot="r1-session-running"]')).not.toBeNull();
    const quietRow = screen.getByRole("option", { name: /Quiet chat/ });
    expect(within(quietRow).queryByText("Running")).toBeNull();
    expect(quietRow.querySelector('[data-slot="r1-session-running"]')).toBeNull();
  });

  test("keeps loaded rows, scroll and the selected session during a background refresh", async () => {
    const files = Array.from({ length: 40 }, (_, index) =>
      session(
        `chat-${String(index).padStart(2, "0")}`,
        new Date(Date.UTC(2026, 9, 5) - index * 60_000).toISOString(),
        `Chat ${index}`,
      ),
    );
    const refreshResult = Promise.withResolvers<{ sessions: SessionFile[]; nextCursor: null }>();
    let calls = 0;
    const catalog = new SessionCatalogModel({
      scope,
      sessionFiles: {
        listSessions: async () => {
          calls += 1;
          return calls === 1 ? { sessions: files, nextCursor: null } : refreshResult.promise;
        },
        readSessionRow: async ({ sessionFile }) => {
          const file = files.find((item) => item.sessionFile === sessionFile);
          if (!file) throw new Error("The session was not found");
          return file;
        },
      },
    });
    renderSidebar({
      catalog,
      currentThreadId: ThreadIdSchema.parse("chat-20"),
    });
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(40));
    const list = screen.getByRole("listbox", { name: "Session list" });
    const selected = within(list).getByRole("option", { name: /Chat 20/ });
    list.scrollTop = 80;

    let refresh: Promise<unknown> = Promise.resolve();
    act(() => {
      refresh = catalog.list({ filter: { scope, query: "" }, limit: 50 });
    });

    expect(catalog.getSnapshot().isLoading).toBe(false);
    expect(screen.getByRole("listbox", { name: "Session list" })).toBe(list);
    expect(list.scrollTop).toBe(80);
    expect(selected.parentElement?.getAttribute("data-selected")).toBe("true");
    expect(within(list).getAllByRole("option")).toHaveLength(40);
    expect(screen.queryByRole("status", { name: "Loading sessions" })).toBeNull();

    await act(async () => {
      refreshResult.resolve({ sessions: files, nextCursor: null });
      await refresh;
    });
    expect(screen.getByRole("listbox", { name: "Session list" })).toBe(list);
    expect(list.scrollTop).toBe(80);
    expect(selected.parentElement?.getAttribute("data-selected")).toBe("true");
  });

  test("the list shows a card title's own words, not the icon or the code omp stored", async () => {
    const files = [
      {
        ...session("card", "2026-10-03T00:00:00.000Z", "🧪 FLAKY: Fix flaky park tests"),
        displayTitle: "Fix flaky park tests",
      },
    ];
    const catalog = new SessionCatalogModel({
      scope,
      sessionFiles: {
        listSessions: async () => ({ sessions: files, nextCursor: null }),
        readSessionRow: async () => files[0] ?? session("missing", "2026-10-01T00:00:00.000Z"),
      },
    });
    renderSidebar({ catalog });
    await waitFor(() => expect(screen.getByText("Fix flaky park tests")).toBeTruthy());
    expect(screen.queryByText(/FLAKY/)).toBeNull();
  });

  test("keeps the previous list and reports a failed background refresh in one line", async () => {
    const files = [session("one", "2026-10-03T00:00:00.000Z", "One chat")];
    let failRefresh = false;
    const catalog = new SessionCatalogModel({
      scope,
      sessionFiles: {
        listSessions: async () => {
          if (failRefresh) throw new Error("disk busy");
          return { sessions: files, nextCursor: null };
        },
        readSessionRow: async () => files[0] ?? session("missing", "2026-10-01T00:00:00.000Z"),
      },
    });
    renderSidebar({ catalog });
    await waitFor(() => expect(screen.getByRole("option", { name: /One chat/ })).toBeTruthy());
    failRefresh = true;

    let refresh: Promise<unknown> = Promise.resolve();
    act(() => {
      refresh = catalog.list({ filter: { scope, query: "" }, limit: 50 });
    });
    await act(async () => {
      await expect(refresh).rejects.toThrow("disk busy");
    });

    expect(screen.getByRole("option", { name: /One chat/ })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe(
      "Couldn't refresh sessions. Showing the last list.",
    );
  });

  test("an untitled session shows its first prompt, then a generic name, never its id", async () => {
    renderSidebar({
      catalog: modelWithSessions([
        session("01a10e79-prompted", "2026-10-03T00:00:00.000Z", null, "Fix the flaky login test"),
        session("01a10e79-empty", "2026-10-02T00:00:00.000Z", null, null),
      ]),
    });
    await waitFor(() => expect(screen.getByText("Fix the flaky login test")).toBeTruthy());
    const options = screen.getAllByRole("option");
    expect(options[1]?.textContent).toContain("New session");
    expect(screen.queryByText(/01a10e79/)).toBeNull();
  });

  test("search highlights matching titles and arrow/Enter opens the focused row", async () => {
    const opened: string[] = [];
    const { catalog } = renderSidebar({
      onOpenThread: async (threadId) => {
        opened.push(threadId);
      },
    });
    await waitFor(() => expect(screen.getByText("Newest chat")).toBeTruthy());
    const search = screen.getByRole("textbox", { name: "Search sessions" });
    fireEvent.change(search, { target: { value: "new" } });
    await waitFor(() => expect(screen.getByText(/new/i, { selector: "mark" })).toBeTruthy());
    const list = screen.getByRole("listbox");
    fireEvent.keyDown(list, { key: "Enter" });
    await waitFor(() => expect(opened).toEqual(["new"]));
    expect(catalog.getSnapshot().filter.query).toBe("new");
  });

  test("arrow keys move focus to the next row, and Enter opens the row that has focus", async () => {
    const opened: string[] = [];
    renderSidebar({
      catalog: modelWithSessions([
        session("first", "2026-10-05T00:00:00.000Z", "First chat"),
        session("second", "2026-10-04T00:00:00.000Z", "Second chat"),
        session("third", "2026-10-03T00:00:00.000Z", "Third chat"),
      ]),
      onOpenThread: async (threadId) => {
        opened.push(threadId);
      },
    });
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(3));
    const [first, second, third] = screen.getAllByRole("option");
    if (!first || !second || !third) throw new Error("Expected three chat rows.");
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(second, { key: "ArrowDown" });
    expect(document.activeElement).toBe(third);
    fireEvent.keyDown(third, { key: "Home" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "End" });
    expect(document.activeElement).toBe(third);
    fireEvent.keyDown(third, { key: "Enter" });
    await waitFor(() => expect(opened).toEqual(["third"]));
  });

  test("Alt, Ctrl, Meta and Shift combinations are left to the browser: the arrow keys do not move the list", async () => {
    renderSidebar({
      catalog: modelWithSessions([
        session("first", "2026-10-05T00:00:00.000Z", "First chat"),
        session("second", "2026-10-04T00:00:00.000Z", "Second chat"),
      ]),
    });
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));
    const [first, second] = screen.getAllByRole("option");
    if (!first || !second) throw new Error("Expected two chat rows.");
    first.focus();
    expect(fireEvent.keyDown(first, { key: "ArrowDown", altKey: true })).toBe(true);
    expect(fireEvent.keyDown(first, { key: "ArrowDown", shiftKey: true })).toBe(true);
    expect(fireEvent.keyDown(first, { key: "End", ctrlKey: true })).toBe(true);
    expect(fireEvent.keyDown(first, { key: "ArrowDown", metaKey: true })).toBe(true);
    expect(document.activeElement).toBe(first);
    // A plain arrow still moves to the next row.
    expect(fireEvent.keyDown(first, { key: "ArrowDown" })).toBe(false);
    expect(document.activeElement).toBe(second);
  });

  test("Escape on a row's More actions button closes its menu and keeps the focus on the button", async () => {
    renderSidebar();
    await waitFor(() => expect(screen.getByText("Newest chat")).toBeTruthy());
    const more = screen.getByRole("button", { name: "More actions for Newest chat" });
    fireEvent.click(more);
    expect(screen.getByRole("menu", { name: "Actions for Newest chat" })).toBeTruthy();
    more.focus();
    fireEvent.keyDown(more, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(more);
  });

  test("Escape inside the menu closes it and puts the focus back on that chat's More actions button", async () => {
    renderSidebar({ renameAvailable: true });
    await waitFor(() => expect(screen.getByText("Newest chat")).toBeTruthy());
    const more = screen.getByRole("button", { name: "More actions for Newest chat" });
    fireEvent.click(more);
    const menu = screen.getByRole("menu", { name: "Actions for Newest chat" });
    // Tab from the More actions button lands on the menu's first item, Rename.
    const rename = within(menu).getByRole("menuitem", { name: "Rename Newest chat" });
    rename.focus();
    fireEvent.keyDown(rename, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(more);
  });

  test("the tab stop starts on the open chat's row, so Tab back into the list lands on it", async () => {
    renderSidebar({
      catalog: modelWithSessions([
        session("first", "2026-10-05T00:00:00.000Z", "First chat"),
        session("second", "2026-10-04T00:00:00.000Z", "Second chat"),
        session("third", "2026-10-03T00:00:00.000Z", "Third chat"),
      ]),
      currentThreadId: ThreadIdSchema.parse("second"),
    });
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(3));
    const [first, second] = screen.getAllByRole("option");
    expect(second?.getAttribute("tabindex")).toBe("0");
    expect(first?.getAttribute("tabindex")).toBe("-1");
  });

  test("the list is not a tab stop of its own: the focused row and its More actions button are", async () => {
    renderSidebar({
      catalog: modelWithSessions([
        session("first", "2026-10-05T00:00:00.000Z", "First chat"),
        session("second", "2026-10-04T00:00:00.000Z", "Second chat"),
        session("third", "2026-10-03T00:00:00.000Z", "Third chat"),
      ]),
    });
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(3));
    expect(screen.getByRole("listbox", { name: "Session list" }).hasAttribute("tabindex")).toBe(
      false,
    );
    const [first, second, third] = screen.getAllByRole("option");
    expect(first?.getAttribute("tabindex")).toBe("0");
    expect(second?.getAttribute("tabindex")).toBe("-1");
    expect(third?.getAttribute("tabindex")).toBe("-1");
    const more = (title: string) =>
      screen.getByRole("button", { name: `More actions for ${title}` });
    expect(more("First chat").getAttribute("tabindex")).toBe("0");
    expect(more("Second chat").getAttribute("tabindex")).toBe("-1");
    expect(more("Third chat").getAttribute("tabindex")).toBe("-1");
  });

  test("a reorder under the focused row keeps Enter and the arrow keys on that row's chat", async () => {
    const opened: string[] = [];
    const files = [
      session("first", "2026-10-05T00:00:00.000Z", "First chat"),
      session("second", "2026-10-04T00:00:00.000Z", "Second chat"),
      session("third", "2026-10-03T00:00:00.000Z", "Third chat"),
    ];
    const catalog = modelWithSessions(files);
    renderSidebar({
      catalog,
      onOpenThread: async (threadId) => {
        opened.push(threadId);
      },
    });
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(3));
    const second = screen.getByRole("option", { name: /Second chat/ });
    second.focus();
    expect(document.activeElement).toBe(second);

    // The second chat becomes the newest, so the list reorders while its row has focus.
    const newest = session("second", "2026-10-06T00:00:00.000Z", "Second chat");
    files[1] = newest;
    await act(async () => {
      await catalog.reconcile({
        folder,
        sessionFile: newest.sessionFile,
        id: newest.id,
        kind: "updated",
      });
    });
    await waitFor(() =>
      expect(screen.getAllByRole("option")[0]?.textContent).toContain("Second chat"),
    );
    expect(document.activeElement).toBe(second);

    // Enter opens the chat the focused row shows, not the chat now at the position the focus had.
    fireEvent.keyDown(second, { key: "Enter" });
    await waitFor(() => expect(opened).toEqual(["second"]));

    // The arrow keys go to the focused row's neighbour in the new order: the first chat, now second in the list.
    fireEvent.keyDown(second, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("option", { name: /First chat/ }));
  });

  test("inline rename calls the typed adapter and unavailable actions expose reasons", async () => {
    const { calls } = renderSidebar();
    await waitFor(() => expect(screen.getByText("Newest chat")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "More actions for Newest chat" }));
    const menu = screen.getByRole("menu", { name: "Actions for Newest chat" });
    const rename = within(menu).getByRole("menuitem", { name: "Rename Newest chat" });
    expect((rename as HTMLButtonElement).disabled).toBe(true);
    expect(rename.getAttribute("title")).toBeTruthy();
    expect(
      (within(menu).getByRole("menuitem", { name: "Archive Newest chat" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (within(menu).getByRole("menuitem", { name: "Delete Newest chat" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (within(menu).getByRole("menuitem", { name: "Pin Newest chat" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(calls).toEqual([]);
  });

  test("Delete asks first, and a chat stays when the question is answered no", async () => {
    const calls: string[] = [];
    const asked: string[] = [];
    render(
      withRegistry(
        createRegistry([]),
        { "host.session-files": { state: "available", via: "rpc" } },
        <SessionCatalogSidebar
          catalog={modelWithSessions()}
          confirmDelete={(_session, title) => {
            asked.push(title);
            return false;
          }}
          remote={fakeRemote(calls)}
        />,
      ),
    );
    await waitFor(() => expect(screen.getByText("Newest chat")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "More actions for Newest chat" }));
    const menu = screen.getByRole("menu", { name: "Actions for Newest chat" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Delete Newest chat" }));
    await waitFor(() => expect(asked).toEqual(["Newest chat"]));
    expect(calls).toEqual([]);
    expect(screen.getByText("Newest chat")).toBeTruthy();
  });

  test("deleting the open chat asks the server first: a refusal shows as its sentence, and the chat stays open", async () => {
    const calls: string[] = [];
    const opened: string[] = [];
    const refused = new AppFailure({
      code: "conflict",
      message: "Close this chat before deleting it: omp has it open.",
      retryable: true,
    });
    const remote = {
      ...fakeRemote(calls),
      delete: async (id: string) => {
        calls.push(`delete:${id}`);
        throw refused;
      },
    };
    render(
      withRegistry(
        createRegistry([]),
        { "host.session-files": { state: "available", via: "rpc" } },
        <SessionCatalogSidebar
          catalog={modelWithSessions()}
          confirmDelete={() => true}
          currentThreadId={ThreadIdSchema.parse("new")}
          onNewChat={async (threadId) => {
            opened.push(threadId);
          }}
          remote={remote}
        />,
      ),
    );
    await waitFor(() => expect(screen.getByText("Newest chat")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "More actions for Newest chat" }));
    const menu = screen.getByRole("menu", { name: "Actions for Newest chat" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Delete Newest chat" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Close this chat before deleting it: omp has it open.");
    // The server refused, so no new chat starts: the person stays in the chat they were in.
    expect(calls).toEqual(["delete:new"]);
    expect(opened).toEqual([]);
  });

  test("deleting the open chat clears the active view after the server has deleted it", async () => {
    const calls: string[] = [];
    const events: string[] = [];
    const remote = {
      ...fakeRemote(calls),
      delete: async (id: string) => {
        calls.push(`delete:${id}`);
        events.push("delete");
      },
    };
    render(
      withRegistry(
        createRegistry([]),
        { "host.session-files": { state: "available", via: "rpc" } },
        <SessionCatalogSidebar
          catalog={modelWithSessions()}
          confirmDelete={() => true}
          currentThreadId={ThreadIdSchema.parse("new")}
          onDeletedOpenThread={() => {
            events.push("close");
          }}
          onNewChat={async () => {
            events.push("new");
          }}
          remote={remote}
        />,
      ),
    );
    await waitFor(() => expect(screen.getByText("Newest chat")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "More actions for Newest chat" }));
    const menu = screen.getByRole("menu", { name: "Actions for Newest chat" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Delete Newest chat" }));
    await waitFor(() => expect(events).toEqual(["delete", "close"]));
    expect(calls).toEqual(["delete:new"]);
  });

  test("a chat the person picks while the server answers keeps the selection: no new chat takes its place", async () => {
    const calls: string[] = [];
    const statuses: unknown[] = [];
    const deleting = Promise.withResolvers<void>();
    const remote = {
      ...fakeRemote(calls),
      delete: async (id: string) => {
        calls.push(`delete:${id}`);
        await deleting.promise;
      },
    };
    render(
      withRegistry(
        createRegistry([]),
        { "host.session-files": { state: "available", via: "rpc" } },
        <SessionCatalogSidebar
          catalog={modelWithSessions()}
          confirmDelete={() => true}
          currentThreadId={ThreadIdSchema.parse("new")}
          onNewChatStatus={(status) => statuses.push(status)}
          remote={remote}
        />,
      ),
    );
    await waitFor(() => expect(screen.getByText("Newest chat")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "More actions for Newest chat" }));
    const menu = screen.getByRole("menu", { name: "Actions for Newest chat" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Delete Newest chat" }));
    await waitFor(() => expect(calls).toEqual(["delete:new"]));
    // The person picks the older chat while the server still answers for the deleted one. The pick finishes first.
    fireEvent.click(screen.getByRole("option", { name: /Old chat/ }));
    await waitFor(() => expect(calls).toEqual(["delete:new", "initialize:old"]));
    deleting.resolve();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("option", { name: /Old chat/ })),
    );
    expect(calls).toEqual(["delete:new", "initialize:old"]);
    expect(statuses).toEqual([]);
  });

  test("a chat the person is still opening when the server answers is kept: no new chat starts over it", async () => {
    const calls: string[] = [];
    const statuses: unknown[] = [];
    const deleting = Promise.withResolvers<void>();
    const opening = Promise.withResolvers<{ remoteId: string }>();
    const remote = {
      ...fakeRemote(calls),
      initialize: async (id: string) => {
        calls.push(`initialize:${id}`);
        return id === "old" ? opening.promise : { remoteId: id };
      },
      delete: async (id: string) => {
        calls.push(`delete:${id}`);
        await deleting.promise;
      },
    };
    render(
      withRegistry(
        createRegistry([]),
        { "host.session-files": { state: "available", via: "rpc" } },
        <SessionCatalogSidebar
          catalog={modelWithSessions()}
          confirmDelete={() => true}
          currentThreadId={ThreadIdSchema.parse("new")}
          onNewChatStatus={(status) => statuses.push(status)}
          remote={remote}
        />,
      ),
    );
    await waitFor(() => expect(screen.getByText("Newest chat")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "More actions for Newest chat" }));
    const menu = screen.getByRole("menu", { name: "Actions for Newest chat" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Delete Newest chat" }));
    await waitFor(() => expect(calls).toEqual(["delete:new"]));
    // The older chat is still opening (its open is held) when the server answers for the deleted one.
    fireEvent.click(screen.getByRole("option", { name: /Old chat/ }));
    await waitFor(() => expect(calls).toEqual(["delete:new", "initialize:old"]));
    deleting.resolve();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("option", { name: /Old chat/ })),
    );
    expect(calls).toEqual(["delete:new", "initialize:old"]);
    expect(statuses).toEqual([]);
    opening.resolve({ remoteId: "old" });
  });

  test("deleting the open chat while its turn runs keeps the chat open, and says why it is not deleted", async () => {
    const calls: string[] = [];
    render(
      withRegistry(
        createRegistry([]),
        { "host.session-files": { state: "available", via: "rpc" } },
        <SessionCatalogSidebar
          catalog={modelWithSessions()}
          confirmDelete={() => true}
          currentThreadId={ThreadIdSchema.parse("new")}
          currentTurnRunning={() => true}
          remote={fakeRemote(calls)}
        />,
      ),
    );
    await waitFor(() => expect(screen.getByText("Newest chat")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "More actions for Newest chat" }));
    const menu = screen.getByRole("menu", { name: "Actions for Newest chat" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Delete Newest chat" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Wait for this chat's turn to finish, then delete it.");
    // The chat stays on screen: no new chat is started, and the server is not asked to delete it yet.
    expect(calls).toEqual([]);
  });

  test("a refusal still shows after the sidebar that started the delete is rebuilt, because the catalog holds it", async () => {
    const calls: string[] = [];
    const gate = Promise.withResolvers<void>();
    const catalog = modelWithSessions();
    const remote = {
      ...fakeRemote(calls),
      delete: async (id: string) => {
        calls.push(`delete:${id}`);
        await gate.promise;
        throw new AppFailure({
          code: "conflict",
          message: "Close this chat before deleting it: omp has it open.",
          retryable: true,
        });
      },
    };
    const registry = { "host.session-files": { state: "available", via: "rpc" } } as const;
    const sidebar = (
      <SessionCatalogSidebar
        catalog={catalog}
        confirmDelete={() => true}
        currentThreadId={ThreadIdSchema.parse("other")}
        remote={remote}
      />
    );
    const first = render(withRegistry(createRegistry([]), registry, sidebar));
    await waitFor(() => expect(screen.getByText("Newest chat")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "More actions for Newest chat" }));
    const menu = screen.getByRole("menu", { name: "Actions for Newest chat" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Delete Newest chat" }));
    await waitFor(() => expect(calls).toHaveLength(1));

    // The chat switch rebuilds the sidebar while the server is still answering.
    first.unmount();
    render(withRegistry(createRegistry([]), registry, sidebar));
    gate.resolve();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Close this chat before deleting it: omp has it open.");
  });

  test("a delete the server refuses for a running turn clears its line when that turn ends", async () => {
    const running = {
      ...session("new", "2026-10-03T00:00:00.000Z", "Newest chat"),
      turn: "running" as const,
    };
    const files: SessionFile[] = [session("old", "2026-10-01T00:00:00.000Z", "Old chat"), running];
    const catalog = new SessionCatalogModel({
      scope,
      sessionFiles: {
        listSessions: async () => ({ sessions: files, nextCursor: null }),
        readSessionRow: async ({ sessionFile }) =>
          files.find((file) => file.sessionFile === sessionFile) as SessionFile,
      },
    });
    const remote = {
      ...fakeRemote([]),
      delete: async () => {
        throw new AppFailure({
          code: "conflict",
          message: "Wait for this chat's turn to finish, then delete it.",
          retryable: true,
        });
      },
    };
    render(
      withRegistry(
        createRegistry([]),
        { "host.session-files": { state: "available", via: "rpc" } },
        <SessionCatalogSidebar
          catalog={catalog}
          confirmDelete={() => true}
          currentThreadId={ThreadIdSchema.parse("other")}
          remote={remote}
        />,
      ),
    );
    await waitFor(() => expect(screen.getByText("Newest chat")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "More actions for Newest chat" }));
    const menu = screen.getByRole("menu", { name: "Actions for Newest chat" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Delete Newest chat" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Wait for this chat's turn to finish, then delete it.");

    // The turn ends: omp writes the chat's file idle, and the catalog reads that change.
    files[1] = { ...running, turn: "idle" as const };
    await act(async () => {
      await catalog.reconcile({
        folder,
        sessionFile: running.sessionFile,
        id: running.id,
        kind: "updated",
      });
    });
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  /** Renders a sidebar whose Delete the server refuses, and waits until the refusal shows. */
  async function showRefusedDelete(): Promise<void> {
    const calls: string[] = [];
    const remote = {
      ...fakeRemote(calls),
      delete: async (id: string) => {
        calls.push(`delete:${id}`);
        throw new AppFailure({
          code: "conflict",
          message: "Close this chat before deleting it: omp has it open.",
          retryable: true,
        });
      },
    };
    render(
      withRegistry(
        createRegistry([]),
        { "host.session-files": { state: "available", via: "rpc" } },
        <SessionCatalogSidebar
          catalog={modelWithSessions()}
          confirmDelete={() => true}
          currentThreadId={ThreadIdSchema.parse("other")}
          remote={remote}
        />,
      ),
    );
    await waitFor(() => expect(screen.getByText("Newest chat")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "More actions for Newest chat" }));
    const menu = screen.getByRole("menu", { name: "Actions for Newest chat" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Delete Newest chat" }));
    await screen.findByRole("alert");
  }

  test("a refusal stays on the list until the person does something in it", async () => {
    await showRefusedDelete();
    expect(screen.getByRole("alert").textContent).toBe(
      "Close this chat before deleting it: omp has it open.",
    );
  });

  test("opening a chat clears a refusal", async () => {
    await showRefusedDelete();
    fireEvent.click(screen.getByRole("option", { name: /Newest chat/ }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  test("starting a new chat clears a refusal", async () => {
    await showRefusedDelete();
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  test("opening a chat's menu clears a refusal", async () => {
    await showRefusedDelete();
    fireEvent.click(screen.getByRole("button", { name: "More actions for Newest chat" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  test("starting a rename clears a refusal", async () => {
    await showRefusedDelete();
    fireEvent.click(screen.getByRole("button", { name: "More actions for Newest chat" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename Newest chat" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  test("typing in the search clears a refusal", async () => {
    await showRefusedDelete();
    fireEvent.change(screen.getByPlaceholderText("Search sessions"), {
      target: { value: "newest" },
    });
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  /** A remote whose delete takes the chat out of the catalog, as the server's removed event does. */
  function removingRemote(catalog: SessionCatalogModel, files: SessionFile[]) {
    return {
      ...fakeRemote([]),
      delete: async (id: string) => {
        const gone = files.find((file) => file.id === id);
        if (gone === undefined) throw new Error(`no chat ${id}`);
        files.splice(files.indexOf(gone), 1);
        await act(async () => {
          await catalog.reconcile({
            folder,
            sessionFile: gone.sessionFile,
            id: gone.id,
            kind: "removed",
          });
        });
      },
    };
  }

  /** Renders a sidebar over the given chats, with the session-file port available. */
  function renderOverRemote(
    catalog: SessionCatalogModel,
    remote: ReturnType<typeof removingRemote>,
  ) {
    return render(
      withRegistry(
        createRegistry([]),
        { "host.session-files": { state: "available", via: "rpc" } },
        <SessionCatalogSidebar
          catalog={catalog}
          confirmDelete={() => true}
          currentThreadId={ThreadIdSchema.parse("other")}
          remote={remote}
        />,
      ),
    );
  }

  /** Deletes the chat with this title from its More actions menu. */
  function deleteFromMenu(title: string): void {
    fireEvent.click(screen.getByRole("button", { name: `More actions for ${title}` }));
    fireEvent.click(
      within(screen.getByRole("menu", { name: `Actions for ${title}` })).getByRole("menuitem", {
        name: `Delete ${title}`,
      }),
    );
  }

  test("deleting a chat moves focus to the next row, and the tab stop follows it", async () => {
    const files = [
      session("old", "2026-10-01T00:00:00.000Z", "Old chat"),
      session("new", "2026-10-03T00:00:00.000Z", "Newest chat"),
      session("middle", "2026-10-02T00:00:00.000Z", "Middle chat"),
    ];
    const catalog = modelWithSessions(files);
    renderOverRemote(catalog, removingRemote(catalog, files));
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(3));

    deleteFromMenu("Middle chat");
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));
    const next = screen.getByRole("option", { name: /Old chat/ });
    await waitFor(() => expect(document.activeElement).toBe(next));
    expect(next.getAttribute("tabindex")).toBe("0");
  });

  test("deleting the last row moves focus to the row above it", async () => {
    const files = [
      session("old", "2026-10-01T00:00:00.000Z", "Old chat"),
      session("new", "2026-10-03T00:00:00.000Z", "Newest chat"),
    ];
    const catalog = modelWithSessions(files);
    renderOverRemote(catalog, removingRemote(catalog, files));
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));

    deleteFromMenu("Old chat");
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(1));
    const above = screen.getByRole("option", { name: /Newest chat/ });
    await waitFor(() => expect(document.activeElement).toBe(above));
    expect(above.getAttribute("tabindex")).toBe("0");
  });

  test("a refused delete leaves focus on the chat's own row", async () => {
    const files = [
      session("old", "2026-10-01T00:00:00.000Z", "Old chat"),
      session("new", "2026-10-03T00:00:00.000Z", "Newest chat"),
    ];
    const catalog = modelWithSessions(files);
    const refusing = {
      ...fakeRemote([]),
      delete: async () => {
        throw new AppFailure({
          code: "conflict",
          message: "Close this chat before deleting it: omp has it open.",
          retryable: true,
        });
      },
    };
    renderOverRemote(catalog, refusing);
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));

    deleteFromMenu("Newest chat");
    await screen.findByRole("alert");
    const own = screen.getByRole("option", { name: /Newest chat/ });
    await waitFor(() => expect(document.activeElement).toBe(own));
  });

  test("deleting the only chat moves focus to New chat", async () => {
    const files = [session("only", "2026-10-02T00:00:00.000Z", "Only chat")];
    const catalog = modelWithSessions(files);
    renderOverRemote(catalog, removingRemote(catalog, files));
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(1));

    deleteFromMenu("Only chat");
    await waitFor(() => expect(screen.queryAllByRole("option")).toHaveLength(0));
    await waitFor(() => expect(document.activeElement?.textContent).toBe("New chat"));
  });

  test("Delete is disabled, with a reason, when the session-file port is not available", async () => {
    render(
      withRegistry(
        createRegistry([]),
        {},
        <SessionCatalogSidebar catalog={modelWithSessions()} remote={fakeRemote([])} />,
      ),
    );
    await waitFor(() => expect(screen.getByText("Newest chat")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "More actions for Newest chat" }));
    const menu = screen.getByRole("menu", { name: "Actions for Newest chat" });
    const remove = within(menu).getByRole("menuitem", { name: "Delete Newest chat" });
    expect((remove as HTMLButtonElement).disabled).toBe(true);
    expect(remove.getAttribute("title")).toBe("Deleting a chat isn't available in the app yet.");
  });

  test("empty folders keep a recoverable New chat action", async () => {
    const model = new SessionCatalogModel({
      scope,
      sessionFiles: {
        listSessions: async () => ({ sessions: [], nextCursor: null }),
        readSessionRow: async () => session("never", "2026-10-01T00:00:00.000Z"),
      },
    });
    const calls: string[] = [];
    renderSidebar({
      catalog: model,
      onNewChat: async (threadId) => {
        calls.push(threadId);
      },
    });
    await waitFor(() => expect(screen.getByText("No sessions in this folder")).toBeTruthy());
    const buttons = screen.getAllByRole("button", { name: "New chat" });
    fireEvent.click(buttons.at(-1) as HTMLElement);
    await waitFor(() => expect(calls).toEqual(["new"]));
  });

  test("a New chat that a later pick superseded opens nothing once it finishes", async () => {
    const newChatDone = Promise.withResolvers<void>();
    const opened: string[] = [];
    const calls: string[] = [];
    renderSidebar({
      remote: {
        ...fakeRemote(calls),
        initialize: async (id: string) => {
          if (id !== "new") return { remoteId: id };
          await newChatDone.promise;
          throw new AppFailure({ code: "cancelled", message: "Superseded", retryable: false });
        },
      },
      onNewChat: async (threadId) => {
        opened.push(`new:${threadId}`);
      },
      onOpenThread: async (threadId) => {
        opened.push(`open:${threadId}`);
      },
    });
    await waitFor(() => expect(screen.getByText("Old chat")).toBeTruthy());
    fireEvent.click(screen.getAllByRole("button", { name: "New chat" })[0] as HTMLElement);
    fireEvent.click(screen.getByRole("option", { name: /Old chat/ }));
    await waitFor(() => expect(opened).toEqual(["open:old"]));

    newChatDone.resolve();
    const { promise: settled, resolve: settle } = Promise.withResolvers<void>();
    setTimeout(settle, 0);
    await act(() => settled);
    expect(opened).toEqual(["open:old"]);
  });

  test("a search with no match says which chats were searched for, with no New chat prompt", async () => {
    renderSidebar();
    await waitFor(() => expect(screen.getByText("Newest chat")).toBeTruthy());
    const search = screen.getByRole("textbox", { name: "Search sessions" });
    fireEvent.change(search, { target: { value: "zzzz" } });
    await waitFor(() => expect(screen.getByText('No chats match "zzzz"')).toBeTruthy());
    expect(screen.queryByText("No sessions in this folder")).toBeNull();
    expect(screen.queryByText("Start a new chat to create an omp session.")).toBeNull();
    fireEvent.change(search, { target: { value: "" } });
    await waitFor(() => expect(screen.getByText("Newest chat")).toBeTruthy());
  });

  test("'Show older chats' loads the next page below the list, then goes away at the end", async () => {
    const all = Array.from({ length: 70 }, (_, index) =>
      session(
        `chat-${String(index).padStart(2, "0")}`,
        new Date(Date.UTC(2026, 9, 5) - index * 60_000).toISOString(),
        `Chat number ${index}`,
      ),
    );
    const model = new SessionCatalogModel({
      scope,
      sessionFiles: {
        listSessions: async ({ cursor, limit }) => {
          const start = cursor === undefined ? 0 : Number.parseInt(cursor, 10);
          const end = Math.min(start + (limit ?? 100), all.length);
          return {
            sessions: all.slice(start, end),
            nextCursor: end < all.length ? String(end) : null,
          };
        },
        readSessionRow: async () => all[0] as SessionFile,
      },
    });
    renderSidebar({ catalog: model });
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(50));
    expect(screen.queryByText("Chat number 69")).toBeNull();

    // The button sits outside the listbox (a listbox holds only options).
    const button = screen.getByRole("button", { name: "Show older chats" });
    expect(screen.getByRole("listbox", { name: "Session list" }).contains(button)).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(70));
    expect(screen.getByText("Chat number 69")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /older chats/ })).toBeNull();
  });

  test("a failed 'Show older chats' says so in plain words, keeps the list, and Try again works", async () => {
    const all = Array.from({ length: 60 }, (_, index) =>
      session(
        `chat-${String(index).padStart(2, "0")}`,
        new Date(Date.UTC(2026, 9, 5) - index * 60_000).toISOString(),
        `Chat number ${index}`,
      ),
    );
    let failing = true;
    const model = new SessionCatalogModel({
      scope,
      sessionFiles: {
        listSessions: async ({ cursor, limit }) => {
          if (failing && cursor === "50") throw new Error("the disk is busy");
          const start = cursor === undefined ? 0 : Number.parseInt(cursor, 10);
          const end = Math.min(start + (limit ?? 100), all.length);
          return {
            sessions: all.slice(start, end),
            nextCursor: end < all.length ? String(end) : null,
          };
        },
        readSessionRow: async () => all[0] as SessionFile,
      },
    });
    renderSidebar({ catalog: model });
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(50));
    fireEvent.click(screen.getByRole("button", { name: "Show older chats" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("Couldn't load older chats"),
    );
    expect(screen.getByRole("alert").textContent).toContain("the disk is busy");
    expect(screen.getAllByRole("option")).toHaveLength(50);

    failing = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(60));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("a 'Show older chats' the server refuses reads the list again with no message, and the next click loads older chats", async () => {
    const all = Array.from({ length: 70 }, (_, index) =>
      session(
        `chat-${String(index).padStart(2, "0")}`,
        new Date(Date.UTC(2026, 9, 5) - index * 60_000).toISOString(),
        `Chat number ${index}`,
      ),
    );
    let firstPageIsStale = true;
    const model = new SessionCatalogModel({
      scope,
      sessionFiles: {
        listSessions: async ({ cursor, limit }) => {
          if (cursor === "stale") {
            throw new AppFailure({
              code: "invalid_args",
              message: "Invalid session-list cursor",
              retryable: false,
            });
          }
          const start = cursor === undefined ? 0 : Number.parseInt(cursor, 10);
          const end = Math.min(start + (limit ?? 100), all.length);
          // The first page came from before the server changed, so the cursor it gave is stale.
          const stale = cursor === undefined && firstPageIsStale;
          if (stale) firstPageIsStale = false;
          return {
            sessions: all.slice(start, end),
            nextCursor: stale ? "stale" : end < all.length ? String(end) : null,
          };
        },
        readSessionRow: async () => all[0] as SessionFile,
      },
    });
    renderSidebar({ catalog: model });
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(50));
    fireEvent.click(screen.getByRole("button", { name: "Show older chats" }));
    // The list is read again from its start: the cursor is replaced, and no message says why.
    await waitFor(() => expect(model.getSnapshot().nextCursor).toBe("50"));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getAllByRole("option")).toHaveLength(50);

    fireEvent.click(screen.getByRole("button", { name: "Show older chats" }));
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(70));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("Enter in the rename box saves the title and keeps the current chat open", async () => {
    const opened: string[] = [];
    const { calls } = renderSidebar({
      renameAvailable: true,
      onOpenThread: async (threadId) => {
        opened.push(threadId);
      },
    });
    await waitFor(() => expect(screen.getByText("Newest chat")).toBeTruthy());
    startRename("Newest chat");
    const box = screen.getByRole("textbox", { name: "Rename Newest chat" });
    fireEvent.change(box, { target: { value: "Renamed by Enter" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(calls).toEqual(["rename:new:Renamed by Enter"]));
    expect(opened).toEqual([]);
  });

  test("the rename box opens with the title's own words, not omp's card; saving them unchanged renames nothing", async () => {
    const files = [
      {
        ...session("card", "2026-10-03T00:00:00.000Z", "🧪 FLAKY: Fix flaky park tests"),
        displayTitle: "Fix flaky park tests",
      },
    ];
    const catalog = new SessionCatalogModel({
      scope,
      sessionFiles: {
        listSessions: async () => ({ sessions: files, nextCursor: null }),
        readSessionRow: async () => files[0] ?? session("missing", "2026-10-01T00:00:00.000Z"),
      },
    });
    const { calls } = renderSidebar({ catalog, renameAvailable: true });
    await waitFor(() => expect(screen.getByText("Fix flaky park tests")).toBeTruthy());
    startRename("Fix flaky park tests");
    const box = screen.getByRole("textbox", { name: "Rename Fix flaky park tests" });
    expect(box instanceof HTMLInputElement ? box.value : undefined).toBe("Fix flaky park tests");
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() =>
      expect(screen.queryByRole("textbox", { name: "Rename Fix flaky park tests" })).toBeNull(),
    );
    expect(calls).toEqual([]);
  });

  test("Enter on a row's More actions button is left to the button, and opens no chat", async () => {
    const opened: string[] = [];
    renderSidebar({
      renameAvailable: true,
      onOpenThread: async (threadId) => {
        opened.push(threadId);
      },
    });
    await waitFor(() => expect(screen.getByText("Newest chat")).toBeTruthy());
    const more = screen.getByRole("button", { name: "More actions for Newest chat" });
    // A browser turns Enter on a button into a click only when the keydown is not cancelled.
    expect(fireEvent.keyDown(more, { key: "Enter" })).toBe(true);
    expect(opened).toEqual([]);
  });

  test("arrow and Home keys in the rename box are left to the text box, not the list", async () => {
    renderSidebar({ renameAvailable: true });
    await waitFor(() => expect(screen.getByText("Newest chat")).toBeTruthy());
    startRename("Newest chat");
    const box = screen.getByRole("textbox", { name: "Rename Newest chat" });
    expect(fireEvent.keyDown(box, { key: "ArrowDown" })).toBe(true);
    expect(fireEvent.keyDown(box, { key: "Home" })).toBe(true);
  });

  test("a rename omp refuses keeps the box open with omp's reason, and opens nothing", async () => {
    const opened: string[] = [];
    const calls: string[] = [];
    renderSidebar({
      renameAvailable: true,
      onOpenThread: async (threadId) => {
        opened.push(threadId);
      },
      remote: {
        ...fakeRemote(calls),
        rename: async () => {
          throw new AppFailure({
            code: "conflict",
            message: "Another omp is using this chat, so it cannot be renamed right now.",
            retryable: true,
          });
        },
      },
    });
    await waitFor(() => expect(screen.getByText("Newest chat")).toBeTruthy());
    startRename("Newest chat");
    const box = screen.getByRole("textbox", { name: "Rename Newest chat" });
    fireEvent.change(box, { target: { value: "Refused" } });
    fireEvent.keyDown(box, { key: "Enter" });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Another omp is using this chat");
    expect(
      (screen.getByRole("textbox", { name: "Rename Newest chat" }) as HTMLInputElement).value,
    ).toBe("Refused");
    expect(opened).toEqual([]);
  });

  test("a renamed chat shows its new title in the list at once, read back from its file", async () => {
    const files: SessionFile[] = [
      session("new", "2026-10-03T00:00:00.000Z", "Newest chat"),
      session("old", "2026-10-01T00:00:00.000Z", "Old chat"),
    ];
    const catalog = new SessionCatalogModel({
      scope,
      sessionFiles: {
        listSessions: async () => ({ sessions: files, nextCursor: null }),
        readSessionRow: async ({ sessionFile }) =>
          files.find((file) => file.sessionFile === sessionFile) as SessionFile,
      },
    });
    // The rename port saves the title into the chat's file, as omp does; the list reads it back.
    const remote = createNativeRemoteThreadListAdapter({
      catalog,
      open: async () => {
        throw new AppFailure({ code: "not_found", message: "Not opened here", retryable: false });
      },
      rename: async ({ threadId, name }) => {
        const index = files.findIndex((file) => file.id === threadId);
        const file = files[index];
        if (file === undefined) throw new Error(`No chat ${threadId}`);
        files[index] = { ...file, title: name, displayTitle: name };
        return null;
      },
    });
    renderSidebar({ catalog, remote, renameAvailable: true });
    await waitFor(() => expect(screen.getByText("Newest chat")).toBeTruthy());
    startRename("Newest chat");
    const box = screen.getByRole("textbox", { name: "Rename Newest chat" });
    fireEvent.change(box, { target: { value: "Renamed in place" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() =>
      expect(screen.getByRole("option", { name: /Renamed in place/ })).toBeTruthy(),
    );
    expect(screen.queryByText("Newest chat")).toBeNull();
  });

  test("while a rename is being saved the box is busy and read-only, and a second Enter starts no second rename", async () => {
    const calls: string[] = [];
    let release: () => void = () => undefined;
    const saving = new Promise<void>((resolve) => {
      release = resolve;
    });
    renderSidebar({
      renameAvailable: true,
      remote: {
        ...fakeRemote(calls),
        rename: async (id: string, title: string) => {
          calls.push(`rename:${id}:${title}`);
          await saving;
        },
      },
    });
    await waitFor(() => expect(screen.getByText("Newest chat")).toBeTruthy());
    startRename("Newest chat");
    const box = screen.getByRole("textbox", { name: "Rename Newest chat" }) as HTMLInputElement;
    fireEvent.change(box, { target: { value: "Busy title" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(box.getAttribute("aria-busy")).toBe("true"));
    expect(box.readOnly).toBe(true);
    expect(screen.getByText("Saving…")).toBeTruthy();
    fireEvent.keyDown(box, { key: "Enter" });
    expect(calls).toEqual(["rename:new:Busy title"]);
    await act(async () => {
      release();
    });
    await waitFor(() =>
      expect(screen.queryByRole("textbox", { name: "Rename Newest chat" })).toBeNull(),
    );
    expect(calls).toEqual(["rename:new:Busy title"]);
  });

  test("after Enter saves a rename, the renamed chat's row has the focus and the roving focus", async () => {
    renderSidebar({ renameAvailable: true });
    await waitFor(() => expect(screen.getByText("Newest chat")).toBeTruthy());
    startRename("Newest chat");
    const box = screen.getByRole("textbox", { name: "Rename Newest chat" });
    fireEvent.change(box, { target: { value: "Focus after save" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("option", { name: /Newest chat/ })),
    );
    expect(screen.getByRole("option", { name: /Newest chat/ }).getAttribute("tabindex")).toBe("0");
    expect(screen.getByRole("option", { name: /Old chat/ }).getAttribute("tabindex")).toBe("-1");
  });

  test("Escape cancels a rename and gives the focus back to the chat's row, not the whole list", async () => {
    renderSidebar({ renameAvailable: true });
    await waitFor(() => expect(screen.getByText("Newest chat")).toBeTruthy());
    startRename("Newest chat");
    const box = screen.getByRole("textbox", { name: "Rename Newest chat" });
    fireEvent.keyDown(box, { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "Rename Newest chat" })).toBeNull();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("option", { name: /Newest chat/ })),
    );
  });

  test("a list that fails when the sidebar opens is shown with a retry, and nothing is left unhandled", async () => {
    const catalog = new SessionCatalogModel({
      scope,
      sessionFiles: {
        listSessions: async () => {
          throw new AppFailure({
            code: "unavailable",
            message: "Connection to the app server closed",
            retryable: true,
          });
        },
        readSessionRow: async () => {
          throw new Error("No session is read in this test");
        },
      },
    });
    renderSidebar({ catalog });
    expect(await screen.findByRole("button", { name: "Retry" })).toBeTruthy();
  });

  /** A chat omp branched from `parentId` (a regenerated answer or an edit), made at `createdAt`. */
  function branchOf(
    id: string,
    parentId: string,
    createdAt: SessionFile["createdAt"],
    title: string,
  ): SessionFile {
    return {
      ...session(id, "2026-10-05T12:00:00.000Z", title),
      createdAt,
      parentSession: SessionFilePath.parse(`${folder}/.omp/${parentId}.jsonl`),
    };
  }

  test("a branch row has its own marker line with the time it was made, and its source row has none", async () => {
    const source = session("source", "2026-10-05T10:00:00.000Z", "Count reply");
    const branch = branchOf("branch", "source", "2026-10-05T11:00:01.000Z", "Count reply");
    renderSidebar({ catalog: modelWithSessions([source, branch]) });
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));
    const [branchRow, sourceRow] = screen.getAllByRole("option");
    expect(branchRow?.textContent).toContain("Branch made");
    expect(sourceRow?.textContent).not.toContain("Branch made");
    expect(screen.getByText(/^Branch made /).getAttribute("title")).toMatch(
      /^Branch of Count reply, made /,
    );
  });

  test("a branch row shows one time line, the time it was made, and its source row keeps its own time", async () => {
    const source = session("source", "2026-10-05T10:00:00.000Z", "Count reply");
    const branch = branchOf("branch", "source", "2026-10-05T11:00:01.000Z", "Count reply");
    renderSidebar({ catalog: modelWithSessions([source, branch]) });
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));
    const [branchRow, sourceRow] = screen.getAllByRole("option");
    expect(branchRow?.textContent).toContain("Branch made");
    expect(branchRow?.querySelectorAll("time")).toHaveLength(0);
    expect(sourceRow?.querySelectorAll("time")).toHaveLength(1);
  });

  test("three branches of one chat each show their own marker, so no two rows read alike", async () => {
    const source = session("source", "2026-10-05T10:00:00.000Z", "Count reply");
    const branches = [
      branchOf("first", "source", "2026-10-05T11:00:01.000Z", "Count reply"),
      branchOf("second", "source", "2026-10-05T11:00:02.000Z", "Count reply"),
      branchOf("third", "source", "2026-10-05T11:00:03.000Z", "Count reply"),
    ];
    renderSidebar({ catalog: modelWithSessions([source, ...branches]) });
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(4));
    const markers = screen.getAllByText(/^Branch made /).map((element) => element.textContent);
    expect(markers).toHaveLength(3);
    expect(new Set(markers).size).toBe(3);
    const rows = screen.getAllByRole("option").map((row) => row.textContent);
    expect(new Set(rows).size).toBe(4);
  });

  test("a long source title does not hide a branch's marker: the marker is a line of its own", async () => {
    const longTitle = "Quarterly planning notes for the district budget review and staffing plan";
    const source = session("source", "2026-10-05T10:00:00.000Z", longTitle);
    const branch = branchOf("branch", "source", "2026-10-05T11:00:01.000Z", longTitle);
    renderSidebar({ catalog: modelWithSessions([source, branch]) });
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));
    const marker = screen.getByText(/^Branch made /);
    expect(marker.textContent).not.toContain("Quarterly");
    expect(marker.getAttribute("title")).toContain(longTitle);
  });

  test("a branch whose source is not in the list still reads as a branch, with the time it was made", async () => {
    const orphan = branchOf("orphan", "gone", "2026-10-05T11:00:01.000Z", "Count reply");
    renderSidebar({ catalog: modelWithSessions([orphan]) });
    await waitFor(() => expect(screen.getByText(/^Branch made /)).toBeTruthy());
    expect(screen.getByText(/^Branch made /).getAttribute("title")).toMatch(/^Branch, made /);
  });
});

describe("SessionCatalogSidebar New chat status", () => {
  test("reports opening while the new chat starts, and idle once it is open", async () => {
    const statuses: unknown[] = [];
    const newChatStarted = Promise.withResolvers<{ remoteId: string }>();
    renderSidebar({
      remote: {
        ...fakeRemote([]),
        initialize: async (id: string) =>
          id === "new" ? newChatStarted.promise : { remoteId: id },
      },
      onNewChat: async () => {},
      onNewChatStatus: (status) => statuses.push(status),
    });
    await waitFor(() => expect(screen.getByText("Newest chat")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    await waitFor(() => expect(statuses).toEqual([{ state: "opening" }]));
    newChatStarted.resolve({ remoteId: "thread-new" });
    await waitFor(() => expect(statuses).toEqual([{ state: "opening" }, { state: "idle" }]));
  });

  test("a chat picked while a New chat starts ends the New chat's opening, and the New chat does not open over the pick", async () => {
    const statuses: unknown[] = [];
    const opened: string[] = [];
    const newChatOpened: string[] = [];
    const newChatStarted = Promise.withResolvers<{ remoteId: string }>();
    renderSidebar({
      remote: {
        ...fakeRemote([]),
        initialize: async (id: string) =>
          id === "new" ? newChatStarted.promise : { remoteId: id },
      },
      onNewChat: async () => {
        newChatOpened.push("new");
      },
      onOpenThread: async (threadId) => {
        opened.push(threadId);
      },
      onNewChatStatus: (status) => statuses.push(status),
    });
    await waitFor(() => expect(screen.getByText("Newest chat")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    await waitFor(() => expect(statuses).toEqual([{ state: "opening" }]));
    // The person picks a chat while the New chat is still starting: the chat picked is the one on screen now.
    fireEvent.click(screen.getByRole("option", { name: /Newest chat/ }));
    await waitFor(() => expect(statuses).toEqual([{ state: "opening" }, { state: "idle" }]));
    // The New chat's answer comes after the pick: the New chat does not open over the chat picked.
    newChatStarted.resolve({ remoteId: "thread-new" });
    // The answer is read within a few turns of the event loop; the New chat then ends without a second report.
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
    expect(newChatOpened).toEqual([]);
    expect(statuses).toEqual([{ state: "opening" }, { state: "idle" }]);
    expect(opened).toHaveLength(1);
  });

  test("reports a New chat that fails with its reason, instead of leaving the page unchanged", async () => {
    const statuses: unknown[] = [];
    const failure = new AppFailure({
      code: "omp_exited",
      message: "omp stopped before it could open a chat.",
      retryable: true,
    });
    renderSidebar({
      remote: {
        ...fakeRemote([]),
        initialize: async (id: string) => {
          if (id === "new") throw failure;
          return { remoteId: id };
        },
      },
      onNewChatStatus: (status) => statuses.push(status),
    });
    await waitFor(() => expect(screen.getByText("Newest chat")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    await waitFor(() =>
      expect(statuses.at(-1)).toEqual({ state: "failed", error: failure.appError }),
    );
  });
});

describe("SessionCatalogSidebar rename box", () => {
  const untitled = () =>
    modelWithSessions([session("untitled", "2026-10-05T12:00:00.000Z", null, "Parser notes")]);

  test("opens with the title the row shows, all of it selected, and Escape cancels", async () => {
    const { calls } = renderSidebar({ renameAvailable: true, catalog: untitled() });
    await waitFor(() => expect(screen.getByText("Parser notes")).toBeTruthy());
    startRename("Parser notes");
    const box = screen.getByRole("textbox", { name: "Rename Parser notes" }) as HTMLInputElement;
    expect(box.value).toBe("Parser notes");
    expect(box.selectionStart).toBe(0);
    expect(box.selectionEnd).toBe("Parser notes".length);
    fireEvent.keyDown(box, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("textbox", { name: "Rename Parser notes" })).toBeNull(),
    );
    expect(calls).toEqual([]);
  });

  test("Enter without a change renames nothing", async () => {
    const { calls } = renderSidebar({ renameAvailable: true, catalog: untitled() });
    await waitFor(() => expect(screen.getByText("Parser notes")).toBeTruthy());
    startRename("Parser notes");
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Rename Parser notes" }), {
      key: "Enter",
    });
    await waitFor(() =>
      expect(screen.queryByRole("textbox", { name: "Rename Parser notes" })).toBeNull(),
    );
    expect(calls).toEqual([]);
  });
});

describe("SessionCatalogSidebar chords", () => {
  test("F2 opens the rename box of the chat whose row has focus", async () => {
    renderSidebar({ renameAvailable: true });
    await waitFor(() => expect(screen.getByText("Newest chat")).toBeTruthy());
    const row = screen.getByRole("option", { name: /Newest chat/ });
    row.focus();
    fireEvent.keyDown(row, { key: "F2" });
    expect(await screen.findByRole("textbox", { name: "Rename Newest chat" })).toBeTruthy();
  });

  test("a chord acts on the chat that has focus, wherever its row sits in the list", async () => {
    renderSidebar({ renameAvailable: true });
    await waitFor(() => expect(screen.getByText("Old chat")).toBeTruthy());
    const row = screen.getByRole("option", { name: /Old chat/ });
    row.focus();
    fireEvent.keyDown(row, { key: "F2" });
    expect(await screen.findByRole("textbox", { name: "Rename Old chat" })).toBeTruthy();
  });

  test("F2 does nothing while focus is outside the list", async () => {
    renderSidebar({ renameAvailable: true });
    await waitFor(() => expect(screen.getByText("Newest chat")).toBeTruthy());
    fireEvent.keyDown(screen.getByRole("button", { name: "New chat" }), { key: "F2" });
    expect(screen.queryByRole("textbox", { name: "Rename Newest chat" })).toBeNull();
  });

  test("Mod+Shift+Backspace asks first, and a chat stays when the question is answered no", async () => {
    const calls: string[] = [];
    const asked: string[] = [];
    render(
      withRegistry(
        createRegistry([]),
        { "host.session-files": { state: "available", via: "rpc" } },
        <SessionCatalogSidebar
          catalog={modelWithSessions()}
          confirmDelete={(_session, title) => {
            asked.push(title);
            return false;
          }}
          remote={fakeRemote(calls)}
        />,
      ),
    );
    await waitFor(() => expect(screen.getByText("Newest chat")).toBeTruthy());
    const row = screen.getByRole("option", { name: /Newest chat/ });
    row.focus();
    fireEvent.keyDown(row, { key: "Backspace", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(asked).toEqual(["Newest chat"]));
    expect(calls).toEqual([]);
  });

  test("Mod+Backspace deletes the chat that has focus without asking", async () => {
    const calls: string[] = [];
    const asked: string[] = [];
    render(
      withRegistry(
        createRegistry([]),
        { "host.session-files": { state: "available", via: "rpc" } },
        <SessionCatalogSidebar
          catalog={modelWithSessions()}
          confirmDelete={(_session, title) => {
            asked.push(title);
            return true;
          }}
          remote={fakeRemote(calls)}
        />,
      ),
    );
    await waitFor(() => expect(screen.getByText("Newest chat")).toBeTruthy());
    const row = screen.getByRole("option", { name: /Newest chat/ });
    row.focus();
    fireEvent.keyDown(row, { key: "Backspace", ctrlKey: true });
    await waitFor(() => expect(calls).toEqual(["delete:new"]));
    expect(asked).toEqual([]);
  });
});

describe("SessionCatalogSidebar running chats", () => {
  test("a chat whose turn runs with no session file yet has a Running row, selected while it is open", async () => {
    renderSidebar({
      catalog: modelWithRunning(["first-reply"]),
      currentThreadId: ThreadIdSchema.parse("first-reply"),
    });
    await waitFor(() => expect(screen.getByRole("option", { name: /New chat/ })).toBeTruthy());
    const row = screen.getByRole("option", { name: /New chat/ });
    expect(within(row).getByText("Running")).toBeTruthy();
    expect(row.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("button", { name: /More actions for New chat/ })).toBeTruthy();
    expect(screen.queryByText("No sessions in this folder")).toBeNull();
  });

  test("a no-file running chat confirms, stops before deletion, and focuses the row on failure", async () => {
    const asked: boolean[] = [];
    const events: string[] = [];
    const id = ThreadIdSchema.parse("first-reply");
    const remote = fakeRemote(events);
    renderSidebar({
      catalog: modelWithRunning(["first-reply"]),
      currentThreadId: id,
      confirmDeleteRunning: () => {
        asked.push(true);
        return true;
      },
      stopRunning: async () => {
        events.push("stop:first-reply");
      },
      remote,
      deleteAvailable: true,
    });
    await waitFor(() => expect(screen.getByRole("option", { name: /New chat/ })).toBeTruthy());
    const more = screen.getByRole("button", { name: /More actions for New chat/ });
    fireEvent.click(more);
    const menu = screen.getByRole("menu", { name: "Actions for New chat" });
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(document.activeElement).toBe(more);
    fireEvent.click(more);
    fireEvent.click(
      within(screen.getByRole("menu", { name: "Actions for New chat" })).getByRole("menuitem", {
        name: "Delete and stop New chat",
      }),
    );
    await waitFor(() =>
      expect(events.slice(0, 2)).toEqual(["stop:first-reply", "delete:first-reply"]),
    );
    expect(asked).toEqual([true]);
  });

  test("Cancel leaves a no-file running chat untouched, and an idle row has no stop action", async () => {
    const calls: string[] = [];
    const confirmed: string[] = [];
    const { calls: remoteCalls } = renderSidebar({
      catalog: modelWithRunning(
        ["first-reply"],
        [session("idle", "2026-10-03T00:00:00.000Z", "Idle chat")],
      ),
      confirmDeleteRunning: (title) => {
        confirmed.push(title);
        return false;
      },
      stopRunning: async () => {
        calls.push("stop");
      },
      deleteAvailable: true,
    });
    await waitFor(() => expect(screen.getByRole("option", { name: /New chat/ })).toBeTruthy());
    const runningMore = screen.getByRole("button", { name: /More actions for New chat/ });
    fireEvent.click(runningMore);
    fireEvent.click(
      within(screen.getByRole("menu", { name: "Actions for New chat" })).getByRole("menuitem", {
        name: "Delete and stop New chat",
      }),
    );
    // The answer is awaited before anything else happens. Let every pending step run, then nothing was stopped or deleted:
    // an assertion made right after the click would also pass if the answer were ignored and the stop came a tick later.
    await waitFor(() => expect(confirmed).toEqual(["New chat"]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual([]);
    expect(remoteCalls).toEqual([]);
    const idleMore = screen.getByRole("button", { name: /More actions for Idle chat/ });
    fireEvent.click(idleMore);
    expect(
      within(screen.getByRole("menu", { name: "Actions for Idle chat" })).queryByRole("menuitem", {
        name: "Delete and stop Idle chat",
      }),
    ).toBeNull();
  });

  test("a failed stop reports its message and leaves focus on the running row", async () => {
    renderSidebar({
      catalog: modelWithRunning(["first-reply"]),
      currentThreadId: ThreadIdSchema.parse("first-reply"),
      confirmDeleteRunning: () => true,
      stopRunning: async () => {
        throw new Error("stop failed");
      },
      deleteAvailable: true,
    });
    await waitFor(() => expect(screen.getByRole("option", { name: /New chat/ })).toBeTruthy());
    const row = screen.getByRole("option", { name: /New chat/ });
    fireEvent.click(screen.getByRole("button", { name: /More actions for New chat/ }));
    fireEvent.click(
      within(screen.getByRole("menu", { name: "Actions for New chat" })).getByRole("menuitem", {
        name: "Delete and stop New chat",
      }),
    );
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("stop failed"));
    await waitFor(() => expect(document.activeElement).toBe(row));
  });

  test("Escape on a no-file running chat's More actions button closes its menu and keeps the focus there", async () => {
    renderSidebar({
      catalog: modelWithRunning(["first-reply"]),
      currentThreadId: ThreadIdSchema.parse("first-reply"),
      confirmDeleteRunning: () => true,
      stopRunning: async () => undefined,
      deleteAvailable: true,
    });
    await waitFor(() => expect(screen.getByRole("option", { name: /New chat/ })).toBeTruthy());
    const more = screen.getByRole("button", { name: "More actions for New chat" });
    fireEvent.click(more);
    expect(screen.getByRole("menu", { name: "Actions for New chat" })).toBeTruthy();
    more.focus();
    fireEvent.keyDown(more, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "Actions for New chat" })).toBeNull();
    expect(document.activeElement).toBe(more);
  });
  test("a running chat's menu ignores programmatic scroll and closes on person scrolling", async () => {
    renderSidebar({
      catalog: modelWithRunning(["first-reply"]),
      currentThreadId: ThreadIdSchema.parse("first-reply"),
      confirmDeleteRunning: () => true,
      stopRunning: async () => undefined,
      deleteAvailable: true,
    });
    await waitFor(() => expect(screen.getByRole("option", { name: /New chat/ })).toBeTruthy());
    const menuName = "Actions for New chat";
    const more = screen.getByRole("button", { name: "More actions for New chat" });
    fireEvent.click(more);
    expect(screen.getByRole("menu", { name: menuName })).toBeTruthy();
    const list = screen.getByRole("listbox", { name: "Session list" });
    fireEvent.scroll(window);
    fireEvent.scroll(list);
    expect(screen.getByRole("menu", { name: menuName })).toBeTruthy();
    fireEvent.wheel(list);
    expect(screen.queryByRole("menu", { name: menuName })).toBeNull();
    fireEvent.click(more);
    fireEvent.keyDown(list, { key: "PageDown" });
    expect(screen.queryByRole("menu", { name: menuName })).toBeNull();
  });

  test("a running chat that the list holds shows once, as its listed row", async () => {
    renderSidebar({
      catalog: modelWithRunning(
        ["second"],
        [session("second", "2026-10-03T00:00:00.000Z", "Second chat")],
      ),
    });
    await waitFor(() => expect(screen.getByRole("option", { name: /Second chat/ })).toBeTruthy());
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.queryByRole("option", { name: /New chat/ })).toBeNull();
  });

  test("the arrow keys reach a running chat's row, and Enter opens it", async () => {
    const opened: string[] = [];
    renderSidebar({
      catalog: modelWithRunning(
        ["first-reply"],
        [session("old", "2026-10-01T00:00:00.000Z", "Old chat")],
      ),
      onOpenThread: async (threadId) => {
        opened.push(threadId);
      },
    });
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));
    const [running, old] = screen.getAllByRole("option");
    if (!running || !old) throw new Error("Expected a running row and a listed row.");
    running.focus();
    fireEvent.keyDown(running, { key: "ArrowDown" });
    expect(document.activeElement).toBe(old);
    fireEvent.keyDown(old, { key: "ArrowUp" });
    expect(document.activeElement).toBe(running);
    fireEvent.keyDown(running, { key: "Enter" });
    await waitFor(() => expect(opened).toEqual(["first-reply"]));
  });

  test("a click on a running row's body, beside its title, opens the chat", async () => {
    const { calls } = renderSidebar({ catalog: modelWithRunning(["first-reply"]) });
    await waitFor(() => expect(screen.getByRole("option", { name: /New chat/ })).toBeTruthy());
    const row = document.querySelector<HTMLElement>('[data-slot="r1-running-row"]');
    if (!row) throw new Error("Expected a running row.");
    fireEvent.click(row);
    await waitFor(() => expect(calls).toEqual(["initialize:first-reply"]));
  });

  test("the title button opens a running chat once, not twice, though the click also reaches the row", async () => {
    const { calls } = renderSidebar({ catalog: modelWithRunning(["first-reply"]) });
    await waitFor(() => expect(screen.getByRole("option", { name: /New chat/ })).toBeTruthy());
    fireEvent.click(screen.getByRole("option", { name: /New chat/ }));
    await waitFor(() => expect(calls).toEqual(["initialize:first-reply"]));
  });

  test("a running row's More actions button opens its menu, and the chat does not open", async () => {
    const { calls } = renderSidebar({
      catalog: modelWithRunning(["first-reply"]),
      confirmDeleteRunning: () => true,
      stopRunning: async () => undefined,
      deleteAvailable: true,
    });
    await waitFor(() => expect(screen.getByRole("option", { name: /New chat/ })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "More actions for New chat" }));
    expect(screen.getByRole("menu", { name: "Actions for New chat" })).toBeTruthy();
    expect(calls.filter((call) => call.startsWith("initialize:"))).toEqual([]);
  });

  test("a click on a saved row's body opens its chat, as it did before", async () => {
    const { calls } = renderSidebar({
      catalog: modelWithSessions([session("first", "2026-10-05T00:00:00.000Z", "First chat")]),
    });
    await waitFor(() => expect(screen.getByRole("option", { name: /First chat/ })).toBeTruthy());
    const row = document.querySelector<HTMLElement>('[data-slot="r1-session-row"]');
    if (!row) throw new Error("Expected a saved row.");
    fireEvent.click(row);
    await waitFor(() => expect(calls).toEqual(["initialize:first"]));
  });
});

describe("SessionCatalogSidebar focus across a refresh", () => {
  /** A catalog whose listed files and running chats are read from `state` on every refresh. */
  function modelFrom(state: { files: SessionFile[]; running: string[] }): SessionCatalogModel {
    return new SessionCatalogModel({
      scope,
      sessionFiles: {
        listSessions: async ({ folder: listed }) => ({
          sessions: state.files,
          nextCursor: null,
          running: state.running.map((id) => ({ id: ThreadIdSchema.parse(id), folder: listed })),
        }),
        readSessionRow: async ({ sessionFile }) => {
          const file = state.files.find((item) => item.sessionFile === sessionFile);
          if (!file) throw new Error(`No session file ${sessionFile}.`);
          return file;
        },
      },
    });
  }

  async function refresh(catalog: SessionCatalogModel): Promise<void> {
    await act(async () => {
      await catalog.list({ filter: { scope, query: "" }, limit: 50 });
    });
  }

  test("a focused running row keeps the focus when its listed row takes its place", async () => {
    const state: { files: SessionFile[]; running: string[] } = {
      files: [],
      running: ["first-reply"],
    };
    const catalog = modelFrom(state);
    renderSidebar({ catalog });
    await waitFor(() => expect(screen.getByRole("option", { name: /New chat/ })).toBeTruthy());
    screen.getByRole("option", { name: /New chat/ }).focus();
    // The turn ends: the chat's file is listed and the chat is no longer running.
    state.files = [session("first-reply", "2026-10-05T00:00:00.000Z", "First reply")];
    state.running = [];
    await refresh(catalog);
    await waitFor(() => expect(screen.getByRole("option", { name: /First reply/ })).toBeTruthy());
    expect(document.activeElement).toBe(screen.getByRole("option", { name: /First reply/ }));
  });

  test("a focused row keeps the focus when a chat updated above it pushes the row down", async () => {
    const state: { files: SessionFile[]; running: string[] } = {
      files: [
        session("new", "2026-10-05T00:00:00.000Z", "Newest chat"),
        session("old", "2026-10-01T00:00:00.000Z", "Old chat"),
      ],
      running: [],
    };
    const catalog = modelFrom(state);
    renderSidebar({ catalog });
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));
    screen.getByRole("option", { name: /Newest chat/ }).focus();
    // The old chat is updated and sorts first, so the focused row moves down the list.
    state.files = [
      session("old", "2026-10-09T00:00:00.000Z", "Old chat"),
      session("new", "2026-10-05T00:00:00.000Z", "Newest chat"),
    ];
    await refresh(catalog);
    await waitFor(() =>
      expect(screen.getAllByRole("option")[1]?.textContent).toContain("Newest chat"),
    );
    expect(document.activeElement).toBe(screen.getByRole("option", { name: /Newest chat/ }));
  });

  test("focus that falls to the body during a refresh is given back to the row that had it", async () => {
    const state: { files: SessionFile[]; running: string[] } = {
      files: [
        session("new", "2026-10-05T00:00:00.000Z", "Newest chat"),
        session("old", "2026-10-01T00:00:00.000Z", "Old chat"),
      ],
      running: [],
    };
    const catalog = modelFrom(state);
    renderSidebar({ catalog });
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));
    const oldRow = screen.getByRole("option", { name: /Old chat/ });
    oldRow.focus();
    oldRow.blur();
    expect(document.activeElement).toBe(document.body);
    // A refresh that re-renders the list, with the focus on the body.
    state.files = [
      session("new", "2026-10-05T00:00:00.000Z", "Newest chat renamed"),
      session("old", "2026-10-01T00:00:00.000Z", "Old chat"),
    ];
    await refresh(catalog);
    await waitFor(() => expect(screen.getByRole("option", { name: /renamed/ })).toBeTruthy());
    expect(document.activeElement).toBe(screen.getByRole("option", { name: /Old chat/ }));
  });

  test("focus the person moved to another control is not taken back by a refresh", async () => {
    const state: { files: SessionFile[]; running: string[] } = {
      files: [],
      running: ["first-reply"],
    };
    const catalog = modelFrom(state);
    renderSidebar({ catalog });
    await waitFor(() => expect(screen.getByRole("option", { name: /New chat/ })).toBeTruthy());
    screen.getByRole("option", { name: /New chat/ }).focus();
    const search = screen.getByRole("textbox", { name: "Search sessions" });
    search.focus();
    state.files = [session("first-reply", "2026-10-05T00:00:00.000Z", "First reply")];
    state.running = [];
    await refresh(catalog);
    await waitFor(() => expect(screen.getByRole("option", { name: /First reply/ })).toBeTruthy());
    expect(document.activeElement).toBe(search);
  });

  test("a press outside the focused row ends the list's claim on the focus", async () => {
    const state: { files: SessionFile[]; running: string[] } = {
      files: [],
      running: ["first-reply"],
    };
    const catalog = modelFrom(state);
    renderSidebar({ catalog });
    await waitFor(() => expect(screen.getByRole("option", { name: /New chat/ })).toBeTruthy());
    const row = screen.getByRole("option", { name: /New chat/ });
    row.focus();
    fireEvent.pointerDown(document.body);
    // A press outside moves focus out of the row, as a browser does; jsdom dispatches the event but does not move focus.
    row.blur();
    state.files = [session("first-reply", "2026-10-05T00:00:00.000Z", "First reply")];
    state.running = [];
    await refresh(catalog);
    await waitFor(() => expect(screen.getByRole("option", { name: /First reply/ })).toBeTruthy());
    expect(document.activeElement).toBe(document.body);
  });
});

describe("SessionCatalogSidebar entrance fade", () => {
  const fadesIn = (row: Element): boolean => row.className.includes("starting:opacity-0");
  const rowOf = (title: string): Element => {
    const row = [...document.querySelectorAll('[data-slot="r1-session-row"]')].find((candidate) =>
      candidate.textContent?.includes(title),
    );
    if (!row) throw new Error(`No row shows ${title}.`);
    return row;
  };

  test("the rows a load lists never fade in, a chat that joins afterwards fades in once, and a later update replays nothing", async () => {
    const files = [session("old", "2026-10-01T00:00:00.000Z", "Old chat")];
    const catalog = modelWithSessions(files);
    renderSidebar({ catalog });
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(1));
    expect(fadesIn(rowOf("Old chat"))).toBe(false);

    const fresh = session("fresh", "2026-10-04T00:00:00.000Z", "Fresh chat");
    files.push(fresh);
    await act(async () => {
      await catalog.reconcile({
        folder,
        sessionFile: fresh.sessionFile,
        id: fresh.id,
        kind: "created",
      });
    });
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));
    expect(fadesIn(rowOf("Fresh chat"))).toBe(true);
    // The fade is drawn and then ends: the row is an ordinary row before the later update, which must not replay it.
    await waitFor(() => expect(fadesIn(rowOf("Fresh chat"))).toBe(false));
    expect(fadesIn(rowOf("Old chat"))).toBe(false);

    const joined = session("joined", "2026-10-05T00:00:00.000Z", "Joined by a refresh");
    files.push(joined);
    await act(async () => {
      await catalog.list({ filter: { scope, query: "" }, limit: 50 });
    });
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(3));
    expect(fadesIn(rowOf("Joined by a refresh"))).toBe(true);
    expect(fadesIn(rowOf("Fresh chat"))).toBe(false);
    expect(fadesIn(rowOf("Old chat"))).toBe(false);
  });
});
