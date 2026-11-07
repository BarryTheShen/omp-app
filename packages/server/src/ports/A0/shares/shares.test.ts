import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FolderPath, ListeningService, Share, SharesList, ThreadId } from "@omp-app/contracts";
import type { PortHandlerContext } from "../../../registry/ports";
import {
  createSharesRuntime,
  END_AFTER_MS,
  SHARE_AFTER_MS,
  type SharesPortContext,
  type SharesRuntime,
} from "./shares";

const T1 = "thread-one" as ThreadId;
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function upstream(): number {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("hello") });
  cleanups.push(() => server.stop(true));
  if (server.port === undefined) throw new Error("no port");
  return server.port;
}

const service = (port: number, extra: Partial<ListeningService> = {}): ListeningService => ({
  port,
  address: "127.0.0.1",
  program: "vite",
  command: "vite",
  startedAt: 1,
  threadId: null,
  neverShare: false,
  ...extra,
});

/** A runtime over a listed set of services, a phone that is paired, the events it published, and its clock. */
function runtime(
  listed: { services: ListeningService[] },
  clock = { at: 1_000_000 },
  extra: Pick<SharesPortContext, "stats"> = {},
) {
  let removed: ((deviceId: string) => void) | null = null;
  const events: { stream: string; payload: unknown }[] = [];
  let version = 0;
  let lastSeen = "";
  const shares: SharesRuntime = createSharesRuntime({
    pairing: {
      store: {
        list: () => [{ id: "d1", name: "Phone", kind: "browser", pairedAt: 0, lastSeenAt: 0 }],
        onRemoved: (listener: (deviceId: string) => void) => {
          removed = listener;
          return () => undefined;
        },
      },
      connections: { deviceOf: (connection: string) => (connection === "c-phone" ? "d1" : null) },
    } as never,
    publish: (stream, payload) => events.push({ stream, payload }),
    chats: () => [],
    appPort: () => undefined,
    address: () => "127.0.0.1",
    pollMs: 1_000_000_000,
    now: () => clock.at,
    readServices: async () => listed.services,
    signature: async () => {
      const now = JSON.stringify(listed.services);
      if (now !== lastSeen) {
        lastSeen = now;
        version += 1;
      }
      return String(version);
    },
    ...extra,
  });
  cleanups.push(() => shares.stop());
  const call = (method: string, args: unknown, connectionId = "c-phone") =>
    (
      shares.registration.handlers as Record<string, (a: unknown, c: PortHandlerContext) => unknown>
    )[method]?.(args, { connectionId } as PortHandlerContext);
  return { shares, events, call, remove: (deviceId: string) => removed?.(deviceId) };
}

/** Follows a share's one-time address as a browser does: the cookie it gives. */
async function enter(url: string): Promise<{ cookie: string; location: string | null }> {
  const entered = await fetch(url, { redirect: "manual" });
  expect(entered.status).toBe(303);
  return {
    cookie: (entered.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "",
    location: entered.headers.get("location"),
  };
}

describe("shares (#2788)", () => {
  test("a service is shared when asked, and opens on the device that asked through a one-time address", async () => {
    const port = upstream();
    const { call } = runtime({ services: [service(port)] });
    const share = (await call("share", { port })) as Share;
    expect(share.automatic).toBe(false);
    const { url } = (await call("open", { id: share.id })) as { url: string };
    const { cookie } = await enter(url);
    const shown = await fetch(share.url, { headers: { cookie } });
    expect(await shown.text()).toBe("hello");
    const list = (await call("list", {})) as SharesList;
    expect(list.shares.map((entry) => entry.openedBy)).toEqual([["Phone"]]);
  });

  test("omp's statistics page is started when first asked and shared as a service of its own (#2836 D6)", async () => {
    const port = upstream();
    const { call } = runtime(
      { services: [service(port, { program: "omp", command: "omp stats" })] },
      undefined,
      { stats: { start: async () => port } },
    );
    const share = (await call("shareStats", {})) as Share;
    expect(share).toMatchObject({ kind: "service", port, automatic: false, threadId: null });
    // Asked again, the same share.
    expect(((await call("shareStats", {})) as Share).id).toBe(share.id);
    const { url } = (await call("open", { id: share.id })) as { url: string };
    const { cookie } = await enter(url);
    expect(await (await fetch(share.url, { headers: { cookie } })).text()).toBe("hello");
  });

  test("a server that does not run the statistics page, or whose page did not start, says so", async () => {
    const { call } = runtime({ services: [] });
    await expect(Promise.resolve(call("shareStats", {}))).rejects.toMatchObject({
      appError: {
        code: "unavailable",
        message: "This app server does not run omp's statistics page.",
      },
    });
    const broken = runtime({ services: [] }, undefined, {
      stats: { start: () => Promise.reject(new Error("omp's statistics page did not start.")) },
    });
    await expect(Promise.resolve(broken.call("shareStats", {}))).rejects.toMatchObject({
      appError: { code: "unavailable", message: "omp's statistics page did not start." },
    });
  });

  test("a service on the never-share list, or one not listening, is not shared", async () => {
    const port = upstream();
    const { call } = runtime({
      services: [service(port, { program: "syncthing", neverShare: true })],
    });
    await expect(Promise.resolve(call("share", { port }))).rejects.toMatchObject({
      appError: { code: "permission" },
    });
    await expect(Promise.resolve(call("share", { port: port + 1 }))).rejects.toMatchObject({
      appError: { code: "not_found" },
    });
  });

  test("a service a chat starts is shared by itself once it has listened 5 s, and the chat told; stopped by hand, it stays unshared", async () => {
    const port = upstream();
    const listed = { services: [service(port, { threadId: T1 })] };
    const clock = { at: 1_000_000 };
    const { shares, events, call } = runtime(listed, clock);
    const told = () =>
      events.find((event) => event.stream === "A0.shares/sharedForChat")?.payload as
        | { threadId: ThreadId; share: Share }
        | undefined;
    await shares.poll();
    expect(told()).toBeUndefined();
    clock.at += SHARE_AFTER_MS;
    await shares.poll();
    expect(told()?.threadId).toBe(T1);
    expect(told()?.share.automatic).toBe(true);
    await call("stop", { id: told()?.share.id });
    listed.services = [service(port, { threadId: T1, command: "vite --again" })];
    clock.at += SHARE_AFTER_MS;
    await shares.poll();
    expect(((await call("list", {})) as SharesList).shares).toEqual([]);
  });

  test("a service that comes and goes every 2 s is never shared (#2836)", async () => {
    const port = upstream();
    const listed: { services: ListeningService[] } = { services: [] };
    const clock = { at: 1_000_000 };
    const { shares, events } = runtime(listed, clock);
    for (let start = 1; start <= 10; start += 1) {
      listed.services = [service(port, { threadId: T1, startedAt: start })];
      await shares.poll();
      clock.at += 2_000;
      listed.services = [];
      await shares.poll();
      clock.at += 2_000;
    }
    expect(events.filter((event) => event.stream === "A0.shares/sharedForChat")).toEqual([]);
  });

  test("a share ends once its service has been gone 10 s; back before then, it stays (#2836)", async () => {
    const port = upstream();
    const listed = { services: [service(port)] };
    const clock = { at: 1_000_000 };
    const { shares, call } = runtime(listed, clock);
    const share = (await call("share", { port })) as Share;
    const kept = async () => ((await call("list", {})) as SharesList).shares.map((each) => each.id);
    listed.services = [];
    await shares.poll();
    clock.at += 4_000;
    await shares.poll();
    listed.services = [service(port)];
    await shares.poll();
    expect(await kept()).toEqual([share.id]);

    listed.services = [];
    await shares.poll();
    clock.at += END_AFTER_MS - 1;
    await shares.poll();
    expect(await kept()).toEqual([share.id]);
    clock.at += 1;
    await shares.poll();
    expect(await kept()).toEqual([]);
    await expect(fetch(share.url)).rejects.toThrow();
  });

  test("a device removed from the paired devices loses its sessions", async () => {
    const port = upstream();
    const { call, remove } = runtime({ services: [service(port)] });
    const share = (await call("share", { port })) as Share;
    const { url } = (await call("open", { id: share.id })) as { url: string };
    const { cookie } = await enter(url);
    remove("d1");
    expect((await fetch(share.url, { headers: { cookie } })).status).toBe(403);
  });

  test("an HTML file opens as a page from its folder; no other file, and none outside the folder, also through a link", async () => {
    const folder = await mkdtemp(join(tmpdir(), "omp-app-share-"));
    const outside = await mkdtemp(join(tmpdir(), "omp-app-share-outside-"));
    cleanups.push(() => rm(folder, { recursive: true, force: true }));
    cleanups.push(() => rm(outside, { recursive: true, force: true }));
    await writeFile(join(folder, "guide.html"), "<p>guide</p>");
    await writeFile(join(folder, "notes.txt"), "notes");
    await mkdir(join(outside, "site"));
    await writeFile(join(outside, "site/index.html"), "<p>not this chat's</p>");
    await symlink(join(outside, "site"), join(folder, "linked"));
    const { call } = runtime({ services: [] });
    const share = (await call("sharePage", {
      folder: folder as FolderPath,
      path: "guide.html",
    })) as Share;
    const { url } = (await call("open", { id: share.id }, "c-other")) as { url: string };
    const { cookie, location } = await enter(url);
    expect(location).toBe("/guide.html");
    expect(await (await fetch(`${share.url}guide.html`, { headers: { cookie } })).text()).toBe(
      "<p>guide</p>",
    );
    await expect(
      Promise.resolve(call("sharePage", { folder: folder as FolderPath, path: "notes.txt" })),
    ).rejects.toMatchObject({ appError: { code: "invalid_args" } });
    await expect(
      Promise.resolve(call("sharePage", { folder: folder as FolderPath, path: "../x.html" })),
    ).rejects.toMatchObject({ appError: { code: "invalid_args" } });
    // A folder link inside the chat's folder that points elsewhere would share that other folder.
    await expect(
      Promise.resolve(
        call("sharePage", { folder: folder as FolderPath, path: "linked/index.html" }),
      ),
    ).rejects.toMatchObject({ appError: { code: "invalid_args" } });
  });
});
