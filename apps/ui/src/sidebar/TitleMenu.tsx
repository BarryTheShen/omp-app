import type { ThreadId } from "@omp-app/contracts";
import { ChevronDown, PencilLine, Pin, PinOff, Trash2, X } from "lucide-react";
import { type ReactNode, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { firstPromptOf } from "../chat/firstPrompts";
import { titleOf } from "./title";
import type { ChatList } from "./useChatList";

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * The name of the chat shown: a saved chat's name as the list has it, a chat's first message while its first reply runs
 * (it has no file to name it yet), else "New chat".
 */
export function shownTitle(list: ChatList, focused: ThreadId | null): string {
  if (focused === null) return "New chat";
  const saved = list.sessions.find((session) => session.id === focused);
  return saved !== undefined ? titleOf(saved) : (firstPromptOf(focused) ?? "New chat");
}

/**
 * The phone's top bar's name for the chat shown, the page's heading. A saved chat's name opens a menu with what holding
 * its row in the list offers (Pin or Unpin, Rename, Delete), so those are within reach without that hold.
 */
export function TitleMenu({
  list,
  focused,
  onDeleted,
}: {
  readonly list: ChatList;
  readonly focused: ThreadId | null;
  /** The chat was deleted: the panes that showed it move on. */
  readonly onDeleted: (id: ThreadId) => void;
}): ReactNode {
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const title = shownTitle(list, focused);
  const saved =
    focused === null ? undefined : list.sessions.find((session) => session.id === focused);
  if (saved === undefined) {
    return (
      <h1 className="min-w-0 flex-1 truncate text-center text-sm font-medium text-t1">{title}</h1>
    );
  }
  const pinned = list.pinned.has(saved.id);
  const failed = (what: string) => (failure: unknown) =>
    setProblem(`${what}: ${errorText(failure)}`);
  return (
    <>
      <h1 className="flex min-w-0 flex-1 justify-center">
        <DropdownMenu>
          <DropdownMenuTrigger className="flex min-h-11 max-w-full min-w-0 items-center gap-1 rounded-lg px-2 text-sm font-medium text-t1 outline-none hover:bg-l1 focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-l2">
            <span className="truncate">{title}</span>
            <ChevronDown aria-hidden="true" className="size-3.5 shrink-0 text-t3" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="center" className="w-56">
            <DropdownMenuItem
              onClick={() => {
                setProblem(null);
                list.setPinned(saved.id, !pinned).catch(failed("Could not change the pin"));
              }}
            >
              {pinned ? <PinOff /> : <Pin />}
              {pinned ? "Unpin" : "Pin"}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setRenaming(true)}>
              <PencilLine />
              Rename…
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onClick={() => setDeleting(true)}>
              <Trash2 />
              Delete…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </h1>
      {problem !== null && (
        <p
          role="alert"
          className="fixed top-[calc(var(--safe-top)+3rem)] right-[calc(var(--safe-right)+0.75rem)] left-[calc(var(--safe-left)+0.75rem)] z-50 flex items-center gap-2 rounded-lg border border-l2 bg-card px-3 py-2 text-xs text-bad-ink shadow-md"
        >
          <span className="min-w-0 flex-1">{problem}</span>
          <Button
            variant="ghost"
            size="icon"
            className="size-11 shrink-0"
            aria-label="Dismiss"
            onClick={() => setProblem(null)}
          >
            <X />
          </Button>
        </p>
      )}
      <Dialog open={renaming} onOpenChange={setRenaming}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename this chat</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const name = String(new FormData(event.currentTarget).get("name") ?? "").trim();
              setRenaming(false);
              if (name === "" || name === title) return;
              setProblem(null);
              list.rename(saved.id, name).catch(failed("Could not rename it"));
            }}
          >
            <Input name="name" aria-label="Chat title" defaultValue={title} autoFocus />
            <DialogFooter className="mt-4">
              <Button type="button" variant="ghost" onClick={() => setRenaming(false)}>
                Cancel
              </Button>
              <Button type="submit">Rename</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <AlertDialog open={deleting} onOpenChange={setDeleting}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this chat?</AlertDialogTitle>
            <AlertDialogDescription>
              “{title}” and its files are deleted. This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setDeleting(false);
                setProblem(null);
                list
                  .remove(saved)
                  .then(() => onDeleted(saved.id))
                  .catch(failed("Could not delete it"));
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
