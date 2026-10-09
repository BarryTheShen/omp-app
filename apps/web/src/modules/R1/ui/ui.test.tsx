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
      confirmDelete={() => true}
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
});
