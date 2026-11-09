/**
 * The embed protocol, version 1: how a page that frames the app's lite view (`/lite`) talks to it with `postMessage`. A
 * browser extension's panel, an editor's webview, a notes app's side panel: each is such a host.
 *
 * Every message is an object with `omp: "embed"`, the version `v: 1` and a `type`. The lite view says `listening` once its
 * page has loaded; the host then sends `hello`, and the lite view answers `ready`, and again whenever it shows another
 * chat. After that the host may send `settings`, `context` and `tools` at any time, and answers each `tool_call` with one
 * `tool_result`. The lite view takes messages only from the window that frames it, and only from the origin of its first
 * `hello`; it sends only to that origin (`listening` excepted, which carries nothing).
 *
 * - **Settings**: the look and the words of the empty chat, as the address's parameters set them before the first paint.
 * - **Context**: what the person is looking at in the host. It goes with each message sent from the panel
 *   (`withHostContext`), and the panel shows it, with a way to leave it out.
 * - **Tools**: the host's own tools, given to the chat the panel shows and to no other; only this panel answers their
 *   calls. A call reaches the host as `tool_call`, a call omp gave up on as `tool_cancel`.
 */
import { z } from "zod";
import { HostContext } from "./host-context";
import { MESSAGE_HOST_PATTERN } from "./message-host";

export const EMBED_PROTOCOL = "embed";
export const EMBED_VERSION = 1;

/** The most tools one host gives. */
export const EMBED_TOOLS_MAX = 64;

/** The look and the words a host sets; each one left out keeps what the address or the app set. */
export const EmbedSettings = z.strictObject({
  theme: z.enum(["light", "dark", "system"]).optional(),
  /** The host's colours, font and text size, as the address's `bg`, `surface`, `fg`, `muted`, `border`, `accent`, `font` and `fontSize` take them. */
  look: z.record(z.string(), z.string().max(200)).optional(),
  greeting: z.string().trim().max(120).optional(),
  suggestions: z.array(z.string().trim().min(1).max(60)).max(5).optional(),
  placeholder: z.string().trim().max(80).optional(),
});
export type EmbedSettings = z.infer<typeof EmbedSettings>;

/** One of the host's tools: a name omp shows, what it does, and its parameters as a JSON Schema object. */
export const EmbedTool = z.strictObject({
  name: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  description: z.string().trim().min(1).max(4_000),
  parameters: z.record(z.string(), z.unknown()),
});
export type EmbedTool = z.infer<typeof EmbedTool>;

/** What a call of a host's tool returns: text, pictures (base64), or an error's text. */
export const EmbedToolResult = z.strictObject({
  content: z
    .array(
      z.discriminatedUnion("type", [
        z.strictObject({ type: z.literal("text"), text: z.string() }),
        z.strictObject({
          type: z.literal("image"),
          data: z.string(),
          mimeType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
        }),
      ]),
    )
    .max(32),
  isError: z.boolean().optional(),
});
export type EmbedToolResult = z.infer<typeof EmbedToolResult>;

/**
 * The project whose files are on the host's computer (VS Code on a laptop): its name and an id the host derives from its
 * folder there (hex). The panel's chats then run in the server's folder for that project (`A0.app.hostFolder`), with
 * omp's own file and shell tools left out; the host's tools reach the files.
 */
export const EmbedFiles = z.strictObject({
  project: z.string().trim().min(1).max(64),
  id: z.string().regex(/^[a-f0-9]{8,64}$/),
});
export type EmbedFiles = z.infer<typeof EmbedFiles>;

const envelope = { omp: z.literal(EMBED_PROTOCOL), v: z.literal(EMBED_VERSION) };

/** What a host sends the lite view. */
export const EmbedHostMessage = z.discriminatedUnion("type", [
  z.strictObject({
    ...envelope,
    type: z.literal("hello"),
    /** The host's name, as messages and extensions name it (`MESSAGE_HOST_PATTERN`). */
    host: z.string().regex(MESSAGE_HOST_PATTERN),
    settings: EmbedSettings.optional(),
    context: HostContext.nullable().optional(),
    tools: z.array(EmbedTool).max(EMBED_TOOLS_MAX).optional(),
    /**
     * The panel's key, which the host keeps (`/lite?embed=1`): another app's frame keeps no cookie of the app, so the
     * panel signs in with it. The host got it from the panel's `credential`.
     */
    credential: z.string().min(1).max(200).optional(),
    /** The chat's files are on the host's computer (`EmbedFiles`); said in the first hello, read once. */
    files: EmbedFiles.optional(),
  }),
  z.strictObject({ ...envelope, type: z.literal("settings"), settings: EmbedSettings }),
  z.strictObject({ ...envelope, type: z.literal("context"), context: HostContext.nullable() }),
  z.strictObject({
    ...envelope,
    type: z.literal("tools"),
    tools: z.array(EmbedTool).max(EMBED_TOOLS_MAX),
  }),
  z.strictObject({
    ...envelope,
    type: z.literal("tool_result"),
    callId: z.string().min(1).max(200),
    result: EmbedToolResult,
  }),
]);
export type EmbedHostMessage = z.infer<typeof EmbedHostMessage>;

/** What the lite view sends its host, without the envelope. */
export type EmbedAppBody =
  /** The view's page has loaded and listens: sent once, to any origin, carrying nothing; the host sends `hello` after it. */
  | { readonly type: "listening" }
  | {
      readonly type: "ready";
      /** The chat shown: its id, which changes once a new chat's first message is saved. */
      readonly chat: string;
      /** The names of the host's tools the chat took. */
      readonly tools: readonly string[];
    }
  | {
      readonly type: "tool_call";
      readonly callId: string;
      readonly name: string;
      readonly arguments: Record<string, unknown>;
    }
  | { readonly type: "tool_cancel"; readonly callId: string }
  /** The panel paired: the host keeps this key, out of any page's reach, and gives it back in each `hello`. */
  | { readonly type: "credential"; readonly key: string };

/** What the lite view sends its host. */
export type EmbedAppMessage = EmbedAppBody & {
  readonly omp: typeof EMBED_PROTOCOL;
  readonly v: typeof EMBED_VERSION;
};

/** A message the lite view sends, with its envelope. */
export function embedMessage(body: EmbedAppBody): EmbedAppMessage {
  return { omp: EMBED_PROTOCOL, v: EMBED_VERSION, ...body };
}
