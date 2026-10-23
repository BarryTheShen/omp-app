import type { RemoteThreadListAdapter } from "@assistant-ui/react";
import type {
  CapabilityMap,
  GitState,
  OpenThreadResult,
  SessionFile,
  SessionFilePath,
  SessionListResult,
  SessionPinListResult,
  ThreadId,
  Timestamp,
  WorkspaceState,
} from "@omp-app/contracts";
import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Panel } from "@/components/blocks";
import { LayoutArea, type SurfaceMap } from "@/layout";
import { createRegistry, RegistryProvider } from "@/registry-core";
import { AppShell } from "@/shell";
import { ShortcutRegistryProvider } from "@/shortcuts";
import { SessionCatalogModel } from "../catalog";
import { R1_DESCRIPTORS } from "../descriptors";
import type { NativeRemoteThreadListAdapter } from "../remote";
import { SessionCatalogSidebar } from "./ui";

const ROOT = "/workspace/project" as SessionFile["cwd"];
const WORKTREE = `${ROOT}/worktree` as SessionFile["cwd"];
const NOW = "2026-10-05T12:00:00.000Z" as Timestamp;
const PINNED_ID = "session-pinned" as ThreadId;
const LONG_TITLE_ID = "session-long-title" as ThreadId;

const capabilities = {
  "omp.cmd.set_session_name": { state: "available", via: "rpc" },
} satisfies CapabilityMap;

const git: GitState = {
  repositoryRoot: ROOT,
  branch: "main",
  head: "0123456789abcdef0123456789abcdef01234567",
  detached: false,
  dirtyFiles: [],
  ahead: 0,
  behind: 0,
  worktrees: [
    {
      path: WORKTREE,
      head: "abcdef0123456789abcdef0123456789abcdef01",
      branch: "feature/sidebar",
      detached: false,
      bare: false,
      locked: false,
    },
  ],
  observedAt: NOW,
};

function session(
  id: ThreadId,
  cwd: SessionFile["cwd"],
  title: string,
  updatedAt: string,
  index: number,
): SessionFile {
  return {
    id,
    sessionFile: `${cwd}/.omp/${id}.jsonl` as SessionFilePath,
    version: 3,
    title,
    displayTitle: title,
    firstPrompt: null,
    cwd,
    createdAt: `2026-10-0${Math.min(index + 1, 9)}T09:00:00.000Z` as Timestamp,
    updatedAt: updatedAt as Timestamp,
    parentSession: null,
    messageCount: index + 1,
    assistantTurns: index,
    sizeBytes: 1_000 + index,
    status: "complete",
    liveness: { lease: "free", serverProcess: false },
    subagents: [],
    parseWarnings: [],
  };
}

/** `?sessions=60` or `?panelRows=80` adds that many rows, to see how a long list behaves. */
function queryCount(name: string): number {
  const requested = Number.parseInt(
    new URLSearchParams(window.location.search).get(name) ?? "",
    10,
  );
  return Number.isFinite(requested) ? Math.min(Math.max(requested, 0), 500) : 0;
}

const fixtureSessions: readonly SessionFile[] = [
  session(PINNED_ID, ROOT, "Pinned project kickoff", "2026-10-05T11:59:00.000Z", 0),
  session(
    LONG_TITLE_ID,
    ROOT,
    "A very long session title that stays readable without pushing the sidebar beyond its bounds",
    "2026-10-05T11:58:00.000Z",
    1,
  ),
  ...Array.from({ length: 5 }, (_, index) =>
    session(
      `session-root-${index + 1}` as ThreadId,
      ROOT,
      `Recent project chat ${index + 1}`,
      `2026-10-0${5 - Math.floor(index / 2)}T11:${String(57 - index).padStart(2, "0")}:00.000Z`,
      index + 2,
    ),
  ),
  ...Array.from({ length: 5 }, (_, index) =>
    session(
      `session-worktree-${index + 1}` as ThreadId,
      WORKTREE,
      `Recent worktree chat ${index + 1}`,
      `2026-10-0${4 - Math.floor(index / 2)}T10:${String(55 - index).padStart(2, "0")}:00.000Z`,
      index + 6,
    ),
  ),
  ...Array.from({ length: queryCount("sessions") }, (_, index) =>
    session(
      `session-older-${index + 1}` as ThreadId,
      ROOT,
      `Older project chat ${index + 1}`,
      new Date(Date.UTC(2026, 8, 30, 12, 0) - index * 3_600_000).toISOString(),
      index + 12,
    ),
  ),
];

const workspace: WorkspaceState = {
  folder: ROOT,
  additionalDirectories: [],
  git,
  observedAt: NOW,
};

function createCatalog(): SessionCatalogModel {
  const files = new Map(fixtureSessions.map((file) => [file.sessionFile, file]));
  return new SessionCatalogModel({
    scope: { kind: "project", folder: ROOT, repositoryRoot: ROOT },
    gitState: { read: async () => workspace },
    pins: {
      list: async (): Promise<SessionPinListResult> => ({
        pins: [{ sessionId: PINNED_ID, pinned: true }],
        revision: "fixture-r1",
        readAt: NOW,
      }),
    },
    sessionFiles: {
      listSessions: async ({
        folder,
      }: {
        folder: SessionFile["cwd"];
      }): Promise<SessionListResult> => ({
        sessions: fixtureSessions.filter((file) => file.cwd === folder),
        nextCursor: null,
      }),
      readSessionRow: async ({
        sessionFile,
      }: {
        sessionFile: SessionFilePath;
      }): Promise<SessionFile> => {
        const file = files.get(sessionFile);
        if (!file) throw new Error(`Unknown fixture session: ${sessionFile}`);
        return file;
      },
    },
  });
}

function SessionSidebarPlayground() {
  const catalog = useMemo(createCatalog, []);
  const [lastAction, setLastAction] = useState("Ready");
  const remote = useMemo<
    Pick<RemoteThreadListAdapter, "initialize" | "rename" | "archive" | "unarchive" | "delete"> &
      Pick<NativeRemoteThreadListAdapter, "startNew" | "adopt">
  >(
    () => ({
      initialize: async (threadId: string) => {
        const remoteId = (threadId === "new" ? "session-new" : threadId) as ThreadId;
        setLastAction(`Opened ${remoteId}`);
        return { remoteId };
      },
      startNew: async () => {
        setLastAction("Started a new chat");
        return {
          threadId: "session-new" as ThreadId,
          sessionFile: "" as OpenThreadResult["sessionFile"],
          capabilities: {},
        };
      },
      adopt: () => true,
      rename: async (remoteId: string, newTitle: string) => {
        setLastAction(`Renamed ${remoteId} to ${newTitle}`);
      },
      archive: async () => {
        setLastAction("Archived session");
      },
      unarchive: async () => {
        setLastAction("Unarchived session");
      },
      delete: async () => {
        setLastAction("Deleted session");
      },
    }),
    [],
  );

  const sidebar = (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="r1-session-sidebar">
      <SessionCatalogSidebar
        catalog={catalog}
        currentThreadId={PINNED_ID}
        remote={remote}
        onNewChat={(started) => setLastAction(`Started ${started.threadId}`)}
        onOpenThread={(threadId) => setLastAction(`Selected ${threadId}`)}
      />
    </div>
  );
  // The same area and surface the app mounts (`apps/web/src/app/root.tsx`), so this page shows the
  // real height and scrolling chain from the shell down to the list.
  const sidebarSurfaces: SurfaceMap = {
    sessions: { title: "Sessions", grow: true, render: () => sidebar },
  };
  const notes = Array.from({ length: queryCount("panelRows") }, (_, index) => `Note ${index + 1}`);
  const panelSurfaces: SurfaceMap = {
    todo: {
      title: "Notes",
      grow: true,
      render: () => (
        <Panel title="Notes">
          {notes.map((note) => (
            <p className="py-2 text-sm" key={note}>
              {note}
            </p>
          ))}
        </Panel>
      ),
    },
  };

  return (
    <RegistryProvider capabilities={capabilities} registry={createRegistry([])} renderers={{}}>
      <ShortcutRegistryProvider descriptors={R1_DESCRIPTORS}>
        <AppShell
          leftSidebar={<LayoutArea area="sidebar" surfaces={sidebarSurfaces} />}
          rightSidebar={
            notes.length > 0 ? (
              <LayoutArea area="panels" surfaces={panelSurfaces} />
            ) : (
              <div className="p-4 text-sm">Panels are empty in this fixture.</div>
            )
          }
          threadHeader={<h1 className="truncate text-sm font-semibold">R1 session catalog</h1>}
          transcript={
            <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
              Choose a session from the catalog.
            </div>
          }
          composer={<div className="p-3 text-sm text-muted-foreground">Composer fixture</div>}
          statusBar={
            <div className="px-3 py-2 text-xs text-muted-foreground" data-testid="last-action">
              {lastAction}
            </div>
          }
        />
      </ShortcutRegistryProvider>
    </RegistryProvider>
  );
}

const root = document.getElementById("r1-session-sidebar-playground-root");
if (!root) throw new Error("R1 session sidebar playground root is missing.");

createRoot(root).render(<SessionSidebarPlayground />);
