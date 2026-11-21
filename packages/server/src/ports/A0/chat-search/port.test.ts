import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BATCH, embed } from "./embeddings";
import { createChatSearchRegistration, NO_INDEX } from "./port";

const dirs: string[] = [];
const servers: { stop(force?: boolean): void }[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A stand-in embedding service: a vector per text (its length, then 1, 2, 3), the key it was given, its batches. */
function service(options: { status?: number; body?: string } = {}) {
  const seen = { keys: [] as (string | null)[], batches: [] as number[] };
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      seen.keys.push(request.headers.get("authorization"));
      if (options.status !== undefined)
        return new Response(options.body ?? "", { status: options.status });
      const { input } = (await request.json()) as { input: string[] };
      seen.batches.push(input.length);
      const data = input
        .map((text, index) => ({ index, embedding: [text.length, 1, 2, 3] }))
        .reverse();
      return Response.json({ data });
    },
  });
  servers.push(server);
  return { address: `http://127.0.0.1:${server.port}/v1`, seen };
}

async function files() {
  const dir = await mkdtemp(join(tmpdir(), "chat-search-"));
  dirs.push(dir);
  return { settings: join(dir, "search-settings.json"), key: join(dir, "search-key") };
}

type Handler = (args: unknown, call: unknown) => Promise<unknown>;
function port(paths: { settings: string; key: string }) {
  const published: unknown[] = [];
  const registration = createChatSearchRegistration({
    files: paths,
    index: NO_INDEX,
    publish: (_key, payload) => published.push(payload),
  });
  const handlers = registration.handlers as Record<string, Handler>;
  const call = (name: string, args: unknown = {}) => (handlers[name] as Handler)(args, {});
  return { call, published };
}

describe("the embedding service", () => {
  test("vectors come back in the texts' order, in batches, with the key as a bearer token", async () => {
    const { address, seen } = service();
    const texts = Array.from({ length: BATCH + 3 }, (_, n) => "x".repeat(n + 1));
    const vectors = await embed({ address, model: "m", key: "secret-key" }, texts);
    expect(vectors.map((vector) => vector[0])).toEqual(texts.map((text) => text.length));
    expect(seen.batches).toEqual([BATCH, 3]);
    expect(seen.keys).toEqual(["Bearer secret-key", "Bearer secret-key"]);
  });

  test("a refusal says what the service said; nothing listening says it could not be reached", async () => {
    const { address } = service({ status: 401, body: JSON.stringify({ error: "Unauthorized" }) });
    await expect(embed({ address, model: "m", key: null }, ["a"])).rejects.toThrow(
      "the embedding service answered 401: Unauthorized",
    );
    await expect(
      embed({ address: "http://127.0.0.1:1/v1", model: "m", key: null }, ["a"]),
    ).rejects.toThrow("could not be reached");
  });
});

describe("Search by meaning's settings", () => {
  test("off with nothing set at first; each change is kept with the others, and the key never reaches a page", async () => {
    const paths = await files();
    const { call, published } = port(paths);
    expect(await call("state")).toEqual({
      settings: { enabled: false, address: "", model: "", hasKey: false },
      status: { chats: 0, indexed: 0, indexing: false, problem: null },
    });
    const { address } = service();
    await call("setSettings", {
      address: `${address}/`,
      model: "qwen3-embedding-0.6b",
      key: "secret-key",
    });
    const on = (await call("setSettings", { enabled: true })) as { settings: unknown };
    expect(on.settings).toEqual({
      enabled: true,
      address,
      model: "qwen3-embedding-0.6b",
      hasKey: true,
    });
    expect(JSON.stringify(on)).not.toContain("secret-key");
    expect(JSON.parse(await readFile(paths.settings, "utf8"))).toEqual({
      version: 1,
      enabled: true,
      address,
      model: "qwen3-embedding-0.6b",
    });
    expect(await readFile(paths.key, "utf8")).toBe("secret-key");
    if (process.platform !== "win32") expect((await stat(paths.key)).mode & 0o777).toBe(0o600);
    expect(published.length).toBe(2);
    // A key of "" removes the kept one.
    expect(
      ((await call("setSettings", { key: "" })) as { settings: { hasKey: boolean } }).settings
        .hasKey,
    ).toBe(false);
  });

  test("an address with a key in it, or that is not one, is refused; it cannot be turned on with nothing set", async () => {
    const { call } = port(await files());
    await expect(
      call("setSettings", { address: "https://user:pass@embed.example.com/v1" }),
    ).rejects.toMatchObject({
      appError: { code: "invalid_args" },
    });
    await expect(call("setSettings", { address: "embed.example.com" })).rejects.toMatchObject({
      appError: { code: "invalid_args" },
    });
    await expect(call("setSettings", { enabled: true })).rejects.toMatchObject({
      appError: {
        message: "Set the service's address and model before turning search by meaning on.",
      },
    });
  });

  test("Test embeds one line with the service as set: its time and dimensions, or the service's words", async () => {
    const paths = await files();
    const { call } = port(paths);
    expect(await call("test")).toEqual({
      ok: false,
      ms: 0,
      message: "Set the service's address and model first.",
    });
    const { address } = service();
    await call("setSettings", { address, model: "m" });
    expect(await call("test")).toMatchObject({ ok: true, dimensions: 4 });
    const refusing = service({ status: 401, body: "no key" });
    await call("setSettings", { address: refusing.address });
    expect(await call("test")).toMatchObject({
      ok: false,
      message: "the embedding service answered 401: no key",
    });
  });

  test("a settings file that cannot be read is off with nothing set; search while off finds nothing", async () => {
    const paths = await files();
    await writeFile(paths.settings, "{ not json");
    const { call } = port(paths);
    expect(((await call("state")) as { settings: unknown }).settings).toEqual({
      enabled: false,
      address: "",
      model: "",
      hasKey: false,
    });
    expect(await call("search", { query: "anything" })).toEqual({ matches: [] });
  });
});
