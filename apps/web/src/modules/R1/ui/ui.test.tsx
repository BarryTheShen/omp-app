import type { CapabilityMap, SessionFile } from "@omp-app/contracts";
import { AppFailure, SessionFilePath, ThreadId as ThreadIdSchema } from "@omp-app/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, test } from "vitest";
import { createRegistry } from "@/registry-core";
import { withRegistry } from "@/registry-core/test-support";
import { SessionCatalogModel } from "../catalog";
import type { SessionMetadata } from "../contract";
import { createNativeRemoteThreadListAdapter } from "../remote";
import { SessionCatalogSidebar } from ".";

afterEach(cleanup);

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
      readSession: async ({ sessionFile }) =>
        files.find((file) => file.sessionFile === sessionFile) as SessionFile,
    },
  });
}

/** Omp's rename command is available, so the Rename menu item is enabled. */
const RENAME_AVAILABLE: CapabilityMap = {
  "omp.cmd.set_session_name": { state: "available", via: "rpc" },
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

function renderSidebar(
  overrides: Partial<ComponentProps<typeof SessionCatalogSidebar>> & {
    readonly renameAvailable?: boolean;
  } = {},
) {
  const { renameAvailable = false, ...props } = overrides;
  const catalog = props.catalog ?? modelWithSessions();
  const calls: string[] = [];
  const sidebar = (
    <SessionCatalogSidebar
      {...props}
      catalog={catalog}
      remote={props.remote ?? fakeRemote(calls)}
    />
  );
  render(renameAvailable ? withRegistry(createRegistry([]), RENAME_AVAILABLE, sidebar) : sidebar);
  return { catalog, calls };
}

/** Opens a row's More actions and then its Rename item, the way a person does. */
function startRename(title: string): void {
  fireEvent.click(screen.getByRole("button", { name: `More actions for ${title}` }));
  const menu = screen.getByRole("menu", { name: `Actions for ${title}` });
  fireEvent.click(within(menu).getByRole("menuitem", { name: `Rename ${title}` }));
}

describe("SessionCatalogSidebar", () => {
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
        readSession: async ({ sessionFile }) => {
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
        readSession: async () => files[0] ?? session("missing", "2026-10-01T00:00:00.000Z"),
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

  test("Delete is shown disabled with the plain reason, even when the command gateway reports available", async () => {
    render(
      withRegistry(
        createRegistry([]),
        { "host.command-gateway": { state: "available", via: "rpc" } },
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
        readSession: async () => session("never", "2026-10-01T00:00:00.000Z"),
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
        readSession: async () => all[0] as SessionFile,
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
        readSession: async () => all[0] as SessionFile,
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
        readSession: async () => all[0] as SessionFile,
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
        readSession: async ({ sessionFile }) =>
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
        files[index] = { ...file, title: name };
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
        readSession: async () => {
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
