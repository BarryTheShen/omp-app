import { AppFailure, DumpReport, type DumpScope, HttpsUrl, ShareResult } from "@omp-app/contracts";
import type { CommandParserContext, OmpCommandGatewayService } from "./gateway";
import { registerModeChangeParsers } from "./mode-parsers";

/*
 * Typed parsers for the `/share` and `/dump` replies of omp v18.6.1 (issue #793). Each command prints
 * one `command_output` frame, and each parser accepts only the shape omp prints for it, cited below.
 * A reply that differs is an `internal` failure, never a best-effort guess. `/dump` text is passed
 * through unparsed: the browser shows it, and no parser reads its wording.
 */

/** builtin-collaboration.ts:296-298: the viewer link line, then the optional gist line and note line. */
const SHARE_URL_LINE = "Share URL: ";
const GIST_LINE = "Gist: ";
const TRIMMED_NOTE = "Note: large content was trimmed to fit the share size limit.";

/** builtin-collaboration.ts:302: omp's reply when the upload failed; the text after it is omp's reason. */
const SHARE_FAILED = "Failed to share session: ";

/**
 * builtin-collaboration.ts:248: `/dump all` prints this when the session has no messages. Line 257 prints
 * it for `/dump` only when the formatted session is empty, which its header never is (recorded).
 */
const NO_MESSAGES = "No messages to dump yet.";

/** session-dump-format.ts:79 and :90: a session dump opens with its system prompt, or its configuration. */
const SESSION_DUMP_OPENINGS = ["## System Prompt\n", "## Configuration\n"];

/** session-dump-format.ts:293-298: the `/dump all` report opens with the archive path and ends with the warning. */
const ARCHIVE_OPENING = "Session dump archive: ";
const ARCHIVE_CONTENTS_OPENING = "Contains ";
const ARCHIVE_WARNING =
  "This archive persists on disk and may contain raw context/secrets — treat accordingly.";

/** A reply omp did not print in the expected shape: an app bug, or an omp version the app does not know. */
function unrecognized(command: string): AppFailure {
  return new AppFailure({
    code: "internal",
    message: `The app could not read omp's reply to ${command}.`,
    retryable: false,
  });
}

/** The text of the one output the command printed; any other number of outputs is not its reply. */
function replyText(context: CommandParserContext): string {
  if (context.agentInvoked) {
    throw new AppFailure({
      code: "internal",
      message: `omp sent ${context.command} to the model instead of running it.`,
      retryable: false,
    });
  }
  const [only, ...rest] = context.outputs;
  if (only === undefined || rest.length > 0) throw unrecognized(context.command);
  return only.text;
}

/** The URL after a fixed line prefix; it must be an https URL, as omp's share links are. */
function urlAfter(line: string | undefined, prefix: string, command: string): string {
  if (line === undefined || !line.startsWith(prefix)) throw unrecognized(command);
  const url = line.slice(prefix.length);
  if (!HttpsUrl.safeParse(url).success) throw unrecognized(command);
  return url;
}

/**
 * Reads `/share`: `Share URL: <url>`, then an optional `Gist: <url>`, then an optional trimmed note,
 * in that order and with nothing else (builtin-collaboration.ts:296-298). omp's failed upload (:302) and
 * an http link are typed unavailable failures with plain messages; any other shape is `internal`.
 */
export function parseShareReply(context: CommandParserContext): ShareResult {
  const text = replyText(context);
  if (text.startsWith(SHARE_FAILED)) {
    throw new AppFailure({
      code: "unavailable",
      message: "omp could not share this chat. Try again in a moment.",
      retryable: true,
    });
  }
  if (text.startsWith(`${SHARE_URL_LINE}http://`)) {
    throw new AppFailure({
      code: "unavailable",
      message: "The share server does not use https, so the link can't be shown here.",
      retryable: false,
    });
  }
  const lines = text.split("\n");
  let next = 0;
  const url = urlAfter(lines[next], SHARE_URL_LINE, context.command);
  next += 1;
  let gistUrl: string | undefined;
  if (lines[next]?.startsWith(GIST_LINE) === true) {
    gistUrl = urlAfter(lines[next], GIST_LINE, context.command);
    next += 1;
  }
  let truncated = false;
  if (lines[next] === TRIMMED_NOTE) {
    truncated = true;
    next += 1;
  }
  if (next !== lines.length) throw unrecognized(context.command);
  return ShareResult.parse({ url, ...(gistUrl === undefined ? {} : { gistUrl }), truncated });
}

function scopeOf(command: string): DumpScope | undefined {
  if (command === "/dump") return "session";
  if (command === "/dump all") return "all";
  return undefined;
}

function isArchiveReport(text: string): boolean {
  const lines = text.split("\n");
  return (
    lines[0]?.startsWith(ARCHIVE_OPENING) === true &&
    lines[1]?.startsWith(ARCHIVE_CONTENTS_OPENING) === true &&
    lines[lines.length - 1] === ARCHIVE_WARNING
  );
}

/**
 * Reads `/dump` or `/dump all`: the session dump, the archive report, or omp's message for a session
 * with no messages. The text is omp's own and is returned unchanged.
 */
export function parseDumpReply(context: CommandParserContext): DumpReport {
  const scope = scopeOf(context.command);
  if (scope === undefined) throw unrecognized(context.command);
  const text = replyText(context);
  const empty = text === NO_MESSAGES;
  const shaped =
    empty ||
    (scope === "all"
      ? isArchiveReport(text)
      : SESSION_DUMP_OPENINGS.some((opening) => text.startsWith(opening)));
  if (!shaped) throw unrecognized(context.command);
  return DumpReport.parse({ scope, text, empty });
}

/** Registers the `/share` and `/dump` parsers on a gateway; `createOmpCommandGateway` calls this. */
export function registerOmpCommandParsers(gateway: OmpCommandGatewayService): void {
  gateway.registerCommandParser("share", parseShareReply);
  gateway.registerCommandParser("dump", parseDumpReply);
  registerModeChangeParsers(gateway);
}
