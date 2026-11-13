import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcessTimer } from "../../process/omp-process";
import { UpdateHold, updateHoldFile } from "./update-hold";

const MIN = 60_000;

/** A clock and timers the test moves by hand. */
class FakeTimer implements ProcessTimer {
  now = 1_790_000_000_000;
  #next = 1;
  readonly timers = new Map<number, { at: number; handler: () => void }>();
  setTimeout(handler: () => void, delayMs: number): unknown {
    const id = this.#next++;
    this.timers.set(id, { at: this.now + delayMs, handler });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }
  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      const due = [...this.timers]
        .filter(([, timer]) => timer.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      this.timers.delete(due[0]);
      this.now = due[1].at;
      due[1].handler();
    }
    this.now = end;
  }
}

const folders: string[] = [];
afterEach(async () => {
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});

async function holdFile(): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "update-hold-"));
  folders.push(folder);
  return join(folder, "update-hold.json");
}

function holdAt(path: string, timer: FakeTimer): UpdateHold {
  return new UpdateHold({ now: () => timer.now, timer, ...updateHoldFile(path) });
}

async function exists(path: string): Promise<boolean> {
  return readFile(path, "utf8").then(
    () => true,
    () => false,
  );
}

describe("UpdateHold", () => {
  test("a hold outlives the server: a new one started from its file holds until the same time", async () => {
    const path = await holdFile();
    const timer = new FakeTimer();
    const first = holdAt(path, timer);
    await first.restore();
    const set = await first.hold("omp 18.18.9", 30);
    first.close();

    timer.advance(5 * MIN);
    const second = holdAt(path, timer);
    await second.restore();
    expect(second.held()).toBe(true);
    expect(second.state()).toEqual(set);

    timer.advance(25 * MIN - 1);
    expect(second.held()).toBe(true);
    timer.advance(1);
    expect(second.held()).toBe(false);
    await second.saved();
    expect(await exists(path)).toBe(false);
  });

  test("a hold that ended while the server was down is dropped with its file", async () => {
    const path = await holdFile();
    const timer = new FakeTimer();
    const first = holdAt(path, timer);
    await first.restore();
    await first.hold("omp 18.18.9", 10);
    first.close();

    timer.advance(10 * MIN);
    const second = holdAt(path, timer);
    await second.restore();
    expect(second.held()).toBe(false);
    expect(second.state()).toEqual({ held: false, reason: null, since: null, until: null });
    await second.saved();
    expect(await exists(path)).toBe(false);
  });

  test("holding again moves the end and keeps when the hold began", async () => {
    const path = await holdFile();
    const timer = new FakeTimer();
    const hold = holdAt(path, timer);
    await hold.restore();
    const began = timer.now;
    await hold.hold("omp 18.18.9", 10);
    timer.advance(8 * MIN);
    const renewed = await hold.hold("omp 18.18.9: switching", 10);
    expect(renewed).toEqual({
      held: true,
      reason: "omp 18.18.9: switching",
      since: began,
      until: began + 18 * MIN,
    });
    // The first end passes; the hold lasts to the second.
    timer.advance(5 * MIN);
    expect(hold.held()).toBe(true);
    timer.advance(5 * MIN);
    expect(hold.held()).toBe(false);
  });

  test("a hold set after the last one ended starts anew", async () => {
    const path = await holdFile();
    const timer = new FakeTimer();
    const hold = holdAt(path, timer);
    await hold.restore();
    await hold.hold("first", 5);
    timer.advance(6 * MIN);
    const second = await hold.hold("second", 5);
    expect(second.since).toBe(timer.now);
  });

  test("released, it ends at once and its file is gone", async () => {
    const path = await holdFile();
    const timer = new FakeTimer();
    const hold = holdAt(path, timer);
    await hold.restore();
    await hold.hold("omp 18.18.9", 30);
    expect(await exists(path)).toBe(true);
    expect(await hold.release()).toEqual({ held: false, reason: null, since: null, until: null });
    expect(hold.held()).toBe(false);
    expect(await exists(path)).toBe(false);
    // The timer of the released hold does nothing later.
    timer.advance(30 * MIN);
    expect(hold.held()).toBe(false);
  });

  test("a hold that could not be written fails, so an update does not go on without it", async () => {
    const timer = new FakeTimer();
    const hold = new UpdateHold({
      now: () => timer.now,
      timer,
      load: async () => null,
      save: async () => {
        throw new Error("disk full");
      },
    });
    await hold.restore();
    await expect(hold.hold("omp 18.18.9", 30)).rejects.toThrow("disk full");
    // Not on disk, so not on: nothing waits on a hold nobody could release after a restart.
    expect(hold.held()).toBe(false);
  });

  test("a renewal that could not be written leaves the hold as it was", async () => {
    const timer = new FakeTimer();
    let failing = false;
    const hold = new UpdateHold({
      now: () => timer.now,
      timer,
      load: async () => null,
      save: async () => {
        if (failing) throw new Error("disk full");
      },
    });
    await hold.restore();
    const first = await hold.hold("omp 18.18.9", 10);
    failing = true;
    await expect(hold.hold("omp 18.18.9: switching", 60)).rejects.toThrow("disk full");
    expect(hold.state()).toEqual(first);
  });

  test("a renewal whose write fails after a release does not bring the hold back", async () => {
    const timer = new FakeTimer();
    let holds = 0;
    let failRenewal: () => void = () => undefined;
    let renewalStarted: () => void = () => undefined;
    const writing = new Promise<void>((resolve) => {
      renewalStarted = resolve;
    });
    const hold = new UpdateHold({
      now: () => timer.now,
      timer,
      load: async () => null,
      save: (kept) => {
        if (kept === null) return Promise.resolve();
        holds += 1;
        if (holds === 1) return Promise.resolve();
        // The renewal's write fails, but only after the release was asked.
        return new Promise<void>((_resolve, reject) => {
          failRenewal = () => reject(new Error("disk full"));
          renewalStarted();
        });
      },
    });
    await hold.restore();
    await hold.hold("omp 18.18.9", 10);
    const renewing = hold.hold("omp 18.18.9: switching", 60);
    const releasing = hold.release();
    await writing;
    failRenewal();
    await expect(renewing).rejects.toThrow("disk full");
    await releasing;
    expect(hold.held()).toBe(false);
  });

  test("a renewal never ends a hold sooner; only release does", async () => {
    const path = await holdFile();
    const timer = new FakeTimer();
    const hold = holdAt(path, timer);
    await hold.restore();
    const long = await hold.hold("omp 18.18.9", 30);
    expect((await hold.hold("omp 18.18.9: checking", 5)).until).toBe(long.until);
    timer.advance(29 * MIN);
    expect(hold.held()).toBe(true);
    await hold.release();
    expect(hold.held()).toBe(false);
  });

  test("a release whose delete failed deletes the file when asked again", async () => {
    const timer = new FakeTimer();
    const saved: unknown[] = [];
    let deleteFails = true;
    const hold = new UpdateHold({
      now: () => timer.now,
      timer,
      load: async () => null,
      save: async (kept) => {
        if (kept === null && deleteFails) {
          deleteFails = false;
          throw new Error("EIO");
        }
        saved.push(kept);
      },
    });
    await hold.restore();
    await hold.hold("omp 18.18.9", 30);
    await expect(hold.release()).rejects.toThrow("EIO");
    await hold.release();
    expect(saved.at(-1)).toBeNull();
  });

  test("a kept end further off than a hold can be set for is brought in, on disk too", async () => {
    const path = await holdFile();
    const timer = new FakeTimer();
    const far = timer.now + 10 * 24 * 60 * MIN;
    await writeFile(
      path,
      JSON.stringify({ version: 1, reason: "x", since: timer.now, until: far }),
    );
    const hold = holdAt(path, timer);
    await hold.restore();
    expect(hold.state().until).toBe(timer.now + 240 * MIN);
    await hold.saved();
    expect(JSON.parse(await readFile(path, "utf8")).until).toBe(timer.now + 240 * MIN);
  });

  test("a damaged file holds nothing", async () => {
    const timer = new FakeTimer();
    for (const text of [JSON.stringify({ version: 1, reason: "x", since: "soon" }), "{ not json"]) {
      const path = await holdFile();
      await writeFile(path, text);
      const hold = holdAt(path, timer);
      await hold.restore();
      expect(hold.held()).toBe(false);
    }
  });
});
