import { z } from "zod";
import type { PortClient, PortHandlers } from "../../core/envelope";
import { definePort } from "../../core/envelope";
import { FolderPath, ThreadId } from "../../core/ids";
import { WorkspaceRelativePath } from "../A1/file-search";

const EmptyArgs = z.object({}).strict();
const PortNumber = z.number().int().min(1).max(65_535);

/** The name of the cookie a shared page's address keeps its sign-in in (#2788); its share's id follows. */
export const SHARE_COOKIE_PREFIX = "omp-app-share-";
/** Where a ticket is turned into that cookie, on a share's own address. */
export const SHARE_ENTER_PATH = "/__omp-app/enter";
/** A ticket works once, this soon after it was made. */
export const SHARE_TICKET_MS = 60_000;
/** A share no one used for this long ends by itself. */
export const SHARE_IDLE_MS = 12 * 60 * 60_000;

/** A program listening for connections on the server's machine (#2788). */
export const ListeningService = z
  .object({
    port: PortNumber,
    /** Where it listens: `127.0.0.1` and `::1` for the machine only, `0.0.0.0` and `::` for every network. */
    address: z.string(),
    /** Its name; null for another user's program, which the app cannot look into. */
    program: z.string().nullable(),
    command: z.string().nullable(),
    startedAt: z.number().nullable(),
    /** The chat that started it, when one did. */
    threadId: ThreadId.nullable(),
    /** On the never-share list: shown, never shared. */
    neverShare: z.boolean(),
  })
  .strict();
export type ListeningService = z.infer<typeof ListeningService>;

/** A service or a page opened to the paired devices at an address of its own. */
export const Share = z
  .object({
    id: z.string().min(1),
    kind: z.enum(["service", "page"]),
    /** A service's port on the machine. */
    port: PortNumber.nullable(),
    /** A page's folder and file. */
    folder: FolderPath.nullable(),
    path: WorkspaceRelativePath.nullable(),
    /** Its address; a device opens it through `open`, which signs that device in. */
    url: z.string(),
    /** Shared by itself: a service a chat started. */
    automatic: z.boolean(),
    threadId: ThreadId.nullable(),
    createdAt: z.number(),
    lastUsedAt: z.number(),
    /**
     * Who opened it, to be said in a sentence: each paired device's name, "this computer" for the app's own computer,
     * "a paired device" for one no longer listed.
     */
    openedBy: z.array(z.string()),
  })
  .strict();
export type Share = z.infer<typeof Share>;

export const SharesList = z
  .object({
    services: z.array(ListeningService),
    shares: z.array(Share),
    /** The machine's address on the private network that shares open at; null when it has none, and nothing can be shared. */
    address: z.string().nullable(),
  })
  .strict();
export type SharesList = z.infer<typeof SharesList>;

const ShareIdArgs = z.object({ id: z.string().min(1) }).strict();

export const SharesPort = definePort({
  name: "A0.shares",
  methods: {
    list: { args: EmptyArgs, result: SharesList },
    /** Shares a service of this machine, by its port; one shared already is answered as it is. */
    share: { args: z.object({ port: PortNumber }).strict(), result: Share },
    /** Shares the folder of an HTML file, so the page opens with its styles, scripts and pictures. */
    sharePage: {
      args: z.object({ folder: FolderPath, path: WorkspaceRelativePath }).strict(),
      result: Share,
    },
    /**
     * omp's statistics page (#2836 D6): the server runs omp's own (`omp stats`) on this machine when first asked, and
     * shares it as a service, so it opens on the paired devices at an address of its own.
     */
    shareStats: { args: EmptyArgs, result: Share },
    /** A one-time address that signs this device in to the share and opens it. */
    open: { args: ShareIdArgs, result: z.object({ url: z.string() }).strict() },
    stop: { args: ShareIdArgs, result: z.null() },
  },
  events: {
    /** The services or the shares changed. */
    changed: { payload: z.object({ at: z.number() }).strict() },
    /** A service a chat started was shared by itself: the chat says where it opens. */
    sharedForChat: {
      payload: z
        .object({ threadId: ThreadId, share: Share, program: z.string().nullable() })
        .strict(),
    },
  },
});
export type SharesPort = typeof SharesPort;
export type SharesClient = PortClient<SharesPort>;
export type SharesHandlers<Context> = PortHandlers<SharesPort, Context>;
