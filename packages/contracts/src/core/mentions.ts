/**
 * What a person's message mentions, as an extension adds it for the model: the content of each mentioned page or block
 * (a SiYuan page by `@`), in one block after the typed text and before the host context. The model reads all of it; the
 * transcript shows only a tag per mention over the message (`splitMentions`), never the content: a message bubble holds
 * what the person typed. Titles and addresses are attributes written with entities; a mention's content is kept as it
 * is, with only a closing tag of its own inside it broken (`</mention` → `&lt;/mention`), so it can never end early.
 *
 * ```
 * <mentions source="siyuan">
 * A line for the model about what follows.
 * <mention title="Birthday menu" uri="siyuan://blocks/20261118234433-s84elov">
 * …the page's content…
 * </mention>
 * </mentions>
 * ```
 */
import { MESSAGE_HOST_PATTERN } from "./message-host";

export interface Mentioned {
  readonly title: string;
  /** Where it is: `siyuan://blocks/<id>`, a URL. */
  readonly uri?: string;
}

export interface SentMentions {
  /** Who added them: `siyuan`. */
  readonly source: string;
  readonly items: readonly Mentioned[];
}

const OPEN = "<mentions ";
const CLOSE = "</mentions>";

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

/** The message with its mentions' block after it (`note` is a line for the model about them). */
export function withMentions(
  message: string,
  source: string,
  note: string,
  items: readonly (Mentioned & { readonly content: string })[],
): string {
  if (items.length === 0) return message;
  const block = [
    `${OPEN}source="${toEntities(source)}">`,
    ...(note === "" ? [] : [note]),
    ...items.map((item) =>
      [
        `<mention title="${toEntities(item.title)}"${item.uri === undefined ? "" : ` uri="${toEntities(item.uri)}"`}>`,
        item.content.replaceAll("</mention", "&lt;/mention"),
        "</mention>",
      ].join("\n"),
    ),
    CLOSE,
  ].join("\n");
  return message === "" ? block : `${message}\n\n${block}`;
}

const MENTION_OPEN = /^<mention ([^>]*)>$/gm;
const ATTRIBUTE = /([a-z]+)="([^"]*)"/g;

/** A message read back: what was written before the block, and what it mentioned; without the block, all text. */
export function splitMentions(message: string): {
  readonly text: string;
  readonly mentions: SentMentions | null;
} {
  const whole = { text: message, mentions: null };
  if (message.endsWith(`\n${LEGACY_CLOSE}`)) return splitLegacy(message) ?? whole;
  if (!message.endsWith(`\n${CLOSE}`)) return whole;
  const at = message.lastIndexOf(OPEN);
  if (at === -1 || (at > 0 && !message.slice(0, at).endsWith("\n\n"))) return whole;
  const block = message.slice(at);
  const firstLineEnd = block.indexOf("\n");
  const source = /^<mentions source="([^"]*)">$/.exec(block.slice(0, firstLineEnd))?.[1];
  if (source === undefined || !MESSAGE_HOST_PATTERN.test(fromEntities(source))) return whole;
  const items: Mentioned[] = [];
  for (const match of block.matchAll(MENTION_OPEN)) {
    const attributes = new Map<string, string>();
    for (const pair of (match[1] ?? "").matchAll(ATTRIBUTE)) {
      attributes.set(pair[1] ?? "", fromEntities(pair[2] ?? ""));
    }
    const title = attributes.get("title")?.trim();
    if (title === undefined || title === "") continue;
    const uri = attributes.get("uri");
    items.push(uri === undefined ? { title } : { title, uri });
  }
  if (items.length === 0) return whole;
  return {
    text: at === 0 ? "" : message.slice(0, at - 2),
    mentions: { source: fromEntities(source), items },
  };
}

const LEGACY_OPEN = "<siyuan-context>";
const LEGACY_CLOSE = "</siyuan-context>";
/** A mention's heading as the SiYuan extension wrote it before this format (until 2026-11-20). */
const LEGACY_HEAD = /^### SiYuan [a-z ]+ "(.*)" \(id (\d{14}-[a-z0-9]{7})\)$/gm;

/** Messages sent before this format: the SiYuan extension's `<siyuan-context>` block, its mentions read from headings. */
function splitLegacy(
  message: string,
): { readonly text: string; readonly mentions: SentMentions } | null {
  const at = message.lastIndexOf(`\n\n${LEGACY_OPEN}\n`);
  const start = message.startsWith(`${LEGACY_OPEN}\n`) ? 0 : at === -1 ? -1 : at + 2;
  if (start === -1) return null;
  const items: Mentioned[] = [];
  for (const match of message.slice(start).matchAll(LEGACY_HEAD)) {
    items.push({ title: match[1] ?? "", uri: `siyuan://blocks/${match[2] ?? ""}` });
  }
  if (items.length === 0) return null;
  return {
    text: start === 0 ? "" : message.slice(0, start - 2),
    mentions: { source: "siyuan", items },
  };
}
