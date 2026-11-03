import type { AppClient } from "@omp-app/client";
import {
  type FolderPath,
  GitStatePort,
  type WatchedPath,
  type WorkspaceEntry,
  type WorkspaceFileChanged,
  WorkspaceFilesPort,
  WorkspaceListResult,
  type WorkspaceRelativePath,
} from "@omp-app/contracts";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "cn";
import { createStore, get, set } from "idb-keyval";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Ellipsis,
  File as FileIcon,
  FilePlus,
  Folder,
  FolderPlus,
  Link2,
  Upload,
} from "lucide-react";
import {
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import type { ChatController } from "../../chat/controller";
import { lastSeen } from "../../lastSeen";
import { usePhone } from "../../phone";
import { type DiskChange, FileViewer } from "./FileViewer";
import { baseName, childPath, keepBothName, parentOf } from "./names";
import { PageShare } from "./PageShare";
import { downloadBytes, failureCode, readFileBytes, uploadBytes } from "./transfer";
import { watchHub } from "./watchHub";

/** Expanded directories per folder, kept in the browser (a database of its own, as the viewer's unsaved edits). */
const expandedStore = createStore("omp-app-files-expanded", "expanded");
const PREVIEW_HEIGHT = "omp-app.files.previewHeight";
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const MOVE_TYPE = "application/x-omp-app-file";

/** A git badge for a changed file: modified, added, untracked or deleted. */
const BADGE: Readonly<Record<string, string>> = {
  modified: "M",
  added: "A",
  untracked: "U",
  deleted: "D",
};

interface Listing {
  readonly entries: readonly WorkspaceEntry[];
  readonly truncated: boolean;
}

/**
 * What the panel listed last, per folder: every directory for this page, and the folder's top level in this browser's
 * storage too. A folder shows them at once, after a reload too, while it lists them anew; on a slow, relayed
 * connection a listing can wait many seconds behind a chat's history (#2785).
 */
const shownListings = new Map<string, ReadonlyMap<string, Listing>>();
const listingsKey = (folder: string, showIgnored: boolean) =>
  `${showIgnored ? "all" : "shown"}:${folder}`;
const keptTop = (folder: string, showIgnored: boolean) =>
  lastSeen<Listing>(`files:${listingsKey(folder, showIgnored)}`, (stored) => {
    const parsed = WorkspaceListResult.safeParse(stored);
    return parsed.success ? parsed.data : undefined;
  });

function lastListings(folder: string, showIgnored: boolean): ReadonlyMap<string, Listing> {
  const shown = shownListings.get(listingsKey(folder, showIgnored));
  if (shown !== undefined) return shown;
  const top = keptTop(folder, showIgnored).get();
  return new Map(top === undefined ? [] : [["", top]]);
}

/** Keeps a directory's new listing, or (`undefined`) forgets one that is gone. */
function keepListing(
  folder: string,
  showIgnored: boolean,
  directory: string,
  listing: Listing | undefined,
): void {
  const key = listingsKey(folder, showIgnored);
  const next = new Map(shownListings.get(key) ?? []);
  if (listing === undefined) next.delete(directory);
  else next.set(directory, listing);
  shownListings.set(key, next);
  if (directory === "" && listing !== undefined) keptTop(folder, showIgnored).set(listing);
}

interface Row {
  readonly path: WorkspaceRelativePath;
  readonly entry: WorkspaceEntry;
  readonly depth: number;
}

interface UploadRow {
  readonly id: number;
  readonly name: string;
  readonly total: number;
  readonly sent: number;
  readonly abort: AbortController;
}

type Naming =
  | { readonly kind: "file" | "folder"; readonly directory: string }
  | { readonly kind: "rename"; readonly path: WorkspaceRelativePath };

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const isDirectory = (entry: WorkspaceEntry) =>
  entry.kind === "directory" || (entry.kind === "symlink" && entry.targetInside === true);

export interface FilesPanelProps {
  readonly client: AppClient;
  readonly folder: FolderPath;
  readonly chat: ChatController | null;
  /** Opens a file as a pane of the workspace, beside the chats. */
  readonly openFileTab?: (path: WorkspaceRelativePath) => void;
}

/**
 * The Files panel (#2782): the chat folder's files as a tree, a preview below it, uploads, downloads, and changes that
 * never overwrite silently. Everything goes over the app's socket, so it works from a laptop or a phone on another
 * computer than the server.
 */
export function FilesPanel({ client, folder, chat, openFileTab }: FilesPanelProps): ReactNode {
  const files = useMemo(() => client.port(WorkspaceFilesPort), [client]);
  const phone = usePhone();
  const [showIgnored, setShowIgnored] = useState(false);
  const [listings, setListings] = useState<ReadonlyMap<string, Listing>>(() =>
    lastListings(folder, false),
  );
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [selected, setSelected] = useState<WorkspaceRelativePath | null>(null);
  const [open, setOpen] = useState<WorkspaceRelativePath | null>(null);
  const [openDirty, setOpenDirty] = useState(false);
  const [askClose, setAskClose] = useState<WorkspaceRelativePath | null | false>(false);
  const [change, setChange] = useState<DiskChange | null>(null);
  const [status, setStatus] = useState<{
    readonly text: string;
    readonly undo?: () => void;
  } | null>(null);
  const [uploads, setUploads] = useState<readonly UploadRow[]>([]);
  const [naming, setNaming] = useState<Naming | null>(null);
  const [nameText, setNameText] = useState("");
  const [collision, setCollision] = useState<{
    readonly file: File;
    readonly directory: string;
    readonly resolve: (choice: "replace" | "keep" | "skip") => void;
  } | null>(null);
  const [git, setGit] = useState<ReadonlyMap<string, string>>(new Map());
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [previewHeight, setPreviewHeight] = useState(
    () => Number(localStorage.getItem(PREVIEW_HEIGHT)) || 320,
  );
  const uploadInput = useRef<HTMLInputElement | null>(null);
  const uploadInto = useRef("");
  const treeRef = useRef<HTMLDivElement | null>(null);
  const typed = useRef({ text: "", at: 0 });
  const nextUpload = useRef(0);
  const hub = useMemo(() => watchHub(client, folder), [client, folder]);

  const list = useCallback(
    async (directory: string) => {
      try {
        const result = await files.list({
          folder,
          ...(directory === "" ? {} : { path: directory as WorkspaceRelativePath }),
          showIgnored,
        });
        setListings((now) => new Map(now).set(directory, result));
        keepListing(folder, showIgnored, directory, result);
      } catch (error) {
        if (failureCode(error) === "not_found" && directory !== "") {
          keepListing(folder, showIgnored, directory, undefined);
          setListings((now) => {
            const next = new Map(now);
            next.delete(directory);
            return next;
          });
          setExpanded((now) => new Set([...now].filter((each) => each !== directory)));
          return;
        }
        setStatus({ text: `Could not list ${directory || "the folder"}: ${errorText(error)}` });
      }
    },
    [files, folder, showIgnored],
  );

  const readGit = useCallback(async () => {
    try {
      const state = await client.port(GitStatePort).read({ folder });
      const root = state.repositoryRoot;
      const marks = new Map<string, string>();
      for (const dirty of state.dirtyFiles) {
        const badge = BADGE[dirty.status];
        if (badge === undefined || root === null) continue;
        const absolute = `${root}/${dirty.path}`;
        if (absolute.startsWith(`${folder}/`)) marks.set(absolute.slice(folder.length + 1), badge);
      }
      setGit(marks);
    } catch {
      setGit(new Map());
    }
  }, [client, folder]);

  // A folder opens with the directories it had open last time.
  useEffect(() => {
    let active = true;
    setListings(lastListings(folder, showIgnored));
    setOpen(null);
    setSelected(null);
    void get<string[]>(folder, expandedStore)
      .catch(() => undefined)
      .then((kept) => {
        if (!active) return;
        const restored = new Set(kept ?? []);
        setExpanded(restored);
        void list("");
        for (const directory of restored) void list(directory);
      });
    void readGit();
    return () => {
      active = false;
    };
  }, [folder, list, readGit, showIgnored]);

  useEffect(() => {
    void set(folder, [...expanded], expandedStore).catch(() => undefined);
  }, [folder, expanded]);

  // The server watches the folder, the expanded directories and the open file.
  useEffect(() => {
    const paths: WatchedPath[] = ["", ...([...expanded] as WorkspaceRelativePath[])];
    if (open !== null) paths.push(open);
    hub.want(hub, paths);
  }, [hub, expanded, open]);
  useEffect(() => () => hub.want(hub, []), [hub]);

  // A change on disk refreshes the directory it is in, and the open file's viewer hears its own.
  const refreshes = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const latest = useRef({ expanded, open, list, readGit });
  latest.current = { expanded, open, list, readGit };
  useEffect(
    () =>
      hub.listen((event: WorkspaceFileChanged) => {
        const now = latest.current;
        const directory = parentOf(event.path);
        if (directory === "" || now.expanded.has(directory)) {
          const pending = refreshes.current.get(directory);
          if (pending !== undefined) clearTimeout(pending);
          refreshes.current.set(
            directory,
            setTimeout(() => {
              refreshes.current.delete(directory);
              void now.list(directory);
              void now.readGit();
            }, 150),
          );
        }
        if (event.path === now.open) setChange({ change: event.change, at: Date.now() });
      }),
    [hub],
  );

  const rows = useMemo(() => {
    const out: Row[] = [];
    const walk = (directory: string, depth: number) => {
      for (const entry of listings.get(directory)?.entries ?? []) {
        const path = childPath(directory, entry.name) as WorkspaceRelativePath;
        out.push({ path, entry, depth });
        if (isDirectory(entry) && expanded.has(path)) walk(path, depth + 1);
      }
    };
    walk("", 0);
    return out;
  }, [listings, expanded]);

  const touch = useMemo(() => matchMedia("(pointer: coarse)").matches, []);
  const rowHeight = phone || touch ? 44 : 28;
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => treeRef.current,
    estimateSize: () => rowHeight,
    overscan: 12,
  });

  const toggle = (path: WorkspaceRelativePath, to?: boolean) => {
    const opening = to ?? !expanded.has(path);
    setExpanded((now) => {
      const next = new Set(now);
      if (opening) next.add(path);
      else next.delete(path);
      return next;
    });
    if (opening) void list(path);
  };

  const openFile = (path: WorkspaceRelativePath) => {
    if (open !== null && open !== path && openDirty) {
      setAskClose(path);
      return;
    }
    setChange(null);
    setOpen(path);
  };

  const activate = (row: Row) => {
    setSelected(row.path);
    if (isDirectory(row.entry)) toggle(row.path);
    else openFile(row.path);
  };

  const trash = async (path: WorkspaceRelativePath) => {
    try {
      const { trashId } = await files.trash({ folder, path });
      if (open === path) setOpen(null);
      void list(parentOf(path));
      setStatus({
        text: `Deleted ${baseName(path)}`,
        undo: () => {
          void files
            .restore({ trashId })
            .then(() => {
              void list(parentOf(path));
              setStatus({ text: `Put ${baseName(path)} back` });
            })
            .catch((error: unknown) =>
              setStatus({ text: `Could not put it back: ${errorText(error)}` }),
            );
        },
      });
    } catch (error) {
      setStatus({ text: `Could not delete ${baseName(path)}: ${errorText(error)}` });
    }
  };

  const move = async (from: WorkspaceRelativePath, to: WorkspaceRelativePath) => {
    if (from === to) return;
    try {
      await files.move({ folder, from, to });
      void list(parentOf(from));
      void list(parentOf(to));
      if (open === from) setOpen(to);
      setSelected(to);
    } catch (error) {
      setStatus({
        text:
          failureCode(error) === "conflict"
            ? `${baseName(to)} is already there.`
            : `Could not move ${baseName(from)}: ${errorText(error)}`,
      });
    }
  };

  const download = async (path: WorkspaceRelativePath) => {
    try {
      const { mediaType } = await files.stat({ folder, path });
      const { bytes } = await readFileBytes(files, folder, path);
      downloadBytes(bytes, baseName(path), mediaType);
    } catch (error) {
      setStatus({ text: `Could not download ${baseName(path)}: ${errorText(error)}` });
    }
  };

  /** Asks Replace, Keep both or Skip for a name already in `directory`. */
  const askCollision = (file: File, directory: string) =>
    new Promise<"replace" | "keep" | "skip">((resolve) =>
      setCollision({ file, directory, resolve }),
    );

  const upload = async (picked: readonly File[], directory: string) => {
    for (const file of picked) {
      if (file.size > MAX_UPLOAD_BYTES) {
        setStatus({ text: `${file.name} is larger than 100 MB, so it was not uploaded.` });
        continue;
      }
      const taken = new Set((listings.get(directory)?.entries ?? []).map((entry) => entry.name));
      let name = file.name;
      let overwrite = false;
      if (taken.has(name)) {
        const choice = await askCollision(file, directory);
        if (choice === "skip") continue;
        if (choice === "keep") name = keepBothName(name, taken);
        else overwrite = true;
      }
      nextUpload.current += 1;
      const id = nextUpload.current;
      const abort = new AbortController();
      setUploads((now) => [...now, { id, name, total: file.size, sent: 0, abort }]);
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        await uploadBytes(
          files,
          folder,
          childPath(directory, name) as WorkspaceRelativePath,
          bytes,
          {
            ...(overwrite ? {} : { expectedHash: null }),
            signal: abort.signal,
            onProgress: (sent) =>
              setUploads((now) => now.map((row) => (row.id === id ? { ...row, sent } : row))),
          },
        );
      } catch (error) {
        if (!abort.signal.aborted) {
          setStatus({
            text:
              failureCode(error) === "conflict"
                ? `${name} appeared there meanwhile: not uploaded.`
                : `Could not upload ${name}: ${errorText(error)}`,
          });
        }
      } finally {
        setUploads((now) => now.filter((row) => row.id !== id));
        void list(directory);
      }
    }
  };

  const startNaming = (next: Naming) => {
    setNaming(next);
    setNameText(next.kind === "rename" ? baseName(next.path) : "");
  };

  const finishNaming = async () => {
    const name = nameText.trim();
    const current = naming;
    setNaming(null);
    if (current === null || name === "" || name.includes("/")) return;
    try {
      if (current.kind === "rename") {
        await move(current.path, childPath(parentOf(current.path), name) as WorkspaceRelativePath);
        return;
      }
      const path = childPath(current.directory, name) as WorkspaceRelativePath;
      if (current.kind === "folder") await files.createDirectory({ folder, path });
      else await uploadBytes(files, folder, path, new Uint8Array(), { expectedHash: null });
      if (current.directory !== "") toggle(current.directory as WorkspaceRelativePath, true);
      void list(current.directory);
      setSelected(path);
      if (current.kind === "file") openFile(path);
    } catch (error) {
      setStatus({
        text:
          failureCode(error) === "conflict"
            ? `${name} is already there.`
            : `Could not make ${name}: ${errorText(error)}`,
      });
    }
  };

  const onTreeKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = rows.findIndex((row) => row.path === selected);
    const row = rows[index];
    const go = (to: number) => {
      const target = rows[Math.max(0, Math.min(rows.length - 1, to))];
      if (target === undefined) return;
      setSelected(target.path);
      virtualizer.scrollToIndex(Math.max(0, Math.min(rows.length - 1, to)));
    };
    switch (event.key) {
      case "ArrowDown":
        go(index + 1);
        break;
      case "ArrowUp":
        go(index < 0 ? 0 : index - 1);
        break;
      case "ArrowRight":
        if (row !== undefined && isDirectory(row.entry)) toggle(row.path, true);
        break;
      case "ArrowLeft":
        if (row !== undefined && isDirectory(row.entry) && expanded.has(row.path))
          toggle(row.path, false);
        else if (row !== undefined) go(rows.findIndex((each) => each.path === parentOf(row.path)));
        break;
      case "Enter":
        if (row !== undefined) activate(row);
        break;
      case "F2":
        if (row !== undefined) startNaming({ kind: "rename", path: row.path });
        break;
      case "Delete":
        if (row !== undefined) void trash(row.path);
        break;
      default: {
        if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return;
        const now = Date.now();
        typed.current = {
          text:
            now - typed.current.at < 700
              ? typed.current.text + event.key.toLowerCase()
              : event.key.toLowerCase(),
          at: now,
        };
        const after = [...rows.slice(index + 1), ...rows.slice(0, index + 1)];
        const found = after.find((each) =>
          each.entry.name.toLowerCase().startsWith(typed.current.text),
        );
        if (found !== undefined) go(rows.indexOf(found));
        break;
      }
    }
    event.preventDefault();
  };

  const dropInto = (directory: string) => ({
    onDragOver: (event: DragEvent) => {
      const types = event.dataTransfer.types;
      if (!types.includes(MOVE_TYPE) && !types.includes("Files")) return;
      event.preventDefault();
      event.stopPropagation();
      setDropTarget(directory);
    },
    onDragLeave: () => setDropTarget((now) => (now === directory ? null : now)),
    onDrop: (event: DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      setDropTarget(null);
      const moved = event.dataTransfer.getData(MOVE_TYPE);
      if (moved !== "") {
        void move(
          moved as WorkspaceRelativePath,
          childPath(directory, baseName(moved)) as WorkspaceRelativePath,
        );
        return;
      }
      if (event.dataTransfer.files.length > 0)
        void upload([...event.dataTransfer.files], directory);
    },
  });

  const directoryOf = (row: Row) => (isDirectory(row.entry) ? row.path : parentOf(row.path));

  const menu = (row: Row) => (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`More for ${row.entry.name}`}
        className="grid size-6 shrink-0 place-items-center rounded-sm text-t3 opacity-0 group-hover/file:opacity-100 hover:bg-l2 hover:text-t1 focus-visible:opacity-100 data-popup-open:opacity-100 max-sm:size-11 tablet:size-11 [@media(hover:none)]:opacity-100"
        onClick={(event) => event.stopPropagation()}
      >
        <Ellipsis className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem
          onClick={() => startNaming({ kind: "file", directory: directoryOf(row) })}
        >
          New file
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => startNaming({ kind: "folder", directory: directoryOf(row) })}
        >
          New folder
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => startNaming({ kind: "rename", path: row.path })}>
          Rename
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => void trash(row.path)}>Delete</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => void navigator.clipboard?.writeText(row.path)}>
          Copy path
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={chat === null}
          onClick={() => chat?.insertText(`@${row.path} `)}
        >
          Mention in chat
        </DropdownMenuItem>
        {!isDirectory(row.entry) && (
          <DropdownMenuItem onClick={() => void download(row.path)}>Download</DropdownMenuItem>
        )}
        <DropdownMenuItem
          onClick={() => {
            uploadInto.current = directoryOf(row);
            uploadInput.current?.click();
          }}
        >
          Upload here
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const viewer =
    open === null ? null : (
      <FileViewer
        key={open}
        files={files}
        folder={folder}
        path={open}
        change={change}
        onClose={() => (openDirty ? setAskClose(null) : setOpen(null))}
        {...(openFileTab === undefined ? {} : { onOpenAsTab: () => openFileTab(open) })}
        onDirtyChange={setOpenDirty}
        onCopySaved={(copy) => void list(parentOf(copy))}
        pageShare={<PageShare client={client} folder={folder} path={open} />}
      />
    );

  // On a phone a file fills the screen, with a way back to the list.
  if (phone && viewer !== null) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <Button
          variant="ghost"
          className="h-11 shrink-0 justify-start gap-1 px-2 text-t2"
          onClick={() => (openDirty ? setAskClose(null) : setOpen(null))}
        >
          <ChevronLeft /> Files
        </Button>
        <div className="min-h-0 flex-1">{viewer}</div>
        {closeDialog()}
      </div>
    );
  }

  function closeDialog(): ReactNode {
    return (
      <Dialog open={askClose !== false} onOpenChange={(value) => !value && setAskClose(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Close without saving?</DialogTitle>
            <DialogDescription>
              Your edits to {open === null ? "this file" : baseName(open)} are not saved.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAskClose(false)}>
              Keep editing
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const next = askClose === false ? null : askClose;
                setAskClose(false);
                setOpenDirty(false);
                setChange(null);
                setOpen(next);
              }}
            >
              Close it
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  const root = listings.get("");
  return (
    <div data-tour="files-panel" className="flex h-full min-h-0 flex-col" {...dropInto("")}>
      <div className="flex shrink-0 items-center gap-1 border-b border-l2 px-2 py-1">
        <div className="flex flex-1 items-center gap-2 text-xs text-t3">
          <Checkbox
            id="files-show-ignored"
            checked={showIgnored}
            onCheckedChange={(value) => setShowIgnored(value === true)}
          />
          <label htmlFor="files-show-ignored">Show ignored</label>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="New file"
          className="tablet:size-11"
          onClick={() =>
            startNaming({ kind: "file", directory: selected === null ? "" : parentOf(selected) })
          }
        >
          <FilePlus />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="New folder"
          className="tablet:size-11"
          onClick={() =>
            startNaming({ kind: "folder", directory: selected === null ? "" : parentOf(selected) })
          }
        >
          <FolderPlus />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Upload"
          className="tablet:size-11"
          onClick={() => {
            uploadInto.current = "";
            uploadInput.current?.click();
          }}
        >
          <Upload />
        </Button>
        <input
          ref={uploadInput}
          type="file"
          multiple
          hidden
          aria-label="Files to upload"
          onChange={(event) => {
            const picked = [...(event.currentTarget.files ?? [])];
            event.currentTarget.value = "";
            void upload(picked, uploadInto.current);
          }}
        />
      </div>
      <div
        ref={treeRef}
        role="tree"
        aria-label="Files"
        tabIndex={0}
        className={cn(
          // Three rows stay in view under a tall preview.
          "relative min-h-21 flex-1 overflow-y-auto outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
          dropTarget === "" && "bg-accent/10",
        )}
        onKeyDown={onTreeKey}
      >
        {root === undefined && <p className="p-3 text-sm text-t3">Listing the folder…</p>}
        {root !== undefined && rows.length === 0 && (
          <p className="p-3 text-sm text-t3">This folder is empty.</p>
        )}
        <div style={{ height: virtualizer.getTotalSize() }} className="relative">
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index];
            if (row === undefined) return null;
            const directory = isDirectory(row.entry);
            const shownOpen = directory && expanded.has(row.path);
            return (
              // biome-ignore lint/a11y/useKeyWithClickEvents: the tree itself takes the keys (arrows, Enter, F2, Delete)
              <div
                key={row.path}
                role="treeitem"
                aria-level={row.depth + 1}
                aria-selected={row.path === selected}
                aria-expanded={directory ? shownOpen : undefined}
                aria-label={row.entry.name}
                tabIndex={-1}
                draggable
                onDragStart={(event) => event.dataTransfer.setData(MOVE_TYPE, row.path)}
                {...(directory ? dropInto(row.path) : {})}
                className={cn(
                  "group/file absolute inset-x-0 flex cursor-default items-center gap-1 pr-1 text-sm",
                  row.path === selected ? "bg-l2 text-t1" : "text-t2 hover:bg-l1 hover:text-t1",
                  row.path === open && "font-medium text-t1",
                  dropTarget === row.path && "bg-accent/15",
                  row.entry.ignored && "opacity-60",
                )}
                style={{ top: item.start, height: rowHeight, paddingLeft: 8 + row.depth * 14 }}
                onClick={() => activate(row)}
              >
                {directory ? (
                  shownOpen ? (
                    <ChevronDown className="size-3.5 shrink-0 text-t3" />
                  ) : (
                    <ChevronRight className="size-3.5 shrink-0 text-t3" />
                  )
                ) : (
                  <span className="w-3.5 shrink-0" />
                )}
                {row.entry.kind === "symlink" ? (
                  <Link2 className="size-3.5 shrink-0 text-t3" />
                ) : directory ? (
                  <Folder className="size-3.5 shrink-0 text-t3" />
                ) : (
                  <FileIcon className="size-3.5 shrink-0 text-t3" />
                )}
                <span className="min-w-0 flex-1 truncate">{row.entry.name}</span>
                {git.get(row.path) !== undefined && (
                  <span
                    className="shrink-0 font-mono text-[11px] text-warn-ink"
                    title="Changed in git"
                  >
                    {git.get(row.path)}
                  </span>
                )}
                {menu(row)}
              </div>
            );
          })}
        </div>
        {root?.truncated === true && (
          <p className="px-3 py-1 text-xs text-t3">
            Only the first 5,000 entries of this folder are listed.
          </p>
        )}
      </div>
      {uploads.length > 0 && (
        <ul aria-label="Uploads" className="shrink-0 border-t border-l2 px-2 py-1 text-xs">
          {uploads.map((row) => (
            <li key={row.id} className="flex items-center gap-2 py-0.5">
              <span className="min-w-0 flex-1 truncate text-t2">{row.name}</span>
              <div
                role="progressbar"
                aria-label={`Uploading ${row.name}`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round((100 * row.sent) / Math.max(1, row.total))}
                className="h-1.5 w-20 shrink-0 overflow-hidden rounded-full bg-l2"
              >
                <div
                  className="h-full rounded-full bg-accent-ink"
                  style={{ width: `${(100 * row.sent) / Math.max(1, row.total)}%` }}
                />
              </div>
              <Button variant="ghost" size="sm" onClick={() => row.abort.abort()}>
                Cancel
              </Button>
            </li>
          ))}
        </ul>
      )}
      {status !== null && (
        <div
          role="status"
          className="flex shrink-0 items-center gap-2 border-t border-l2 px-2 py-1 text-xs text-t2"
        >
          <span className="min-w-0 flex-1">{status.text}</span>
          {status.undo !== undefined && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                status.undo?.();
                setStatus(null);
              }}
            >
              Undo
            </Button>
          )}
          <Button variant="ghost" size="sm" aria-label="Dismiss" onClick={() => setStatus(null)}>
            OK
          </Button>
        </div>
      )}
      {viewer !== null && (
        <>
          {/* biome-ignore lint/a11y/useSemanticElements: a separator dragged to resize the preview; an hr takes no drag */}
          <div
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize the preview"
            className="h-1.5 shrink-0 cursor-row-resize border-t border-l2 hover:bg-l2"
            onPointerDown={(event) => {
              const startY = event.clientY;
              const start = previewHeight;
              const target = event.currentTarget;
              target.setPointerCapture(event.pointerId);
              const moveTo = (moveEvent: PointerEvent) =>
                setPreviewHeight(
                  Math.max(
                    120,
                    Math.min(window.innerHeight - 160, start + startY - moveEvent.clientY),
                  ),
                );
              const stop = () => {
                target.removeEventListener("pointermove", moveTo);
                target.removeEventListener("pointerup", stop);
                setPreviewHeight((height) => {
                  localStorage.setItem(PREVIEW_HEIGHT, String(height));
                  return height;
                });
              };
              target.addEventListener("pointermove", moveTo);
              target.addEventListener("pointerup", stop);
            }}
          />
          {/*
            The height dragged to, kept for the next time, but no more than the panel has room for: a height kept from a
            taller window, or another zoom, pushed the panel past its bottom, and the side panel scrolled too, a second bar
            beside the preview's own (#2793).
          */}
          <div className="min-h-30" style={{ flex: `0 1 ${previewHeight}px` }}>
            {viewer}
          </div>
        </>
      )}
      <Dialog open={naming !== null} onOpenChange={(value) => !value && setNaming(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {naming?.kind === "rename"
                ? "Rename"
                : naming?.kind === "folder"
                  ? "New folder"
                  : "New file"}
            </DialogTitle>
            <DialogDescription>
              {naming?.kind === "rename"
                ? `In ${parentOf(naming.path) || "the folder"}`
                : `In ${naming?.directory || "the folder"}`}
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void finishNaming();
            }}
          >
            <Input
              aria-label="Name"
              autoFocus
              value={nameText}
              onChange={(event) => setNameText(event.target.value)}
            />
            <DialogFooter className="mt-3">
              <Button type="button" variant="ghost" onClick={() => setNaming(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={nameText.trim() === "" || nameText.includes("/")}>
                {naming?.kind === "rename" ? "Rename" : "Make it"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        open={collision !== null}
        onOpenChange={(value) => {
          if (value || collision === null) return;
          collision.resolve("skip");
          setCollision(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{collision?.file.name} is already there</DialogTitle>
            <DialogDescription>In {collision?.directory || "the folder"}.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            {(["skip", "keep", "replace"] as const).map((choice) => (
              <Button
                key={choice}
                variant={choice === "replace" ? "destructive" : "ghost"}
                onClick={() => {
                  collision?.resolve(choice);
                  setCollision(null);
                }}
              >
                {choice === "skip" ? "Skip" : choice === "keep" ? "Keep both" : "Replace"}
              </Button>
            ))}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {closeDialog()}
    </div>
  );
}
