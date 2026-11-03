import { WorkspaceFilesPort } from "@omp-app/contracts";
import type { IDockviewPanelProps } from "dockview-react";
import { type ReactNode, use, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SidePaneContext } from "../SidePane";
import { type DiskChange, FileViewer } from "./FileViewer";
import type { FilePaneParams } from "./filePaneParams";
import { baseName } from "./names";
import { PageShare } from "./PageShare";
import { watchHub } from "./watchHub";

/** The Files panel's viewer as a pane beside the chats, for wide editing; it watches its own file. */
export function FilePane({ params, api }: IDockviewPanelProps<FilePaneParams>): ReactNode {
  const host = use(SidePaneContext);
  const client = host?.client;
  const files = useMemo(() => client?.port(WorkspaceFilesPort), [client]);
  const [change, setChange] = useState<DiskChange | null>(null);
  const [dirty, setDirty] = useState(false);
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    api.setTitle(baseName(params.path));
  }, [api, params.path]);

  useEffect(() => {
    if (client === undefined) return;
    const hub = watchHub(client, params.folder);
    hub.want(api, [params.path]);
    const stop = hub.listen((event) => {
      if (event.path === params.path) setChange({ change: event.change, at: Date.now() });
    });
    return () => {
      stop();
      hub.want(api, []);
    };
  }, [client, api, params.folder, params.path]);

  if (files === undefined) return null;
  return (
    <>
      <FileViewer
        files={files}
        folder={params.folder}
        path={params.path}
        change={change}
        onDirtyChange={setDirty}
        onClose={() => (dirty ? setAsking(true) : api.close())}
        pageShare={
          client !== undefined && (
            <PageShare client={client} folder={params.folder} path={params.path} />
          )
        }
      />
      <Dialog open={asking} onOpenChange={setAsking}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Close without saving?</DialogTitle>
            <DialogDescription>
              Your edits to {baseName(params.path)} are not saved.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAsking(false)}>
              Keep editing
            </Button>
            <Button variant="destructive" onClick={() => api.close()}>
              Close it
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
