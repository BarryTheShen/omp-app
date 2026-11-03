import type {
  FileHash,
  FolderPath,
  WorkspaceRelativePath,
  WorkspaceStatResult,
} from "@omp-app/contracts";
import { createStore, del, get, set } from "idb-keyval";
import { Download, ExternalLink, PanelTop, X } from "lucide-react";
import {
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Markdown } from "../../vendor/collab-web/components/transcript/Markdown";
import { previewDocument } from "./htmlPreview";
import { baseName } from "./names";
import { type ConflictChoice, resolveConflict, saveText } from "./save";
import { downloadBytes, type FilesClient, readFileBytes } from "./transfer";
import { chooseViewer, decodeText, TEXT_EDIT_BYTES, type ViewerChoice } from "./viewer";

/** CodeMirror and its merge view load only when a text viewer opens (#2782: the main script stays small). */
const CodeEditor = lazy(() => import("./CodeEditor"));
const MergeCompare = lazy(() => import("./MergeCompare"));
/** PDF.js loads only when a PDF is shown (#2785). */
const PdfView = lazy(() => import("./PdfView"));

/**
 * Unsaved edits, per folder and path, kept every 2 seconds: they come back after a reload or a crash. A database of its
 * own: idb-keyval makes a store only when it makes the database, so two stores can't share one.
 */
const unsavedStore = createStore("omp-app-files-unsaved", "unsaved");
const UNSAVED_KEEP_MS = 2000;
/** Files above this are not downloaded in the page: they would fill its memory. */
const DOWNLOAD_BYTES = 200 * 1024 * 1024;

interface Unsaved {
  readonly text: string;
  readonly hash: FileHash | null;
}

/** A change on disk to the open file, told by the Files panel; `at` tells the same change twice apart. */
export interface DiskChange {
  readonly change: "created" | "modified" | "deleted";
  readonly at: number;
}

type Shown =
  | { readonly state: "loading" }
  | { readonly state: "failed"; readonly message: string }
  | {
      readonly state: "ready";
      readonly stat: WorkspaceStatResult;
      readonly choice: ViewerChoice;
      readonly bytes: Uint8Array;
      /** Every byte of the file is read (not only its first part). */
      readonly complete: boolean;
    };

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export interface FileViewerProps {
  readonly files: FilesClient;
  readonly folder: FolderPath;
  readonly path: WorkspaceRelativePath;
  readonly change: DiskChange | null;
  readonly onClose: () => void;
  readonly onOpenAsTab?: () => void;
  /** Hears whether the open file has edits not saved. */
  readonly onDirtyChange?: (dirty: boolean) => void;
  /** A copy was saved beside the file (Save as copy). */
  readonly onCopySaved?: (copy: WorkspaceRelativePath) => void;
}

/**
 * The Files panel's viewer (#2782): a file shown by its type, text edited and saved against the hash it was opened
 * with. A conflict stops and asks; a change on disk reloads an unedited file in place and puts a banner over an
 * edited one; unsaved edits are kept and come back.
 */
export function FileViewer({
  files,
  folder,
  path,
  change,
  onClose,
  onOpenAsTab,
  onDirtyChange,
  onCopySaved,
}: FileViewerProps): ReactNode {
  const name = baseName(path);
  const unsavedKey = `${folder}\0${path}`;
  const [shown, setShown] = useState<Shown>({ state: "loading" });
  /** The text in the editor, and the text and hash on disk it was opened from or last saved as. */
  const [mine, setMine] = useState("");
  const [baseText, setBaseText] = useState("");
  const [baseHash, setBaseHash] = useState<FileHash | null>(null);
  const [editing, setEditing] = useState(false);
  const [rendered, setRendered] = useState(true);
  const [wrap, setWrap] = useState(true);
  const [fit, setFit] = useState(true);
  const [banner, setBanner] = useState<"changed" | "deleted" | "restored" | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [conflict, setConflict] = useState<
    | null
    | { readonly stage: "ask" }
    | { readonly stage: "compare"; readonly diskText: string; readonly diskHash: FileHash | null }
  >(null);
  const [merged, setMerged] = useState("");
  const [confirmRecreate, setConfirmRecreate] = useState(false);
  const [busy, setBusy] = useState(false);
  /** Why PDF.js could not draw this PDF; the viewer offers Open and Download instead. */
  const [pdfFailure, setPdfFailure] = useState<string | null>(null);
  const dirty = shown.state === "ready" && mine !== baseText;

  const load = useCallback(
    async (all = false) => {
      try {
        const stat = await files.stat({ folder, path });
        let choice = chooseViewer(stat.mediaType, stat.size);
        if (choice.kind === "other") {
          setShown({ state: "ready", stat, choice, bytes: new Uint8Array(), complete: false });
          return;
        }
        const read = await readFileBytes(
          files,
          folder,
          path,
          choice.partial && !all ? TEXT_EDIT_BYTES : undefined,
        );
        const complete = read.bytes.length >= read.size;
        if (choice.kind === "text" || choice.kind === "markdown" || choice.kind === "html") {
          const text = decodeText(read.bytes);
          if (text === null) {
            choice = { kind: "other", editable: false, partial: false, sniff: false };
          } else {
            const kept = await get<Unsaved>(unsavedKey, unsavedStore).catch(() => undefined);
            const restore = kept !== undefined && kept.text !== text && choice.editable && complete;
            setBaseText(text);
            setBaseHash(restore ? kept.hash : stat.hash);
            setMine(restore ? kept.text : text);
            setBanner(restore ? "restored" : null);
            if (restore) setEditing(true);
          }
        }
        setShown({ state: "ready", stat, choice, bytes: read.bytes, complete });
      } catch (error) {
        setShown({ state: "failed", message: errorText(error) });
      }
    },
    [files, folder, path, unsavedKey],
  );

  useEffect(() => {
    setShown({ state: "loading" });
    setEditing(false);
    setBanner(null);
    setStatus(null);
    void load();
  }, [load]);

  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);

  // Unsaved edits are kept every 2 seconds, and forgotten once saved or dropped.
  const keep = useRef({ dirty, mine, baseHash });
  keep.current = { dirty, mine, baseHash };
  useEffect(() => {
    const timer = setInterval(() => {
      const now = keep.current;
      if (now.dirty)
        void set(
          unsavedKey,
          { text: now.mine, hash: now.baseHash } satisfies Unsaved,
          unsavedStore,
        );
      else void del(unsavedKey, unsavedStore);
    }, UNSAVED_KEEP_MS);
    return () => clearInterval(timer);
  }, [unsavedKey]);

  // A change on disk: an unedited file reloads in place; an edited one gets a banner. A disk holding what this viewer
  // last read or saved is no change: a save's own write is told too, and must not read as someone else's.
  // biome-ignore lint/correctness/useExhaustiveDependencies: heard once per change told
  useEffect(() => {
    if (change === null) return;
    if (change.change === "deleted") {
      setBanner("deleted");
      return;
    }
    let live = true;
    void files
      .stat({ folder, path })
      .then((stat) => {
        if (!live) return;
        if (stat.hash !== null && stat.hash === keep.current.baseHash) {
          setBanner((now) => (now === "deleted" ? null : now));
          return;
        }
        if (keep.current.dirty) {
          setBanner("changed");
          return;
        }
        void load().then(() => setStatus("Updated"));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [change]);

  const url = useMemo(() => {
    if (shown.state !== "ready" || shown.bytes.length === 0) return null;
    if (!["image", "pdf", "audio", "video"].includes(shown.choice.kind)) return null;
    return URL.createObjectURL(new Blob([shown.bytes as BlobPart], { type: shown.stat.mediaType }));
  }, [shown]);
  useEffect(
    () => () => {
      if (url !== null) URL.revokeObjectURL(url);
    },
    [url],
  );

  const forget = () => void del(unsavedKey, unsavedStore);

  const save = async (recreate = false): Promise<void> => {
    if (busy) return;
    if (banner === "deleted" && !recreate) {
      setConfirmRecreate(true);
      return;
    }
    setBusy(true);
    try {
      const result = await saveText(
        files,
        folder,
        path,
        mine,
        banner === "deleted" ? null : baseHash,
      );
      if (result.kind === "conflict") {
        setConflict({ stage: "ask" });
        return;
      }
      setBaseText(mine);
      setBaseHash(result.hash);
      setBanner(null);
      setStatus("Saved");
      forget();
    } catch (error) {
      setStatus(`Could not save it: ${errorText(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const choose = async (choice: ConflictChoice): Promise<void> => {
    setBusy(true);
    try {
      const outcome = await resolveConflict(choice, files, folder, path, mine);
      if (outcome.kind === "compare") {
        setMerged(mine);
        setConflict({ stage: "compare", diskText: outcome.diskText, diskHash: outcome.diskHash });
        return;
      }
      setConflict(null);
      setBanner(null);
      forget();
      if (outcome.kind === "overwritten") {
        setBaseText(mine);
        setBaseHash(outcome.hash);
        setStatus("Saved over the version on disk");
        return;
      }
      setMine(outcome.diskText);
      setBaseText(outcome.diskText);
      setBaseHash(outcome.diskHash);
      if (outcome.kind === "copied") {
        setStatus(`Saved yours as ${baseName(outcome.copy)}`);
        onCopySaved?.(outcome.copy);
      } else {
        setStatus("Your edits were dropped");
      }
    } catch (error) {
      setStatus(`Could not do that: ${errorText(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const saveMerged = async (diskHash: FileHash | null): Promise<void> => {
    setBusy(true);
    try {
      const result = await saveText(files, folder, path, merged, diskHash);
      if (result.kind === "conflict") {
        setConflict({ stage: "ask" });
        return;
      }
      setMine(merged);
      setBaseText(merged);
      setBaseHash(result.hash);
      setConflict(null);
      setBanner(null);
      setStatus("Saved");
      forget();
    } catch (error) {
      setStatus(`Could not save it: ${errorText(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const download = async (): Promise<void> => {
    if (shown.state !== "ready") return;
    if (shown.stat.size > DOWNLOAD_BYTES) {
      setStatus("Too large to download in the app (over 200 MB).");
      return;
    }
    try {
      const all = shown.complete ? shown.bytes : (await readFileBytes(files, folder, path)).bytes;
      downloadBytes(all, name, shown.stat.mediaType);
    } catch (error) {
      setStatus(`Could not download it: ${errorText(error)}`);
    }
  };

  const ready = shown.state === "ready" ? shown : null;
  const kind = ready?.choice.kind;
  const textual = kind === "text" || kind === "markdown" || kind === "html";
  const editable = ready?.choice.editable === true && ready.complete;
  const showsSource = kind === "text" || (textual && !rendered);

  return (
    <section aria-label={`File ${name}`} className="flex h-full min-h-0 flex-col bg-panel">
      <header className="flex min-h-9 shrink-0 flex-wrap items-center gap-1 border-b border-l2 px-2 py-1">
        {/* At least 8rem for the name: in a narrow panel the actions go to a row of their own instead. */}
        <span className="min-w-0 flex-[1_1_8rem] truncate text-sm text-t1" title={path}>
          {name}
          {dirty && <span className="text-t3"> · edited</span>}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {(kind === "markdown" || kind === "html") && (
            <Button variant="ghost" size="sm" onClick={() => setRendered((value) => !value)}>
              {rendered ? "Source" : "Rendered"}
            </Button>
          )}
          {showsSource && (
            <Button
              variant="ghost"
              size="sm"
              aria-pressed={wrap}
              className="text-t3 hover:text-t1 aria-pressed:bg-l2 aria-pressed:text-t1"
              onClick={() => setWrap((value) => !value)}
            >
              Wrap
            </Button>
          )}
          {kind === "image" && (
            <Button variant="ghost" size="sm" onClick={() => setFit((value) => !value)}>
              {fit ? "100%" : "Fit"}
            </Button>
          )}
          {editable && showsSource && !editing && (
            <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
              Edit
            </Button>
          )}
          {editable && (dirty || banner === "deleted") && (
            <Button size="sm" disabled={busy} onClick={() => void save()}>
              Save
            </Button>
          )}
          {ready !== null && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Download"
              onClick={() => void download()}
            >
              <Download />
            </Button>
          )}
          {onOpenAsTab !== undefined && (
            <Button variant="ghost" size="icon-sm" aria-label="Open as tab" onClick={onOpenAsTab}>
              <PanelTop />
            </Button>
          )}
          <Button variant="ghost" size="icon-sm" aria-label="Close the file" onClick={onClose}>
            <X />
          </Button>
        </div>
      </header>
      {banner === "changed" && (
        <div
          role="alert"
          className="flex shrink-0 items-center gap-2 bg-warn/10 px-2 py-1 text-xs text-t1"
        >
          <span className="flex-1">Changed on disk while you were editing.</span>
          <Button variant="ghost" size="sm" onClick={() => void choose("compare")}>
            Compare
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void choose("discard")}>
            Reload
          </Button>
        </div>
      )}
      {banner === "deleted" && (
        <div role="alert" className="shrink-0 bg-warn/10 px-2 py-1 text-xs text-t1">
          Deleted on disk. Saving puts it back.
        </div>
      )}
      {banner === "restored" && (
        <div
          role="status"
          className="flex shrink-0 items-center gap-2 bg-l1 px-2 py-1 text-xs text-t1"
        >
          <span className="flex-1">Restored unsaved edits.</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setMine(baseText);
              setBanner(null);
              forget();
            }}
          >
            Drop them
          </Button>
        </div>
      )}
      {status !== null && (
        <p role="status" className="shrink-0 px-2 py-0.5 text-xs text-t3">
          {status}
        </p>
      )}
      <div className="relative min-h-0 flex-1 overflow-auto">
        {shown.state === "loading" && <p className="p-3 text-sm text-t3">Opening…</p>}
        {shown.state === "failed" && (
          <p role="alert" className="p-3 text-sm text-bad-ink">
            Could not open it: {shown.message}
          </p>
        )}
        {ready !== null && showsSource && (
          <Suspense fallback={<p className="p-3 text-sm text-t3">Loading the editor…</p>}>
            <CodeEditor
              value={mine}
              path={path}
              readOnly={!(editable && editing)}
              wrap={wrap}
              onChange={setMine}
              onSave={() => void save()}
            />
          </Suspense>
        )}
        {ready !== null && kind === "markdown" && rendered && (
          <section className="tr-root px-3 py-2" aria-label="Rendered">
            <Markdown text={mine} />
          </section>
        )}
        {ready !== null && kind === "html" && rendered && (
          // No allow-same-origin: the page runs in an opaque origin, away from the app's cookies, storage and page; its
          // relative links lead nowhere, not to the app's address (`previewDocument`).
          <iframe
            title={`${name}, rendered`}
            sandbox="allow-scripts"
            srcDoc={previewDocument(mine)}
            className="h-full w-full bg-white"
          />
        )}
        {ready !== null && kind === "image" && url !== null && (
          <div className="grid h-full place-items-center p-2">
            <img
              src={url}
              alt={name}
              className={fit ? "max-h-full max-w-full object-contain" : "max-w-none"}
            />
          </div>
        )}
        {ready !== null && kind === "pdf" && pdfFailure === null && (
          <Suspense fallback={<p className="p-3 text-sm text-t3">Drawing the PDF…</p>}>
            <PdfView bytes={ready.bytes} name={name} onFailed={setPdfFailure} />
          </Suspense>
        )}
        {ready !== null && kind === "pdf" && url !== null && pdfFailure !== null && (
          <div className="flex flex-col gap-2 p-3">
            <p className="text-sm text-t3">This PDF can't be drawn here: {pdfFailure}</p>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => window.open(url, "_blank", "noopener")}>
                <ExternalLink /> Open
              </Button>
              <Button variant="ghost" onClick={() => void download()}>
                <Download /> Download
              </Button>
            </div>
          </div>
        )}
        {ready !== null && kind === "audio" && url !== null && (
          // biome-ignore lint/a11y/useMediaCaption: a file from the folder; it has no captions to give
          <audio controls src={url} className="m-3 w-[calc(100%-1.5rem)]" />
        )}
        {ready !== null && kind === "video" && url !== null && (
          // biome-ignore lint/a11y/useMediaCaption: a file from the folder; it has no captions to give
          <video controls src={url} className="max-h-full max-w-full" />
        )}
        {ready !== null && kind === "other" && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 p-3 text-sm">
            <dt className="text-t3">Name</dt>
            <dd className="truncate text-t1">{name}</dd>
            <dt className="text-t3">Size</dt>
            <dd className="text-t1">{sizeText(ready.stat.size)}</dd>
            <dt className="text-t3">Changed</dt>
            <dd className="text-t1">{new Date(ready.stat.modifiedMs).toLocaleString()}</dd>
          </dl>
        )}
        {ready !== null && !ready.complete && kind === "text" && (
          <div className="sticky bottom-0 flex items-center gap-2 border-t border-l2 bg-panel px-2 py-1 text-xs text-t3">
            <span className="flex-1">
              Showing the first 2 MB of {sizeText(ready.stat.size)}, read-only.
            </span>
            <Button variant="ghost" size="sm" onClick={() => void load(true)}>
              Load all
            </Button>
          </div>
        )}
      </div>
      <Dialog open={conflict !== null} onOpenChange={(open) => !open && setConflict(null)}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>This file changed since you opened it</DialogTitle>
            <DialogDescription>
              {conflict?.stage === "compare"
                ? "Merge on the right, then save it."
                : `${name} was changed on disk, by an agent or someone else. Nothing is overwritten unless you choose it.`}
            </DialogDescription>
          </DialogHeader>
          {conflict?.stage === "compare" && (
            <Suspense fallback={<p className="text-sm text-t3">Loading the comparison…</p>}>
              <MergeCompare disk={conflict.diskText} mine={mine} path={path} onChange={setMerged} />
            </Suspense>
          )}
          <DialogFooter className="flex-wrap gap-2">
            {conflict?.stage === "compare" ? (
              <Button disabled={busy} onClick={() => void saveMerged(conflict.diskHash)}>
                Save merged
              </Button>
            ) : (
              <>
                <Button variant="ghost" disabled={busy} onClick={() => void choose("discard")}>
                  Discard mine
                </Button>
                <Button variant="ghost" disabled={busy} onClick={() => void choose("copy")}>
                  Save as copy
                </Button>
                <Button variant="ghost" disabled={busy} onClick={() => void choose("overwrite")}>
                  Overwrite
                </Button>
                <Button disabled={busy} onClick={() => void choose("compare")}>
                  Compare
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={confirmRecreate} onOpenChange={setConfirmRecreate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Put the file back?</DialogTitle>
            <DialogDescription>
              {name} was deleted on disk. Saving makes it again with your text.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmRecreate(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                setConfirmRecreate(false);
                void save(true);
              }}
            >
              Save it again
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
