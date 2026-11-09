import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { copyMarkdown, SiyuanMirror, ticksIn } from "./siyuan-mirror";
import { TodoStore } from "./store";

const DATA = join(import.meta.dir, "../../../../.data");
const roots: string[] = [];
const mirrors: SiyuanMirror[] = [];
afterEach(async () => {
  for (const mirror of mirrors.splice(0)) mirror.stop();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const PAGE = "20240101120000-abcdefg";
const YOU = { kind: "person" } as const;

/** A SiYuan that keeps its blocks' Markdown, and the calls it had. */
function fakeSiyuan() {
  const blocks = new Map<string, string>();
  const calls: { path: string; body: Record<string, unknown>; auth: string | null }[] = [];
  let next = 1;
  let status = 200;
  const fetcher = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    const auth = new Headers(init.headers).get("authorization");
    calls.push({ path, body, auth });
    if (status !== 200) return new Response("no", { status });
    if (path === "/api/block/appendBlock") {
      const id = `2026110900000${next}-abcdefg`;
      next += 1;
      blocks.set(id, String(body.data));
      return Response.json({ code: 0, msg: "", data: [{ doOperations: [{ id }] }] });
    }
    if (path === "/api/block/updateBlock") {
      const id = String(body.id);
      if (!blocks.has(id)) return Response.json({ code: -1, msg: "block not found", data: null });
      blocks.set(id, String(body.data));
      return Response.json({ code: 0, msg: "", data: [] });
    }
    if (path === "/api/block/getBlockKramdown") {
      return Response.json({
        code: 0,
        msg: "",
        data: { id: body.id, kramdown: blocks.get(String(body.id)) },
      });
    }
    return Response.json({ code: -1, msg: "unknown" });
  }) as unknown as typeof fetch;
  return {
    blocks,
    calls,
    fetcher,
    refuse: (code: number) => {
      status = code;
    },
  };
}

async function setUp() {
  await Bun.write(join(DATA, ".keep"), "");
  const root = await mkdtemp(join(DATA, "siyuan-copy-"));
  roots.push(root);
  const store = await TodoStore.open(root);
  const siyuan = fakeSiyuan();
  const mirror = await SiyuanMirror.open(root, store, {
    fetch: siyuan.fetcher,
    writeDelayMs: 5,
    readEveryMs: 3_600_000,
    now: () => new Date(2026, 10, 9, 4, 5),
  });
  mirrors.push(mirror);
  return { root, store, siyuan, mirror };
}

describe("the to-do list's copy in SiYuan", () => {
  test("set, it writes one block at the page's end with the token, keeps its id, and rewrites it after a change", async () => {
    const { root, store, siyuan, mirror } = await setUp();
    await store.add({ title: "Write the plan", list: "omp-app", state: "doing" }, YOU);
    const state = await mirror.set({
      address: "http://127.0.0.1:6806/",
      token: "secret-token",
      target: PAGE,
    });
    expect(state).toEqual({
      address: "http://127.0.0.1:6806",
      target: PAGE,
      tokenSaved: true,
      lastWrite: { at: new Date(2026, 10, 9, 4, 5).getTime(), ok: true, problem: null },
    });
    expect(JSON.stringify(state)).not.toContain("secret-token");
    expect(siyuan.calls[0]).toMatchObject({
      path: "/api/block/appendBlock",
      body: { parentID: PAGE, dataType: "markdown" },
      auth: "Token secret-token",
    });
    const [block] = [...siyuan.blocks.keys()];
    expect(siyuan.blocks.get(block ?? "")).toContain("- [ ] Write the plan · doing");
    // The token stays in the server's own file, readable by its owner only.
    expect((await stat(join(root, "siyuan-copy.json"))).mode & 0o077).toBe(0);

    await store.add({ title: "Read chapter 4", list: "School" }, YOU);
    await Bun.sleep(30);
    await mirror.settled();
    expect(siyuan.calls.at(-1)).toMatchObject({
      path: "/api/block/updateBlock",
      body: { id: block },
    });
    expect(siyuan.blocks.get(block ?? "")).toContain("- **School**\n  - [ ] Read chapter 4");
    expect(siyuan.blocks.size).toBe(1);

    // Deleted in SiYuan: written again at the page's end.
    siyuan.blocks.clear();
    await store.add({ title: "Call the bank" }, YOU);
    await Bun.sleep(30);
    await mirror.settled();
    expect(siyuan.calls.at(-1)?.path).toBe("/api/block/appendBlock");
    expect(siyuan.blocks.size).toBe(1);
  });

  test("a tick in SiYuan marks its item done in the app; a copy edited there is not read; off, nothing more is written", async () => {
    const { root, store, siyuan, mirror } = await setUp();
    const plan = await store.add({ title: "Write the plan" }, YOU);
    await store.add({ title: "Send the [report]" }, YOU);
    await mirror.set({ address: "http://127.0.0.1:6806", token: "t", target: PAGE });
    const [block] = [...siyuan.blocks.keys()];
    const written = siyuan.blocks.get(block ?? "") ?? "";
    // SiYuan's own Markdown of the block: IALs after the marks, the tick as X.
    siyuan.blocks.set(
      block ?? "",
      written
        .replace("- [ ] Write the plan", '- {: id="20261109000000-aaaaaaa"}[X] Write the plan')
        .replace(/\n/g, '\n  {: id="x"}\n'),
    );
    await mirror.readTicks();
    expect(store.board().items.find((item) => item.id === plan.id)).toMatchObject({
      state: "done",
      updatedBy: { kind: "siyuan" },
    });

    // An edited copy (a line taken out) is rewritten, not read.
    await Bun.sleep(30);
    await mirror.settled();
    siyuan.blocks.set(block ?? "", "- [ ] Send the \\[report\\]");
    await mirror.readTicks();
    expect(store.board().items.find((item) => item.id === plan.id)?.state).toBe("done");

    const calls = siyuan.calls.length;
    await mirror.set({ off: true });
    await store.add({ title: "Later" }, YOU);
    await Bun.sleep(30);
    expect(siyuan.calls.length).toBe(calls);
    expect(await readFile(join(root, "siyuan-copy.json"), "utf8").catch(() => null)).toBeNull();
  });

  test("a refused token says so, and the copy says how its last write went", async () => {
    const { store, siyuan, mirror } = await setUp();
    await store.add({ title: "Write the plan" }, YOU);
    siyuan.refuse(401);
    const state = await mirror.set({
      address: "http://127.0.0.1:6806",
      token: "wrong",
      target: PAGE,
    });
    expect(state.lastWrite).toMatchObject({ ok: false, problem: "SiYuan refused the API token" });
  });

  test("the copy's Markdown: each list's open items, then its latest done ones; marks escaped and read back", () => {
    const store = {
      items: [
        {
          id: "a",
          title: "Fix *bold* [link]",
          state: "open",
          list: "To do",
          due: null,
          doneAt: null,
        },
        { id: "b", title: "Old", state: "done", list: "To do", due: null, doneAt: 5 },
        { id: "c", title: "Gone", state: "dropped", list: "To do", due: null, doneAt: null },
      ],
      lists: ["To do"],
      revision: 3,
    } as unknown as Parameters<typeof copyMarkdown>[0];
    const { text, written } = copyMarkdown(store, new Date(2026, 10, 9, 4, 5));
    expect(text.split("\n").slice(0, 3)).toEqual([
      "- **To do**",
      "  - [ ] Fix \\*bold\\* \\[link\\]",
      "  - [x] Old",
    ]);
    expect(written.map((line) => [line.id, line.title, line.done])).toEqual([
      ["a", "Fix *bold* [link]", false],
      ["b", "Old", true],
    ]);
    expect(ticksIn(text).map((tick) => [tick.text, tick.done])).toEqual([
      ["Fix *bold* [link]", false],
      ["Old", true],
    ]);
  });
});
