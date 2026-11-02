import { type WorkspaceFileChanged, WorkspaceFilesPort } from "@omp-app/contracts";
import type { PortHandlerContext, PortRegistration } from "../../../registry/ports";
import { listEntries, readChunk, statPath } from "../workspace-files/read";
import type { A1PortContext } from "./context";
import { createA1PortRegistration } from "./helper";

/**
 * The Files panel's port (#2782). Reads need nothing kept; writes, trash and watches go through the server's
 * `workspaceFiles` service, which logs who changed what. A connection's watches end with it.
 */
export function createWorkspaceFilesRegistration(context: A1PortContext): PortRegistration {
  const files = context.workspaceFiles;
  const device = (call: PortHandlerContext) => files.deviceOf(call.connectionId);
  const registration = createA1PortRegistration(
    WorkspaceFilesPort,
    {
      list: (args) => listEntries(args),
      stat: (args) => statPath(args),
      read: (args) => readChunk(args),
      beginWrite: (args, call) => files.writes.beginWrite(args, device(call)),
      writeChunk: (args) => files.writes.writeChunk(args),
      commit: (args) => files.writes.commit(args),
      createDirectory: (args, call) => files.writes.createDirectory(args, device(call)),
      move: (args, call) => files.writes.move(args, device(call)),
      trash: (args, call) => files.trash.trash(args, device(call)),
      restore: (args, call) => files.trash.restore(args, device(call)),
      watch: async (args, call) => {
        await files.watches.set(call.connectionId, args.folder, args.paths);
        return {};
      },
    },
    context.publish,
    [
      {
        event: "changed",
        subscribe: (listener) => files.watches.onChange(listener),
        // Told on the folder's stream: every page showing that folder hears it.
        scope: (payload) => (payload as WorkspaceFileChanged).folder,
      },
    ],
    context.watchStreamActivity,
  );
  return {
    ...registration,
    onConnectionClosed: (connectionId) => files.watches.dropConnection(connectionId),
  };
}
