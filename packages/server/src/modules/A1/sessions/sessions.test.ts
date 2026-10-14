import { describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import * as path from "node:path";
import {
  parseSessionContent,
  parseTitleSlotLine,
  SessionFileStore,
  sessionBucketName,
} from "./index";

const WORKTREE_DATA = path.resolve(import.meta.dir, "../../../../../../.data");

async function makeTempRoot(): Promise<string> {
  await mkdir(WORKTREE_DATA, { recursive: true });
  return mkdtemp(path.join(WORKTREE_DATA, "session-store-"));
}

async function writeSession(
  sessionFile: string,
  options: {
    id: string;
    cwd: string;
    timestamp: string;
    title?: string;
    parentSession?: string;
    slotTitle?: string;
    records?: readonly Record<string, unknown>[];
    trailingPartial?: string;
  },
): Promise<void> {
  const header: Record<string, unknown> = {
    type: "session",
    version: 3,
    id: options.id,
    timestamp: options.timestamp,
    cwd: options.cwd,
  };
  if (options.title !== undefined) header.title = options.title;
  if (options.parentSession !== undefined) header.parentSession = options.parentSession;
  const slot =
    options.slotTitle === undefined
      ? ""
      : (() => {
          const line = JSON.stringify({
            type: "title",
            v: 1,
            title: options.slotTitle,
            source: "user",
            updatedAt: options.timestamp,
            pad: "",
          });
          return `${line}${" ".repeat(256 - Buffer.byteLength(line) - 1)}\n`;
        })();
  const records = (options.records ?? []).map((record) => JSON.stringify(record)).join("\n");
  const body = [JSON.stringify(header), records, options.trailingPartial ?? ""]
    .filter(Boolean)
    .join("\n");
  await mkdir(path.dirname(sessionFile), { recursive: true });
  await writeFile(sessionFile, `${slot}${body}\n`, "utf8");
}

async function removeRoot(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}

describe("omp session bucket rule", () => {
  test("classifies home, temp and outside-home paths exactly", async () => {
    const root = await makeTempRoot();
    try {
      const home = path.join(root, "home");
      const tempRoot = path.join(home, "tmp");
      const outside = path.join(root, "outside");
      await mkdir(path.join(tempRoot, "nested"), { recursive: true });
      await mkdir(path.join(home, "workspace"), { recursive: true });
      await mkdir(outside, { recursive: true });

      expect(sessionBucketName(home, { home, tempRoot })).toBe("-");
      expect(sessionBucketName(path.join(home, "workspace"), { home, tempRoot })).toBe(
        "-workspace",
      );
      expect(sessionBucketName(tempRoot, { home, tempRoot })).toBe("-tmp");
      expect(sessionBucketName(path.join(tempRoot, "nested"), { home, tempRoot })).toBe(
        "-tmp-nested",
      );
      const encodedOutside = outside.replace(/^[/\\]/, "").replace(/[\\/:]/g, "-");
      expect(sessionBucketName(outside, { home, tempRoot })).toBe(`--${encodedOutside}--`);
    } finally {
      await removeRoot(root);
    }
  });

  test("canonicalizes an existing symlink before bucket classification", async () => {
    const root = await makeTempRoot();
    try {
      const home = path.join(root, "home");
      const project = path.join(home, "project");
      const alias = path.join(root, "alias");
      await mkdir(project, { recursive: true });
      await symlink(project, alias);
      expect(sessionBucketName(alias, { home, tempRoot: path.join(root, "tmp") })).toBe("-project");
    } finally {
      await removeRoot(root);
    }
  });
});

describe("tolerant session parsing", () => {
  test("folds the physical title slot over a v3 header and accepts unknown records", () => {
    const header = {
      type: "session",
      version: 3,
      id: "session-1",
      timestamp: "2026-10-04T12:00:00.000Z",
      cwd: "/workspace/project",
      title: "header title",
      parentSession: "parent-1",
    };
    const slot = JSON.stringify({
      type: "title",
      v: 1,
      title: "physical title",
      source: "user",
      updatedAt: header.timestamp,
      pad: " ".repeat(200),
    });
    const parsed = parseSessionContent(
      `${slot}\n${JSON.stringify(header)}\n${JSON.stringify({ type: "future_entry", id: "future" })}\n`,
    );
    expect(parsed.header?.version).toBe(3);
    expect(parsed.header?.title).toBe("physical title");
    expect(parsed.header?.parentSession).toBe("parent-1");
    expect(parsed.unknownEntryTypes).toEqual(["future_entry"]);
    expect(parsed.parseWarnings).toHaveLength(0);
    expect(parseTitleSlotLine(slot)?.title).toBe("physical title");
  });

  test("reports an incomplete final line while retaining the valid listing records", () => {
    const parsed = parseSessionContent(
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "partial-1",
        timestamp: "2026-10-04T12:00:00.000Z",
        cwd: "/workspace/project",
      })}\n{"type":"message","id":"m1"}\n{"type":"message"`,
      "/sessions/partial.jsonl",
    );
    expect(parsed.header?.id).toBe("partial-1");
    expect(parsed.partialLine).toBe(true);
    expect(parsed.malformedRecords).toBe(1);
    expect(parsed.parseWarnings[0]?.code).toBe("malformed_line");
    expect(parsed.parseWarnings[0]?.partial).toBe(true);
  });
});

describe("SessionFileStore", () => {
  test("lists newest files with title, v3 metadata, parent and malformed warnings", async () => {
    const root = await makeTempRoot();
    try {
      const home = path.join(root, "home");
      const sessionsRoot = path.join(root, "sessions");
      const cwd = path.join(home, "project");
      const bucket = path.join(sessionsRoot, "-project");
      await mkdir(cwd, { recursive: true });
      const older = path.join(bucket, "2026-10-04_older.jsonl");
      const newer = path.join(bucket, "2026-10-04_newer.jsonl");
      await writeSession(older, {
        id: "older",
        cwd,
        timestamp: "2026-10-04T10:00:00.000Z",
        slotTitle: "Older physical title",
        records: [
          {
            type: "message",
            id: "long-user-entry",
            message: {
              role: "user",
              content: [
                { type: "text", text: `Explain\n  this   ${"very ".repeat(40)}long question` },
                { type: "image", data: "..." },
              ],
            },
          },
        ],
      });
      await writeSession(newer, {
        id: "newer",
        cwd,
        timestamp: "2026-10-04T11:00:00.000Z",
        title: "Header title should lose",
        slotTitle: "Newest physical title",
        parentSession: "older",
        records: [
          { type: "message", id: "user-entry", message: { role: "user", content: "hello" } },
          {
            type: "message",
            id: "assistant-entry",
            message: { role: "assistant", stopReason: "stop", content: "done" },
          },
        ],
        trailingPartial: '{"type":"message"',
      });
      await utimes(
        older,
        new Date("2026-10-04T10:00:00.000Z"),
        new Date("2026-10-04T10:00:00.000Z"),
      );
      await utimes(
        newer,
        new Date("2026-10-04T11:00:00.000Z"),
        new Date("2026-10-04T11:00:00.000Z"),
      );

      const store = new SessionFileStore({ sessionsRoot, home, tempRoot: path.join(root, "tmp") });
      const result = await store.listSessions({ folder: cwd });
      expect(result.sessions.map((session) => session.id)).toEqual(["newer", "older"]);
      expect(result.sessions[0]?.title).toBe("Newest physical title");
      expect(result.sessions[0]?.version).toBe(3);
      expect(result.sessions[0]?.cwd).toBe(cwd);
      expect(result.sessions[0]?.parentSession).toBe("older");
      expect(result.sessions[0]?.createdAt).toBe("2026-10-04T11:00:00.000Z");
      expect(result.sessions[0]?.messageCount).toBe(2);
      expect(result.sessions[0]?.assistantTurns).toBe(1);
      // The first user message, one line: what the sidebar shows until omp titles the session.
      expect(result.sessions[0]?.firstPrompt).toBe("hello");
      const longPrompt = result.sessions[1]?.firstPrompt ?? "";
      expect(longPrompt.startsWith("Explain this very very")).toBe(true);
      expect(longPrompt).toHaveLength(120);
      expect(longPrompt.endsWith("…")).toBe(true);
      expect(result.sessions[0]?.status).toBe("complete");
      expect(
        result.sessions[0]?.parseWarnings.some((warning) => warning.code === "malformed_line"),
      ).toBe(true);
      expect((await store.listFolders()).folders).toEqual([cwd]);
      expect(result.parseWarnings.some((warning) => warning.sessionFile === newer)).toBe(true);
    } finally {
      await removeRoot(root);
    }
  });

  test("discovers nested subagents, tombstones and nested children but excludes advisors", async () => {
    const root = await makeTempRoot();
    try {
      const sessionsRoot = path.join(root, "sessions");
      const cwd = path.join(root, "workspace");
      const sessionFile = path.join(sessionsRoot, "-workspace", "main.jsonl");
      await writeSession(sessionFile, {
        id: "main",
        cwd,
        timestamp: "2026-10-04T12:00:00.000Z",
      });
      await writeSession(path.join(sessionsRoot, "-workspace", "main", "ToolAsk.jsonl"), {
        id: "child",
        cwd,
        timestamp: "2026-10-04T12:01:00.000Z",
        records: [
          {
            type: "message",
            id: "child-entry",
            parentId: null,
            timestamp: "2026-10-04T12:01:01.000Z",
          },
        ],
      });
      await writeFile(
        path.join(sessionsRoot, "-workspace", "main", "ToolAsk.jsonl.tombstone"),
        "",
        "utf8",
      );
      await writeSession(path.join(sessionsRoot, "-workspace", "main", "__advisor.jsonl"), {
        id: "advisor",
        cwd,
        timestamp: "2026-10-04T12:02:00.000Z",
      });
      await writeSession(path.join(sessionsRoot, "-workspace", "main", "ToolAsk", "Helper.jsonl"), {
        id: "grandchild",
        cwd,
        timestamp: "2026-10-04T12:03:00.000Z",
      });

      const store = new SessionFileStore({
        sessionsRoot,
        home: root,
        tempRoot: path.join(root, "tmp"),
      });
      const listing = await store.readSession(sessionFile);
      expect(listing?.subagents.map((agent) => agent.key)).toEqual(["ToolAsk", "ToolAsk/Helper"]);
      expect(listing?.subagents[0]?.aborted).toBe(true);
      expect(listing?.subagents.some((agent) => agent.key.includes("advisor"))).toBe(false);
      const subagents = await store.listSubagents(sessionFile);
      expect(subagents.sessionFile).toBe(path.resolve(sessionFile));
      expect(subagents.transcripts.map((agent) => agent.key)).toEqual([
        "ToolAsk",
        "ToolAsk/Helper",
      ]);
    } finally {
      await removeRoot(root);
    }
  });

  test("surfaces a malformed file without dropping neighboring valid sessions", async () => {
    const root = await makeTempRoot();
    try {
      const sessionsRoot = path.join(root, "sessions");
      const bucket = path.join(sessionsRoot, "-workspace");
      const valid = path.join(bucket, "valid.jsonl");
      const malformed = path.join(bucket, "malformed.jsonl");
      await writeSession(valid, {
        id: "valid",
        cwd: path.join(root, "workspace"),
        timestamp: "2026-10-04T12:00:00.000Z",
      });
      await writeFile(malformed, '{"type":"session"\n{"type":"message"\n', "utf8");
      const result = await new SessionFileStore({
        sessionsRoot,
        home: root,
        tempRoot: path.join(root, "tmp"),
      }).listSessions();
      expect(result.sessions.map((session) => session.id)).toEqual(["valid"]);
      expect(result.parseWarnings.some((warning) => warning.sessionFile === malformed)).toBe(true);
      await expect(
        new SessionFileStore({
          sessionsRoot,
          home: root,
          tempRoot: path.join(root, "tmp"),
        }).readSession(path.join(bucket, "missing.jsonl")),
      ).rejects.toMatchObject({ appError: { code: "not_found" } });
    } finally {
      await removeRoot(root);
    }
  });

  test("uses the lease bridge when available and reports local ownership separately", async () => {
    const root = await makeTempRoot();
    try {
      const sessionsRoot = path.join(root, "sessions");
      const cwd = path.join(root, "workspace");
      const active = path.join(sessionsRoot, "-workspace", "active.jsonl");
      const local = path.join(sessionsRoot, "-workspace", "local.jsonl");
      await writeSession(active, { id: "active", cwd, timestamp: "2026-10-04T12:00:00.000Z" });
      await writeSession(local, { id: "local", cwd, timestamp: "2026-10-04T12:00:01.000Z" });
      const store = new SessionFileStore({
        sessionsRoot,
        home: root,
        tempRoot: path.join(root, "tmp"),
        leaseProbe: (sessionId) => (sessionId === "active" ? null : () => {}),
        serverSessionIds: new Set(["local"]),
      });
      const result = await store.listSessions({ folder: cwd });
      expect(result.sessions.find((session) => session.id === "active")?.liveness.lease).toBe(
        "held",
      );
      expect(
        result.sessions.find((session) => session.id === "local")?.liveness.serverProcess,
      ).toBe(true);
      expect(result.sessions.find((session) => session.id === "local")?.liveness.lease).toBe(
        "held",
      );
    } finally {
      await removeRoot(root);
    }
  });

  test("reports a chat's turn state only when this server runs omp for it", async () => {
    const root = await makeTempRoot();
    try {
      const sessionsRoot = path.join(root, "sessions");
      const cwd = path.join(root, "workspace");
      const busy = path.join(sessionsRoot, "-workspace", "busy.jsonl");
      const idle = path.join(sessionsRoot, "-workspace", "idle.jsonl");
      const elsewhere = path.join(sessionsRoot, "-workspace", "elsewhere.jsonl");
      await writeSession(busy, { id: "busy", cwd, timestamp: "2026-10-04T12:00:00.000Z" });
      await writeSession(idle, { id: "idle", cwd, timestamp: "2026-10-04T12:00:01.000Z" });
      await writeSession(elsewhere, {
        id: "elsewhere",
        cwd,
        timestamp: "2026-10-04T12:00:02.000Z",
      });
      const turns = new Map<string, "running" | "idle">([
        ["busy", "running"],
        ["idle", "idle"],
      ]);
      const store = new SessionFileStore({
        sessionsRoot,
        home: root,
        tempRoot: path.join(root, "tmp"),
        turnOf: (sessionId) => turns.get(sessionId),
      });
      const result = await store.listSessions({ folder: cwd });
      const turnOf = (id: string) => result.sessions.find((session) => session.id === id)?.turn;
      expect(turnOf("busy")).toBe("running");
      expect(turnOf("idle")).toBe("idle");
      // A chat this server runs no omp for has no turn state at all: it is not reported as idle.
      expect(turnOf("elsewhere")).toBeUndefined();
      expect("turn" in (result.sessions.find((session) => session.id === "elsewhere") ?? {})).toBe(
        false,
      );
    } finally {
      await removeRoot(root);
    }
  });

  test("lists the chats this server runs a turn for that have no session file yet, on a folder's first page", async () => {
    const root = await makeTempRoot();
    try {
      const sessionsRoot = path.join(root, "sessions");
      const cwd = path.join(root, "workspace");
      const other = path.join(root, "other");
      await writeSession(
        path.join(sessionsRoot, "-workspace", "2026-10-04T12-00-00.000Z_saved.jsonl"),
        {
          id: "saved",
          cwd,
          timestamp: "2026-10-04T12:00:00.000Z",
        },
      );
      await writeSession(
        path.join(sessionsRoot, "-workspace", "2026-10-04T11-00-00.000Z_older.jsonl"),
        {
          id: "older",
          cwd,
          timestamp: "2026-10-04T11:00:00.000Z",
        },
      );
      const store = new SessionFileStore({
        sessionsRoot,
        home: root,
        tempRoot: path.join(root, "tmp"),
        turnOf: (sessionId) => (sessionId === "saved" ? "running" : undefined),
        runningIn: (folder) =>
          folder === cwd ? ["saved", "first-reply"] : folder === other ? ["elsewhere"] : [],
      });
      const first = await store.listSessions({ folder: cwd, limit: 1 });
      expect(first.running).toEqual(["first-reply"]);
      expect(first.nextCursor).not.toBeNull();
      // A later page does not repeat the running chats. Both pages together list the two files, the chat with a file
      // with its turn: only the chat with no file is reported as running.
      const second = await store.listSessions({
        folder: cwd,
        limit: 1,
        cursor: first.nextCursor ?? undefined,
      });
      expect(second.running).toEqual([]);
      const listed = [...first.sessions, ...second.sessions];
      expect(listed.map((session) => session.id).sort()).toEqual(["older", "saved"]);
      expect(listed.find((session) => session.id === "saved")?.turn).toBe("running");
      // Another folder reports its own running chats.
      expect((await store.listSessions({ folder: other })).running).toEqual(["elsewhere"]);
    } finally {
      await removeRoot(root);
    }
  });

  /** A conversation message written at `timestamp`, as omp writes one. */
  function messageRecord(id: string, timestamp: string, text: string): Record<string, unknown> {
    return {
      type: "message",
      id,
      parentId: null,
      timestamp,
      message: { role: "user", content: [{ type: "text", text }] },
    };
  }

  test("a rename keeps a chat's place in the list, and a new message moves the chat to the top", async () => {
    const root = await makeTempRoot();
    try {
      const home = path.join(root, "home");
      const sessionsRoot = path.join(root, "sessions");
      const cwd = path.join(home, "project");
      const bucket = path.join(sessionsRoot, "-project");
      await mkdir(cwd, { recursive: true });
      const chats = [
        { id: "a", at: "2026-10-01T10:00:00.000Z" },
        { id: "b", at: "2026-10-02T10:00:00.000Z" },
        { id: "c", at: "2026-10-03T10:00:00.000Z" },
      ];
      const fileOf = (id: string) => path.join(bucket, `2026-10-01_${id}.jsonl`);
      for (const chat of chats) {
        await writeSession(fileOf(chat.id), {
          id: chat.id,
          cwd,
          timestamp: chat.at,
          records: [messageRecord(`m-${chat.id}`, chat.at, `hello ${chat.id}`)],
        });
        await utimes(fileOf(chat.id), new Date(chat.at), new Date(chat.at));
      }
      const store = new SessionFileStore({ sessionsRoot, home, tempRoot: path.join(root, "tmp") });
      const order = async (): Promise<string[]> =>
        (await store.listSessions({ folder: cwd })).sessions.map((session) => session.id);
      expect(await order()).toEqual(["c", "b", "a"]);

      // A rename writes a record that is not a message: the chat keeps its place and its update time.
      await appendFile(
        fileOf("a"),
        `${JSON.stringify({ type: "session_info", id: "rename", parentId: null, timestamp: "2026-10-05T09:00:00.000Z", name: "Renamed" })}\n`,
      );
      const renamed = await store.listSessions({ folder: cwd });
      expect(renamed.sessions.map((session) => session.id)).toEqual(["c", "b", "a"]);
      expect(renamed.sessions.at(-1)?.updatedAt).toBe(chats[0]?.at);

      // A new message is activity: the chat moves to the top.
      await appendFile(
        fileOf("a"),
        `${JSON.stringify(messageRecord("m-a-2", "2026-10-06T10:00:00.000Z", "again"))}\n`,
      );
      expect(await order()).toEqual(["a", "c", "b"]);
    } finally {
      await removeRoot(root);
    }
  });

  test("a chat with no message is listed at its header time, not at its file time", async () => {
    const root = await makeTempRoot();
    try {
      const home = path.join(root, "home");
      const sessionsRoot = path.join(root, "sessions");
      const cwd = path.join(home, "project");
      await mkdir(cwd, { recursive: true });
      await writeSession(path.join(sessionsRoot, "-project", "2026-10-01_empty.jsonl"), {
        id: "empty",
        cwd,
        timestamp: "2026-10-01T08:00:00.000Z",
      });
      const store = new SessionFileStore({ sessionsRoot, home, tempRoot: path.join(root, "tmp") });
      const listed = await store.listSessions({ folder: cwd });
      expect(listed.sessions[0]?.updatedAt).toBe("2026-10-01T08:00:00.000Z");
    } finally {
      await removeRoot(root);
    }
  });

  test("a listing cursor in the old form starts the list again, from its top", async () => {
    const root = await makeTempRoot();
    try {
      const home = path.join(root, "home");
      const sessionsRoot = path.join(root, "sessions");
      const cwd = path.join(home, "project");
      const bucket = path.join(sessionsRoot, "-project");
      await mkdir(cwd, { recursive: true });
      for (const [id, at] of [
        ["a", "2026-10-01T10:00:00.000Z"],
        ["b", "2026-10-02T10:00:00.000Z"],
        ["c", "2026-10-03T10:00:00.000Z"],
      ] as const) {
        await writeSession(path.join(bucket, `2026-10-01_${id}.jsonl`), {
          id,
          cwd,
          timestamp: at,
          records: [messageRecord(`m-${id}`, at, `hello ${id}`)],
        });
      }
      const store = new SessionFileStore({ sessionsRoot, home, tempRoot: path.join(root, "tmp") });
      // `<time>.<tag>.<base64url name>`: the form every listing cursor had before the order changed.
      const oldForm = `${Date.parse("2026-10-02T10:00:00.000Z")}.0123456789abcdef.${Buffer.from("2026-10-01_b.jsonl").toString("base64url")}`;
      const listed = await store.listSessions({ folder: cwd, cursor: oldForm });
      expect(listed.sessions.map((session) => session.id)).toEqual(["c", "b", "a"]);
    } finally {
      await removeRoot(root);
    }
  });

  test("a chat's update time is remembered while its file's size and time are unchanged", async () => {
    const root = await makeTempRoot();
    try {
      const home = path.join(root, "home");
      const sessionsRoot = path.join(root, "sessions");
      const cwd = path.join(home, "project");
      const file = path.join(sessionsRoot, "-project", "2026-10-01_cached.jsonl");
      await mkdir(cwd, { recursive: true });
      const at = new Date("2026-10-01T10:00:00.000Z");
      await writeSession(file, {
        id: "cached",
        cwd,
        timestamp: "2026-10-01T08:00:00.000Z",
        records: [messageRecord("m-cached", at.toISOString(), "hello")],
      });
      await utimes(file, at, at);
      const store = new SessionFileStore({ sessionsRoot, home, tempRoot: path.join(root, "tmp") });
      expect((await store.listSessions({ folder: cwd })).sessions[0]?.updatedAt).toBe(
        at.toISOString(),
      );

      // Same size and modified time, a later message time: the remembered time is kept, as the file is not read again.
      await writeSession(file, {
        id: "cached",
        cwd,
        timestamp: "2026-10-01T08:00:00.000Z",
        records: [messageRecord("m-cached", "2026-10-01T11:00:00.000Z", "hello")],
      });
      await utimes(file, at, at);
      expect((await store.listSessions({ folder: cwd })).sessions[0]?.updatedAt).toBe(
        at.toISOString(),
      );
    } finally {
      await removeRoot(root);
    }
  });
});
