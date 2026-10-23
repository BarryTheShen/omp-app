import { describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, open, rm, stat } from "node:fs/promises";
import * as path from "node:path";
import { SessionFileStore } from "./store";
import { summarizeSessionFile } from "./summary";

/*
 * SU1's cost bound. A chat that is being written is a large file that grows at its end. Its first row folds the whole chat
 * once; after that a row costs what the appended lines cost, not what the chat does. The rows are read through
 * `readSessionRow`, the read the sidebar makes for a chat it was told changed. The chat holds one 40 MB line, the size of
 * the largest tool result in a real store (summary.ts): a whole read parses it, and a resumed read must not.
 */

const DATA = path.resolve(import.meta.dir, "../../../../../../.data");
const MiB = 1024 * 1024;
const CHAT_BYTES = 445 * MiB;
const BIG_LINE_BYTES = 40 * MiB;
/** The text of one message in the generated chat: about 16 KiB, the order of a real tool result or reply. */
const RECORD_TEXT_BYTES = 16 * 1024;
/** The text of each of the two messages a round appends: about 10 KB of new lines in all. */
const GROWTH_TEXT_BYTES = 5 * 1024;
const ROUNDS = 10;
/** The bound on one row after the first (the plan's SU1 "Done when"). */
const ROW_BUDGET_MS = 30;

const at = (minute: number): string =>
  `2026-10-01T10:${String(minute % 60).padStart(2, "0")}:00.000Z`;

/** One message line, as omp writes a user or an assistant turn. */
function messageLine(id: string, role: "user" | "assistant", text: string, minute: number): string {
  const message =
    role === "user"
      ? { role, content: text }
      : { role, stopReason: "stop", content: [{ type: "text", text }] };
  return `${JSON.stringify({ type: "message", id, timestamp: at(minute), message })}\n`;
}

/** The two messages one round appends. */
function growth(round: number): string {
  const text = "g".repeat(GROWTH_TEXT_BYTES);
  return (
    messageLine(`grow-${round}-user`, "user", text, round) +
    messageLine(`grow-${round}-assistant`, "assistant", text, round)
  );
}

/**
 * Writes a chat of about CHAT_BYTES: a header, message lines in whole blocks, the one 40 MB line about halfway, and a last
 * block cut at a line's end, so that the chat ends on a complete line.
 */
async function writeBigChat(file: string, cwd: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const header = `${JSON.stringify({ type: "session", version: 3, id: "big-chat", timestamp: at(0), cwd })}\n`;
  const text = "b".repeat(RECORD_TEXT_BYTES);
  const records = Array.from({ length: 512 }, (_, index) =>
    messageLine(`r${index}`, index % 2 === 0 ? "user" : "assistant", text, index),
  ).join("");
  const block = Buffer.from(records, "utf8");
  const big = Buffer.from(
    messageLine("big-output", "assistant", "t".repeat(BIG_LINE_BYTES), 1),
    "utf8",
  );
  const handle = await open(file, "w");
  try {
    let written = Buffer.byteLength(header);
    await handle.write(header);
    const writeBlocks = async (limit: number): Promise<void> => {
      while (written + block.length <= limit) {
        await handle.write(block);
        written += block.length;
      }
    };
    await writeBlocks(Math.floor((CHAT_BYTES - big.length) / 2));
    await handle.write(big);
    written += big.length;
    await writeBlocks(CHAT_BYTES);
    const rest = CHAT_BYTES - written;
    const cut = rest > 0 ? block.lastIndexOf(0x0a, rest - 1) + 1 : 0;
    if (cut > 0) await handle.write(block, 0, cut);
  } finally {
    await handle.close();
  }
}

describe("SU1 cost of a row for a chat that grows", () => {
  test("a 445 MB chat that grows by 10 KB costs at most 30 ms per readSessionRow after the first call", async () => {
    await mkdir(DATA, { recursive: true });
    const root = await mkdtemp(path.join(DATA, "summary-cost-"));
    const home = path.join(root, "home");
    const cwd = path.join(home, "project");
    const store = new SessionFileStore({
      sessionsRoot: path.join(root, "sessions"),
      home,
      tempRoot: path.join(root, "tmp"),
      appDataDir: path.join(root, "app"),
    });
    try {
      const chat = path.join(store.bucketPath(cwd), "2026-10-01_big.jsonl");
      await writeBigChat(chat, cwd);
      expect((await stat(chat)).size).toBeGreaterThan(CHAT_BYTES - 2 * RECORD_TEXT_BYTES);

      const cold = await store.readSessionRow({ sessionFile: chat });
      let messages = cold.messageCount;
      const rowMs: number[] = [];
      for (let round = 0; round < ROUNDS; round += 1) {
        await appendFile(chat, growth(round));
        messages += 2;
        const started = performance.now();
        const row = await store.readSessionRow({ sessionFile: chat });
        rowMs.push(performance.now() - started);
        expect(row.messageCount).toBe(messages);
      }
      const truth = await summarizeSessionFile(chat);
      expect(truth.messageCount).toBe(messages);
      expect(Math.max(...rowMs)).toBeLessThanOrEqual(ROW_BUDGET_MS);
    } finally {
      await store.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 900_000);
});
