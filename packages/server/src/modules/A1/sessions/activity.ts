import { open } from "node:fs/promises";

/*
 * When a chat was last active. A listing orders chats by the time of their newest conversation message, and a chat's
 * update time is that message's time. The message is read from the end of the file: the first window is 16 KiB, and
 * each step doubles it until a message turns up or the window reaches TAIL_CAP_BYTES. A rename or any other
 * bookkeeping record (a session name, a note) is not a conversation message, so it does not move a chat. A chat with no
 * message within the cap is listed at its header's time, and a chat with no header at its file's modified time.
 */

/** The first window read from the end of a file; each step doubles it. */
const TAIL_FIRST_BYTES = 16 * 1024;
/** The furthest back from a file's end a message is looked for: past it the header's time is used instead. */
export const TAIL_CAP_BYTES = 4 * 1024 * 1024;
/** Bytes read from the start of a file to find its header. */
const HEAD_BYTES = 64 * 1024;
/** Lines searched from the start for the header: a title slot line may come before it. */
const HEADER_SEARCH_LINES = 4;

/** The timestamp of a conversation message record, or undefined for any other line. */
function messageTimestamp(line: string | undefined): string | undefined {
  if (line === undefined || !/"type"\s*:\s*"message"/.test(line)) return undefined;
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    // A line cut at the start of the window, or a partial last line: it is not a message here.
    return undefined;
  }
  if (typeof record !== "object" || record === null) return undefined;
  const { type, timestamp } = record as { readonly type?: unknown; readonly timestamp?: unknown };
  return type === "message" && typeof timestamp === "string" ? timestamp : undefined;
}

/**
 * The timestamp of the newest conversation message in a file, read from its end within TAIL_CAP_BYTES. Undefined when
 * no message within that reach has a timestamp.
 */
export async function lastMessageTimestamp(file: string): Promise<string | undefined> {
  const handle = await open(file, "r");
  try {
    const { size } = await handle.stat();
    let window = TAIL_FIRST_BYTES;
    for (;;) {
      const start = Math.max(0, size - window);
      const buffer = Buffer.alloc(size - start);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const timestamp = messageTimestamp(lines[index]);
        if (timestamp !== undefined) return timestamp;
      }
      if (start === 0 || window >= TAIL_CAP_BYTES) return undefined;
      window = Math.min(window * 2, TAIL_CAP_BYTES);
    }
  } finally {
    await handle.close();
  }
}

/** The session header's timestamp, read from the first lines of a file. Undefined when there is no header to read. */
export async function headerTimestamp(file: string): Promise<string | undefined> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
    for (const line of lines.slice(0, HEADER_SEARCH_LINES)) {
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof record !== "object" || record === null) continue;
      const { type, timestamp } = record as {
        readonly type?: unknown;
        readonly timestamp?: unknown;
      };
      if (type === "session") return typeof timestamp === "string" ? timestamp : undefined;
    }
    return undefined;
  } finally {
    await handle.close();
  }
}
