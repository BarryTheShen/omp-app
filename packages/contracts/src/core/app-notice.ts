/**
 * A message that something other than the person put into a chat: a watcher's notice, a scheduled wake-up, a script's
 * test. The whole message is one block naming where it came from, so omp reads it as not the person's words and the
 * transcript shows it as a notice, never as the person's message (`splitAppNotice`). Writers use `withAppNotice`; the
 * text is written with `&`, `<` and `>` as entities, so it can never close the block early.
 */

/** Where a notice came from: `issue-watch`, `wake` and so on (lowercase letters, digits and dashes). */
export const APP_NOTICE_SOURCE_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
/** The most text a notice carries: room for the answers to many questions, each with a written answer and a note. */
export const APP_NOTICE_TEXT_MAX = 200_000;

export interface AppNotice {
  readonly source: string;
  readonly text: string;
}

const TAG = "app-notice";
const OPEN = `<${TAG} source="`;
const CLOSE = `</${TAG}>`;

const toEntities = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const fromEntities = (value: string): string =>
  value.replaceAll("&gt;", ">").replaceAll("&lt;", "<").replaceAll("&amp;", "&");

/** The message a notice is sent as: the block, and nothing else. */
export function withAppNotice(source: string, text: string): string {
  if (!APP_NOTICE_SOURCE_PATTERN.test(source)) throw new Error(`Not a notice source: "${source}"`);
  const body = text.trim();
  if (body === "" || body.length > APP_NOTICE_TEXT_MAX)
    throw new Error(`A notice needs 1 to ${APP_NOTICE_TEXT_MAX} characters`);
  return `${OPEN}${source}">\n${toEntities(body)}\n${CLOSE}`;
}

/** The notice a message is, or null when it is anything else (the person's own words among them). */
export function splitAppNotice(message: string): AppNotice | null {
  if (!message.startsWith(OPEN) || !message.endsWith(`\n${CLOSE}`)) return null;
  const quote = message.indexOf('">\n', OPEN.length);
  if (quote === -1) return null;
  const source = message.slice(OPEN.length, quote);
  const body = message.slice(quote + 3, message.length - CLOSE.length - 1);
  if (!APP_NOTICE_SOURCE_PATTERN.test(source) || body.includes("<") || body.trim() === "")
    return null;
  return { source, text: fromEntities(body) };
}
