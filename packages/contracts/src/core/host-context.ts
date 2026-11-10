/**
 * What the person is looking at in the app that embeds the lite view (a browser's page, an editor's file, a note), as a
 * person's message carries it: the block that ends the message, after the typed text and the attached files' paragraph.
 * The lite view writes it (`withHostContext`), the transcript reads it back for a chip (`splitHostContext`), and the
 * server leaves it out of a chat's first prompt (`firstPromptTextOf`). All read the constants below, so they cannot drift
 * apart. Values are written with `&`, `<`, `>` and `"` as entities, so a page's text can never close the block early.
 */
import { z } from "zod";
import { MESSAGE_HOST_PATTERN } from "./message-host";

/** What kind of thing it is: `page`, `file`, `note` and so on (lowercase letters and dashes). */
export const HOST_CONTEXT_KIND_PATTERN = /^[a-z][a-z-]{0,31}$/;
/** The most of a selection a message carries. */
export const HOST_CONTEXT_SELECTION_MAX = 8_000;
/** The most of the thing's own text a message carries; a host gives the rest through a tool. */
export const HOST_CONTEXT_TEXT_MAX = 8_000;

export const HostContext = z.strictObject({
  kind: z.string().regex(HOST_CONTEXT_KIND_PATTERN),
  title: z.string().trim().min(1).max(300),
  /** Its address: a page's URL, a file's path. */
  uri: z.string().max(2_000).optional(),
  /** What is selected in it, if anything. */
  selection: z.string().max(HOST_CONTEXT_SELECTION_MAX).optional(),
  /** Some of its text, when the host gives it with every message. */
  text: z.string().max(HOST_CONTEXT_TEXT_MAX).optional(),
});
export type HostContext = z.infer<typeof HostContext>;

/** A message's host context read back: the context, and the app that gave it. */
export interface SentHostContext extends HostContext {
  readonly host: string;
}

const TAG = "host-context";
const OPEN = `<${TAG} `;
const CLOSE = `</${TAG}>`;
const PART_TAGS = ["selection", "text"] as const;

const toEntities = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const fromEntities = (value: string): string =>
  value
    .replaceAll("&quot;", '"')
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");

/** The block for a context: its attributes on the opening tag, then its selection and text, each in its own tags. */
function blockOf(host: string, context: HostContext): string {
  const attributes = [
    `host="${toEntities(host)}"`,
    `kind="${toEntities(context.kind)}"`,
    `title="${toEntities(context.title)}"`,
    ...(context.uri === undefined ? [] : [`uri="${toEntities(context.uri)}"`]),
  ].join(" ");
  const parts = PART_TAGS.flatMap((name) => {
    const value = context[name];
    return value === undefined || value === ""
      ? []
      : [`<${name}>\n${toEntities(value)}\n</${name}>`];
  });
  return [`${OPEN}${attributes}>`, ...parts, CLOSE].join("\n");
}

/** The message omp gets: the message as written, then the block saying what the person has open in `host`. */
export function withHostContext(message: string, host: string, context: HostContext): string {
  const block = blockOf(host, context);
  return message === "" ? block : `${message}\n\n${block}`;
}

const ATTRIBUTE = /([a-z]+)="([^"]*)"/g;

/** The context a block gives, or none when it is not one the writer writes. */
function contextOf(block: string): SentHostContext | null {
  const firstLineEnd = block.indexOf("\n");
  if (firstLineEnd === -1 || !block.endsWith(`\n${CLOSE}`)) return null;
  const opening = block.slice(OPEN.length, firstLineEnd);
  if (!opening.endsWith(">")) return null;
  const attributes = new Map<string, string>();
  for (const match of opening.slice(0, -1).matchAll(ATTRIBUTE)) {
    attributes.set(match[1] ?? "", fromEntities(match[2] ?? ""));
  }
  let body = block.slice(firstLineEnd + 1, block.length - CLOSE.length - 1);
  const parts: Partial<Record<(typeof PART_TAGS)[number], string>> = {};
  for (const name of PART_TAGS) {
    const open = `<${name}>\n`;
    const close = `\n</${name}>`;
    if (!body.startsWith(open)) continue;
    const end = body.indexOf(close);
    if (end === -1) return null;
    parts[name] = fromEntities(body.slice(open.length, end));
    body = body.slice(end + close.length).replace(/^\n/, "");
  }
  if (body !== "") return null;
  const host = attributes.get("host") ?? "";
  const parsed = HostContext.safeParse({
    kind: attributes.get("kind"),
    title: attributes.get("title"),
    ...(attributes.has("uri") ? { uri: attributes.get("uri") } : {}),
    ...parts,
  });
  if (!MESSAGE_HOST_PATTERN.test(host) || !parsed.success) return null;
  return { host, ...parsed.data };
}

/** A message read back: what was written before the block, and the context; a message without the block is all text. */
export function splitHostContext(message: string): {
  readonly text: string;
  readonly context: SentHostContext | null;
} {
  const whole = { text: message, context: null };
  const at = message.lastIndexOf(OPEN);
  if (at === -1 || (at > 0 && !message.slice(0, at).endsWith("\n\n"))) return whole;
  const context = contextOf(message.slice(at));
  if (context === null) return whole;
  return { text: at === 0 ? "" : message.slice(0, at - 2), context };
}

/**
 * Where in a file or notebook a context points, read from its uri as VS Code's panel writes it
 * (`apps/vscode/src/context.ts`): `<path>#L<a>-<b>` for lines a to b, `<path>#cell<n>` for a notebook's cell n (counted
 * from 1, top to bottom), `<path>#cell<n>-L<a>-<b>` for lines in that cell. A uri without such an ending is all path.
 */
export interface HostContextPlace {
  readonly path: string;
  readonly cell?: number;
  readonly lines?: readonly [number, number];
}

const PLACE = /^(.+?)#(?:cell([1-9]\d*)(?:-L([1-9]\d*)-([1-9]\d*))?|L([1-9]\d*)-([1-9]\d*))$/;

/** The place a file's or notebook's uri names (`HostContextPlace`). */
export function hostContextPlace(uri: string): HostContextPlace {
  const match = PLACE.exec(uri);
  if (match === null) return { path: uri };
  const [, path = uri, cell, cellFrom, cellTo, from, to] = match;
  const range = (a?: string, b?: string): readonly [number, number] | undefined =>
    a === undefined || b === undefined ? undefined : [Number(a), Number(b)];
  const lines = range(cellFrom, cellTo) ?? range(from, to);
  return {
    path,
    ...(cell === undefined ? {} : { cell: Number(cell) }),
    ...(lines === undefined ? {} : { lines }),
  };
}

const nameOf = (path: string): string => path.split(/[/\\]/).pop() || path;
const linesSaid = ([from, to]: readonly [number, number]): string =>
  from === to ? `Line ${from}` : `Lines ${from}–${to}`;

/**
 * What a context is, in a few words, for its chip above the message box and on a sent message: "Looking at app.ts",
 * "Lines 3–7 of app.ts", "Cell 4 of notes.ipynb", "Lines 3–7 of cell 4, notes.ipynb"; a page or any other kind of
 * thing by its title: "Looking at <title>", "A selection on <title>".
 */
export function describeHostContext(context: HostContext): string {
  if (context.kind === "file" || context.kind === "notebook") {
    const place = hostContextPlace(context.uri ?? context.title);
    const name = nameOf(place.path);
    if (place.cell !== undefined) {
      return place.lines === undefined
        ? `Cell ${place.cell} of ${name}`
        : `${linesSaid(place.lines)} of cell ${place.cell}, ${name}`;
    }
    if (place.lines !== undefined) return `${linesSaid(place.lines)} of ${name}`;
    return context.selection === undefined ? `Looking at ${name}` : `A selection in ${name}`;
  }
  return context.selection === undefined
    ? `Looking at ${context.title}`
    : `A selection on ${context.title}`;
}
