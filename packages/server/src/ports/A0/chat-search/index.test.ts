import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FolderPath, SessionFilePath, ThreadId } from "@omp-app/contracts";
import { createChatIndex, type IndexedChat } from "./index";
import { messageText, OVERLAP_CHARS, PASSAGE_CHARS, passagesOf, windows } from "./passages";
import type { ChatSearchConfig } from "./settings";

const dirs: string[] = [];
const indexes: { stop(): void }[] = [];
afterEach(async () => {
  for (const index of indexes.splice(0)) index.stop();
  await Bun.sleep(5);
  // Windows refuses to remove the index's database while it is still open (EBUSY): retried as its handle closes.
  await Promise.all(
    dirs
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })),
  );
});

const line = (role: string, content: unknown) =>
  `${JSON.stringify({ type: "message", message: { role, content } })}\n`;
const toolResult = (text: string) =>
  `${JSON.stringify({ type: "message", message: { role: "toolResult", content: [{ type: "text", text }] } })}\n`;

describe("what a chat gives the index", () => {
  test("your messages and omp's replies, never tool output, thinking or tool calls", () => {
    expect(messageText(line("user", "how do I rotate the keys?"))).toBe(
      "how do I rotate the keys?",
    );
    expect(
      messageText(
        line("assistant", [
          { type: "thinking", thinking: "private" },
          { type: "text", text: "Run the rotate command." },
          { type: "toolCall", name: "bash", arguments: { command: "ls" } },
        ]),
      ),
    ).toBe("Run the rotate command.");
    expect(messageText(toolResult("a directory listing"))).toBeNull();
    expect(messageText(`${JSON.stringify({ type: "model_change", model: "x" })}\n`)).toBeNull();
    expect(messageText("{ half a line")).toBeNull();
  });

  test("short messages merge into passages; a long one is cut with an overlap, so no words are lost", () => {
    const { passages, tail } = passagesOf("", ["ok", "thanks"]);
    expect(passages).toEqual([]);
    expect(tail).toBe("ok\n\nthanks");
    const long = Array.from({ length: 900 }, (_, n) => `w${n}`).join(" ");
    const cut = windows(long);
    expect(cut.length).toBeGreaterThan(1);
    for (const piece of cut) expect(piece.length).toBeLessThanOrEqual(PASSAGE_CHARS);
    for (const word of long.split(" "))
      expect(cut.some((piece) => piece.split(" ").includes(word))).toBe(true);
    // Each window starts inside the last OVERLAP_CHARS (and a word) of the one before it.
    for (let n = 1; n < cut.length; n++) {
      const before = cut[n - 1] as string;
      const start = (cut[n] as string).split(" ")[0] as string;
      expect(before.slice(-(OVERLAP_CHARS + 10)).split(" ")).toContain(start);
    }
  });
});

/**
 * A stand-in for the model: word counts over a fixed vocabulary, and one more count for every other word, so texts are
 * "close" when they share those words and texts without them point elsewhere.
 */
const VOCABULARY = [
  "keys",
  "rotate",
  "garden",
  "tomatoes",
  "water",
  "release",
  "build",
  "query",
  "omp",
];
function standIn() {
  const calls: string[][] = [];
  const embed = async (_service: unknown, texts: readonly string[]) => {
    calls.push([...texts]);
    return texts.map((text) => {
      const words = text
        .toLowerCase()
        .replace(/^instruct:.*\nquery: /s, "")
        .split(/\W+/)
        .filter(Boolean);
      const counts = VOCABULARY.map((word) => words.filter((w) => w === word).length);
      return Float32Array.from([...counts, words.filter((w) => !VOCABULARY.includes(w)).length]);
    });
  };
  return { embed, calls };
}

const CONFIG: ChatSearchConfig = {
  enabled: true,
  address: "http://embed.test/v1",
  model: "m1",
  key: null,
};

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "chat-index-"));
  dirs.push(dir);
  const chats: IndexedChat[] = [];
  const add = async (name: string, title: string, text: string) => {
    const file = join(dir, `${name}.jsonl`);
    await writeFile(file, `${JSON.stringify({ type: "session", id: name })}\n${text}`);
    chats.push({
      threadId: name as ThreadId,
      sessionFile: file as SessionFilePath,
      title,
      folder: "/work" as FolderPath,
      sizeBytes: (await stat(file)).size,
    });
    return file;
  };
  const resize = async (file: string) => {
    const chat = chats.find((each) => each.sessionFile === file) as IndexedChat;
    chats[chats.indexOf(chat)] = { ...chat, sizeBytes: (await stat(file)).size };
  };
  let config = CONFIG;
  const stand = standIn();
  const open = () => {
    const index = createChatIndex({
      path: join(dir, "chat-index.sqlite"),
      chats: async () => chats,
      config: async () => config,
      changed: () => {},
      embed: stand.embed as never,
    });
    indexes.push(index);
    return index;
  };
  return {
    dir,
    chats,
    add,
    resize,
    open,
    stand,
    setConfig: (next: ChatSearchConfig) => (config = next),
  };
}

describe("the index", () => {
  test("finds the chat that talks about it, best first, and never by its tool output", async () => {
    const { add, open } = await setup();
    await add("garden", "Spring planting", line("user", "water tomatoes in garden?"));
    await add(
      "keys",
      "Secrets",
      line("user", "how do I rotate the keys?") + line("assistant", "Rotate the keys monthly."),
    );
    await add(
      "tools",
      "Logs",
      line("user", "hello") + toolResult("garden garden tomatoes water water"),
    );
    const index = open();
    await index.runOnce();
    expect(index.status()).toEqual({ chats: 3, indexed: 3, indexing: false, problem: null });
    const found = await index.search(CONFIG, "water tomatoes", 10);
    expect(found[0]).toMatchObject({
      threadId: "garden",
      title: "Spring planting",
      folder: "/work",
    });
    expect(found[0]?.passage).toContain("tomatoes");
    expect(found.map((match) => match.threadId)).not.toContain("tools");
  });

  test("a chat kept twice shows once; one only near the best match is left out", async () => {
    const { add, open } = await setup();
    await add("garden", "Spring planting", line("user", "water tomatoes garden"));
    await add("garden-copy", "Spring planting", line("user", "water tomatoes garden"));
    // Shares two of the three: about 0.58, over the floor but far below the best (1.0).
    await add("near", "Builds", line("user", "water garden release build"));
    const index = open();
    await index.runOnce();
    const found = await index.search(CONFIG, "water tomatoes garden", 10);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ title: "Spring planting", score: 1 });
  });

  test("a chat that grew is read only from where it was left; one that did not is not read again", async () => {
    const { add, resize, open, stand } = await setup();
    const file = await add("keys", "Secrets", line("user", "rotate the keys"));
    const index = open();
    await index.runOnce();
    const first = stand.calls.flat().length;
    await index.runOnce();
    expect(stand.calls.flat().length).toBe(first);
    await appendFile(file, line("assistant", "and the release build"));
    await resize(file);
    await index.runOnce();
    // Only the tail is embedded again, now holding both messages; the title is not.
    expect(stand.calls.at(-1)).toEqual(["rotate the keys\n\nand the release build"]);
    expect(String((await index.search(CONFIG, "rotate keys release build", 5))[0]?.threadId)).toBe(
      "keys",
    );
  });

  test("it is kept across restarts; a removed chat leaves it; another model starts it anew", async () => {
    const { add, chats, open, stand, setConfig } = await setup();
    await add("keys", "Secrets", line("user", "rotate the keys"));
    await add("garden", "Garden", line("user", "water the tomatoes"));
    const first = open();
    await first.runOnce();
    first.stop();
    await Bun.sleep(5);
    const again = open();
    expect(String((await again.search(CONFIG, "rotate keys", 5))[0]?.threadId)).toBe("keys");
    chats.splice(0, 1);
    const before = stand.calls.length;
    await again.runOnce();
    expect(stand.calls.length).toBe(before);
    expect(
      (await again.search(CONFIG, "rotate keys", 5)).map((match) => match.threadId),
    ).not.toContain("keys");
    setConfig({ ...CONFIG, model: "m2" });
    await again.runOnce();
    expect(stand.calls.at(-1)).toEqual(["Garden", "water the tomatoes"]);
  });

  test("off, nothing is read; a failing service is shown as the index's problem", async () => {
    const { add, open, setConfig, stand } = await setup();
    await add("keys", "Secrets", line("user", "rotate the keys"));
    setConfig({ ...CONFIG, enabled: false });
    const index = open();
    await index.runOnce();
    expect(stand.calls).toEqual([]);
    const failing = createChatIndex({
      path: join(dirs[0] as string, "other.sqlite"),
      chats: async () => [],
      config: async () => CONFIG,
      changed: () => {},
      embed: (async () => {
        throw new Error("the embedding service answered 503");
      }) as never,
    });
    indexes.push(failing);
    await failing.runOnce();
    expect(failing.status().problem).toBeNull();
    const broken = createChatIndex({
      path: join(dirs[0] as string, "broken.sqlite"),
      chats: async () => {
        throw new Error("the embedding service answered 503");
      },
      config: async () => CONFIG,
      changed: () => {},
    });
    indexes.push(broken);
    await expect(broken.runOnce()).rejects.toThrow("503");
    expect(broken.status().problem).toBe("the embedding service answered 503");
  });
});
