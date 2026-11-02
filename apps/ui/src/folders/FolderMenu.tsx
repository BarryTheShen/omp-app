import type { AppClient } from "@omp-app/client";
import { type FolderPath, HostMetadataPort, SessionFileStore } from "@omp-app/contracts";
import { cn } from "cn";
import { Check, ChevronsUpDown, Folder, FolderOpen } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
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
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { folderName, shownFolder, typedFolder } from "./folder";
import type { FolderChoice } from "./useFolder";

/** How many folders with chats the menu lists. */
const LISTED = 50;

/**
 * The folder at the top of the sidebar: the list shows its chats, and New chat starts one there. Its menu lists the
 * folders that have chats, the one shown first, and opens any other folder by its path.
 */
export function FolderMenu({
  client,
  choice,
}: {
  readonly client: AppClient;
  readonly choice: FolderChoice;
}): ReactNode {
  const { folder, home, notice, choose } = choice;
  const [folders, setFolders] = useState<readonly FolderPath[]>([]);
  const [typing, setTyping] = useState(false);
  const listed = [...new Set([folder, ...folders])];
  return (
    <>
      <DropdownMenu
        onOpenChange={(open) => {
          if (!open) return;
          client
            .port(SessionFileStore)
            .listFolders({ limit: LISTED })
            .then(
              (result) => setFolders(result.folders),
              () => setFolders([]),
            );
        }}
      >
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              data-tour="folder"
              aria-label={`Folder: ${shownFolder(folder, home)}`}
              className="justify-start gap-2 px-2 text-t2 hover:text-t1 tablet:h-11"
            />
          }
        >
          <Folder />
          <span className="min-w-0 flex-1 truncate text-left">{folderName(folder, home)}</span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-t3" />
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-72" data-tour="folder-menu">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Folders with chats</DropdownMenuLabel>
            {listed.map((each) => (
              <DropdownMenuItem key={each} className="items-start" onClick={() => choose(each)}>
                <Check className={cn("mt-0.5", each !== folder && "invisible")} />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{folderName(each, home)}</span>
                  <span className="truncate text-xs text-t3">{shownFolder(each, home)}</span>
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setTyping(true)}>
            <FolderOpen />
            Open a folder…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {notice !== null && (
        <p role="alert" className="px-2 py-1 text-xs text-bad-ink">
          {notice}
        </p>
      )}
      <Dialog open={typing} onOpenChange={setTyping}>
        {typing && (
          <OpenFolder
            client={client}
            home={home}
            onOpen={(next) => {
              choose(next);
              setTyping(false);
            }}
            onClose={() => setTyping(false)}
          />
        )}
      </Dialog>
    </>
  );
}

/** Opens a folder by its typed path, once the server has found it. */
function OpenFolder({
  client,
  home,
  onOpen,
  onClose,
}: {
  readonly client: AppClient;
  readonly home: FolderPath | null;
  readonly onOpen: (folder: FolderPath) => void;
  readonly onClose: () => void;
}): ReactNode {
  const [typed, setTyped] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const submit = (): void => {
    if (checking) return;
    const result = typedFolder(typed, home);
    if (!result.ok) {
      setProblem(result.message);
      return;
    }
    setChecking(true);
    setProblem(null);
    client
      .port(HostMetadataPort)
      .read({ folder: result.folder })
      .then(() => onOpen(result.folder))
      .catch((failure: unknown) =>
        setProblem(failure instanceof Error ? failure.message : String(failure)),
      )
      .finally(() => setChecking(false));
  };
  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Open a folder</DialogTitle>
        <DialogDescription>
          Its chats show in the sidebar, and New chat starts one there.
        </DialogDescription>
      </DialogHeader>
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <label className="flex flex-col gap-1 text-sm text-t2">
          Folder path
          <input
            // biome-ignore lint/a11y/noAutofocus: the dialog opens to take the path
            autoFocus
            spellCheck={false}
            placeholder={home === null ? "/path/to/project" : "~/path/to/project"}
            className="h-8 rounded-md border border-l2 bg-transparent px-2.5 font-mono text-[0.8125rem] text-t1 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={typed}
            aria-invalid={problem !== null}
            onChange={(event) => {
              setTyped(event.target.value);
              setProblem(null);
            }}
          />
        </label>
        {problem !== null && (
          <p role="alert" className="text-xs text-bad-ink">
            {problem}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={typed.trim() === "" || checking}>
            Open
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
