import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackgroundJobStopStoreService } from "./stop-store";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop() ?? "", { recursive: true, force: true });
});

/** A store whose clock moves one millisecond per recorded stop, so each stop's time is known: the first is 1001. */
async function storeIn(options: { limit?: number; onError?: (error: unknown) => void } = {}) {
  const root = await mkdtemp(join(tmpdir(), "background-job-stops-"));
  roots.push(root);
  let clock = 1_000;
  return new BackgroundJobStopStoreService({
    appDataDir: join(root, "app"),
    now: () => (clock += 1),
    ...options,
  });
}

function fileOf(store: BackgroundJobStopStoreService, threadId: string): string {
  return join(store.appDataDir, "background-job-stops", `${encodeURIComponent(threadId)}.json`);
}

describe("BackgroundJobStopStoreService", () => {
  test("keeps each chat's stops in its own file, each with the time it was recorded", async () => {
    const store = await storeIn();
    await store.record("chat-a", { jobId: "bg_1", status: "stopped" });
    await store.record("chat-a", { jobId: "bg_2", status: "finished" });
    await store.record("chat-b", { jobId: "bg_1", status: "stopped" });

    expect(await store.list("chat-a")).toEqual([
      { jobId: "bg_1", status: "stopped", at: 1_001 },
      { jobId: "bg_2", status: "finished", at: 1_002 },
    ]);
    expect(await store.list("chat-b")).toEqual([{ jobId: "bg_1", status: "stopped", at: 1_003 }]);
    expect(await store.list("chat-c")).toEqual([]);
    expect(JSON.parse(await readFile(fileOf(store, "chat-a"), "utf8"))).toHaveLength(2);
  });

  test("a stop recorded again for the same job replaces the earlier one, with its own time, and takes the last place", async () => {
    const store = await storeIn();
    await store.record("chat-a", { jobId: "bg_1", status: "finished" });
    await store.record("chat-a", { jobId: "bg_2", status: "stopped" });
    await store.record("chat-a", { jobId: "bg_1", status: "stopped" });

    expect(await store.list("chat-a")).toEqual([
      { jobId: "bg_2", status: "stopped", at: 1_002 },
      { jobId: "bg_1", status: "stopped", at: 1_003 },
    ]);
  });

  test("drops the oldest stops of a chat past its limit", async () => {
    const store = await storeIn({ limit: 2 });
    for (const jobId of ["bg_1", "bg_2", "bg_3"]) {
      await store.record("chat-a", { jobId, status: "stopped" });
    }

    expect((await store.list("chat-a")).map((stop) => stop.jobId)).toEqual(["bg_2", "bg_3"]);
  });

  test("a file it cannot read counts as no stops, and the failure is reported, not thrown", async () => {
    const reported: unknown[] = [];
    const store = await storeIn({ onError: (error) => reported.push(error) });
    await store.record("chat-a", { jobId: "bg_1", status: "stopped" });
    await writeFile(fileOf(store, "chat-a"), "{not json", "utf8");

    expect(await store.list("chat-a")).toEqual([]);
    expect(reported).toHaveLength(1);
    await store.record("chat-a", { jobId: "bg_2", status: "stopped" });
    expect(await store.list("chat-a")).toEqual([{ jobId: "bg_2", status: "stopped", at: 1_002 }]);
  });

  test("a value that is not a list of stops is reported and counts as no stops", async () => {
    const reported: unknown[] = [];
    const store = await storeIn({ onError: (error) => reported.push(error) });
    await store.record("chat-a", { jobId: "bg_1", status: "stopped" });
    await writeFile(fileOf(store, "chat-a"), JSON.stringify([{ jobId: "bg_1", status: "failed" }]));

    expect(await store.list("chat-a")).toEqual([]);
    expect(reported).toHaveLength(1);
  });

  test("a stop without its time is not a stop: the list reports it and reads no stops", async () => {
    const reported: unknown[] = [];
    const store = await storeIn({ onError: (error) => reported.push(error) });
    await store.record("chat-a", { jobId: "bg_1", status: "stopped" });
    await writeFile(
      fileOf(store, "chat-a"),
      JSON.stringify([{ jobId: "bg_1", status: "stopped" }]),
    );

    expect(await store.list("chat-a")).toEqual([]);
    expect(reported).toHaveLength(1);
  });
});
