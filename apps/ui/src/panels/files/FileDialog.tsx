import type { AppClient } from "@omp-app/client";
import {
  type FolderPath,
  WorkspaceFilesPort,
  type WorkspaceRelativePath,
} from "@omp-app/contracts";
import { ChevronLeft } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FileViewer } from "./FileViewer";
import { baseName } from "./names";

/**
 * A file of the folder over the whole screen (#17), as a phone's Files panel shows one: a reply's link to a file opens
 * it here on a phone, read over the app's own connection. Closing with unsaved edits asks first.
 */
export function FileDialog({
  client,
  folder,
  path,
  back,
  onClose,
}: {
  readonly client: AppClient;
  readonly folder: FolderPath;
  readonly path: WorkspaceRelativePath;
  /** Where the back button returns to. */
  readonly back: string;
  readonly onClose: () => void;
}): ReactNode {
  const files = useMemo(() => client.port(WorkspaceFilesPort), [client]);
  const [dirty, setDirty] = useState(false);
  const [asking, setAsking] = useState(false);
  const close = (): void => (dirty ? setAsking(true) : onClose());
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="top-0 left-0 flex h-full max-h-none w-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none p-0 pt-(--safe-top) pr-(--safe-right) pb-(--safe-bottom) pl-(--safe-left) ring-0 sm:max-w-none"
      >
        <DialogTitle className="sr-only">{baseName(path)}</DialogTitle>
        <Button
          variant="ghost"
          className="h-11 shrink-0 justify-start gap-1 self-start px-2 text-t2"
          onClick={close}
        >
          <ChevronLeft /> {back}
        </Button>
        <div className="min-h-0 flex-1">
          <FileViewer
            files={files}
            folder={folder}
            path={path}
            change={null}
            onDirtyChange={setDirty}
            onClose={close}
          />
        </div>
      </DialogContent>
      <Dialog open={asking} onOpenChange={setAsking}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Close without saving?</DialogTitle>
            <DialogDescription>Your edits to {baseName(path)} are not saved.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" className="h-11" onClick={() => setAsking(false)}>
              Keep editing
            </Button>
            <Button variant="destructive" className="h-11" onClick={onClose}>
              Close it
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Dialog>
  );
}
