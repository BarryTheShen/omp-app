import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { SessionFileStore } from "./index";
import { readSessionHeader, summarizeSessionFile } from "./summary";

const DATA = path.resolve(import.meta.dir, "../../../../../../.data");
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function tempRoot(): Promise<string> {
  await mkdir(DATA, { recursive: true });
  const root = await mkdtemp(path.join(DATA, "session-summary-"));
  roots.push(root);
  return root;
}

const header = (id: string, cwd: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "session",
    version: 3,
    id,
    timestamp: "2026-10-04T12:00:00.000Z",
    cwd,
    ...extra,
  });
const message = (role: string, content: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "message",
    id: `m-${Math.random()}`,
    message: { role, content, ...extra },
  });
function titleSlot(title: string): string {
  const line = JSON.stringify({
    type: "title",
    v: 1,
    title,
    source: "user",
    updatedAt: "2026-10-04T12:00:00.000Z",
    pad: "",
  });
  return `${line}${" ".repeat(256 - Buffer.byteLength(line) - 1)}\n`;
}

/** Files that exercise every rule the old whole-file parse had: slot, bad lines, odd records, CRLF, no final newline. */
const FIXTURES: Record<string, string> = {
  plain: `${[
    header("a", "/w"),
    message("user", "Hello  there\n friend"),
    message("assistant", [{ type: "text", text: "hi" }]),
  ].join("\n")}\n`,
  titleSlot:
    titleSlot("A saved title") +
    [
      header("b", "/w"),
      message("user", [
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ]),
    ].join("\n") +
    "\n",
  emptyTitleSlot:
    titleSlot("") +
    [header("c", "/w", { title: "header title" }), message("user", "q")].join("\n") +
    "\n",
  malformed: `${[
    header("d", "/w"),
    "{not json",
    message("user", "q"),
    "",
    message("assistant", "a", { stopReason: "error" }),
  ].join("\n")}\n`,
  partialLast: [
    header("e", "/w"),
    message("user", "q"),
    '{"type":"message","message":{"role":"assis',
  ].join("\n"),
  crlf: `${[
    header("f", "/w"),
    message("user", "windows"),
    message("assistant", [{ type: "toolCall", name: "bash" }]),
  ].join("\r\n")}\r\n`,
  headerNotFirst: `${[message("user", "early"), header("g", "/w"), message("toolResult", "r")].join("\n")}\n`,
  noHeader: `${[message("user", "orphan")].join("\n")}\n`,
  nonObjects: `${[
    header("h", "/w"),
    "42",
    '"text"',
    "[1,2]",
    "null",
    message("assistant", "done", { stopReason: "aborted" }),
  ].join("\n")}\n`,
  longPrompt: `${[header("i", "/w"), message("user", "word ".repeat(100))].join("\n")}\n`,
  otherRoles: `${[header("j", "/w"), message("user", "q"), message("system", "s")].join("\n")}\n`,
  unicode: `${[
    header("k", "/w"),
    message("user", "日本語のテスト ✓ 🎉"),
    message("assistant", "ok"),
  ].join("\n")}\n`,
};

describe("streaming session summary", () => {
  test("gives the same answers as the whole-file read for every kind of file", async () => {
    const root = await tempRoot();
    const sessionsRoot = path.join(root, "sessions");
    await mkdir(path.join(sessionsRoot, "-w"), { recursive: true });
    const store = new SessionFileStore({
      sessionsRoot,
      home: root,
      tempRoot: path.join(root, "tmp"),
    });
    for (const [name, content] of Object.entries(FIXTURES)) {
      const file = path.join(sessionsRoot, "-w", `${name}.jsonl`);
      await writeFile(file, content);
      const whole = await store.readSessionWithWarnings(file);
      const listed = (await store.listSessions()).sessions.find(
        (session) => session.sessionFile === file,
      );
      if (whole.file === undefined) {
        expect(listed, `${name}: no header, so not listed`).toBeUndefined();
        continue;
      }
      expect(listed, `${name}: listed`).toBeDefined();
      const { subagents: _s1, entries: _e1, ...expected } = whole.file;
      const { subagents: _s2, entries: _e2, ...actual } = listed ?? whole.file;
      expect(actual, name).toEqual(expected);
    }
  });

  test("handles a multi-byte character that straddles the 1 MiB read boundary", async () => {
    const root = await tempRoot();
    const file = path.join(root, "big.jsonl");
    // Pad so that a 3-byte character starts one byte before the first chunk ends.
    const filler = "x".repeat(
      (1 << 20) -
        Buffer.byteLength(`${header("big", "/w")}\n`) -
        Buffer.byteLength('{"type":"message","message":{"role":"user","content":"') -
        1,
    );
    const lines = [
      header("big", "/w"),
      `{"type":"message","message":{"role":"user","content":"${filler}日本語"}}`,
      message("assistant", "end"),
    ];
    await writeFile(file, `${lines.join("\n")}\n`);
    const summary = await summarizeSessionFile(file);
    expect(summary.messageCount).toBe(2);
    expect(summary.parseWarnings).toEqual([]);
    expect(summary.firstPrompt?.endsWith("…")).toBe(true);
    expect(summary.status).toBe("complete");
  });

  test("lists by modified time without reading the other files, then remembers what it read", async () => {
    const root = await tempRoot();
    const sessionsRoot = path.join(root, "sessions");
    const bucket = path.join(sessionsRoot, "-w");
    await mkdir(bucket, { recursive: true });
    for (let index = 0; index < 5; index += 1) {
      const file = path.join(bucket, `s${index}.jsonl`);
      await writeFile(
        file,
        `${[header(`s${index}`, "/w"), message("user", `prompt ${index}`)].join("\n")}\n`,
      );
      await utimes(
        file,
        new Date(Date.UTC(2026, 9, 1 + index)),
        new Date(Date.UTC(2026, 9, 1 + index)),
      );
    }
    // A file with garbage would fail to summarize if it were read; it is outside the first page.
    await writeFile(path.join(bucket, "old.jsonl"), "garbage");
    await utimes(
      path.join(bucket, "old.jsonl"),
      new Date(Date.UTC(2026, 8, 1)),
      new Date(Date.UTC(2026, 8, 1)),
    );
    const store = new SessionFileStore({
      sessionsRoot,
      home: root,
      tempRoot: path.join(root, "tmp"),
    });

    const first = await store.listSessions({ limit: 2 });
    expect(first.sessions.map((s) => s.firstPrompt)).toEqual(["prompt 4", "prompt 3"]);
    expect(first.nextCursor).toBe("2");
    expect(first.parseWarnings).toEqual([]);
    const second = await store.listSessions({
      limit: 2,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.sessions.map((s) => s.firstPrompt)).toEqual(["prompt 2", "prompt 1"]);
    const last = await store.listSessions({
      limit: 3,
      cursor: second.nextCursor ?? undefined,
    });
    // The page holds prompt 0 and the headerless file: that one is skipped, and the cursor ends.
    expect(last.sessions.map((s) => s.firstPrompt)).toEqual(["prompt 0"]);
    expect(last.nextCursor).toBeNull();
  });

  test("notices a file that changed since it was remembered", async () => {
    const root = await tempRoot();
    const sessionsRoot = path.join(root, "sessions");
    const bucket = path.join(sessionsRoot, "-w");
    await mkdir(bucket, { recursive: true });
    const file = path.join(bucket, "live.jsonl");
    await writeFile(file, `${[header("live", "/w"), message("user", "q")].join("\n")}\n`);
    const store = new SessionFileStore({
      sessionsRoot,
      home: root,
      tempRoot: path.join(root, "tmp"),
    });
    const before = (await store.listSessions()).sessions[0];
    expect(before?.messageCount).toBe(1);
    expect(before?.status).toBe("pending");
    await appendFile(file, `${message("assistant", "answer")}\n`);
    const after = (await store.listSessions()).sessions[0];
    expect(after?.messageCount).toBe(2);
    expect(after?.status).toBe("complete");
  });

  test("finds each file's folder from its first lines only", async () => {
    const root = await tempRoot();
    const sessionsRoot = path.join(root, "sessions");
    await mkdir(path.join(sessionsRoot, "-a"), { recursive: true });
    await mkdir(path.join(sessionsRoot, "-b"), { recursive: true });
    await writeFile(
      path.join(sessionsRoot, "-a", "one.jsonl"),
      `${header("one", "/a")}\n${message("user", "q")}\n`,
    );
    await writeFile(
      path.join(sessionsRoot, "-a", "two.jsonl"),
      `${titleSlot("t")}${header("two", "/a")}\n`,
    );
    await writeFile(path.join(sessionsRoot, "-b", "three.jsonl"), `${header("three", "/b")}\n`);
    await writeFile(path.join(sessionsRoot, "-b", "bad.jsonl"), "not a session\n");
    const store = new SessionFileStore({
      sessionsRoot,
      home: root,
      tempRoot: path.join(root, "tmp"),
    });
    expect((await store.listFolders()).folders).toEqual(["/a", "/b"]);
    expect((await readSessionHeader(path.join(sessionsRoot, "-a", "two.jsonl")))?.cwd).toBe("/a");
    expect(await readSessionHeader(path.join(sessionsRoot, "-b", "bad.jsonl"))).toBeUndefined();
  });

  test("finds a session by its id from the file name, then from headers, and says so when there is none", async () => {
    const root = await tempRoot();
    const sessionsRoot = path.join(root, "sessions");
    await mkdir(path.join(sessionsRoot, "-a"), { recursive: true });
    // omp names a file "<timestamp>_<id>.jsonl"; the other file's name doesn't carry its id.
    await writeFile(
      path.join(sessionsRoot, "-a", "2026-10-04T12-00-00-000Z_named-id.jsonl"),
      `${header("named-id", "/a")}\n${message("user", "the named one")}\n`,
    );
    await writeFile(
      path.join(sessionsRoot, "-a", "renamed.jsonl"),
      `${titleSlot("t")}${header("hidden-id", "/a")}\n${message("user", "the renamed one")}\n`,
    );
    await writeFile(path.join(sessionsRoot, "-a", "broken.jsonl"), "not a session\n");
    const store = new SessionFileStore({
      sessionsRoot,
      home: root,
      tempRoot: path.join(root, "tmp"),
    });
    expect((await store.findSession("named-id"))?.firstPrompt).toBe("the named one");
    expect((await store.findSession("hidden-id"))?.firstPrompt).toBe("the renamed one");
    expect(await store.findSession("no-such-id")).toBeUndefined();
  });
});
