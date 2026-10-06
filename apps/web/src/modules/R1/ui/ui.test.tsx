import type { SessionFile } from "@omp-app/contracts";
import { SessionFilePath, ThreadId as ThreadIdSchema } from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, test } from "vitest";
import { SessionCatalogModel } from "../catalog";
import type { SessionMetadata } from "../contract";
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

function renderSidebar(overrides: Partial<ComponentProps<typeof SessionCatalogSidebar>> = {}) {
  const catalog = overrides.catalog ?? modelWithSessions();
  const calls: string[] = [];
  const remote = overrides.remote ?? {
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
  render(
    <SessionCatalogSidebar
      catalog={catalog}
      remote={remote}
      confirmDelete={() => true}
      {...overrides}
    />,
  );
  return { catalog, calls };
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
});
