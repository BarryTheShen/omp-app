import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { launchTokenDigest, openLaunchHistory, REMEMBERED_STARTS } from "./launch-history";
import { createNullLogger, type Logger } from "./logging";

const DATA = join(import.meta.dir, "../../../.data");
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function dataFolder(): Promise<string> {
  await mkdir(DATA, { recursive: true });
  const root = await mkdtemp(join(DATA, "launch-history-"));
  roots.push(root);
  return root;
}

/** A logger that keeps the names of its warnings, so a test can check what the app reported. */
function recordingLogger(): { logger: Logger; events: string[] } {
  const events: string[] = [];
  const logger: Logger = {
    ...createNullLogger(),
    warn: (event) => {
      events.push(event);
    },
  };
  return { logger, events };
}

describe("launch link history", () => {
  test("a data folder with no history has no earlier launch links, and nothing is logged", async () => {
    const { logger, events } = recordingLogger();
    expect(openLaunchHistory(await dataFolder(), logger).earlier.size).toBe(0);
    expect(events).toEqual([]);
  });

  test("a later start knows the launch token of each earlier start, as a digest only, readable by its owner", async () => {
    const dir = await dataFolder();
    const { logger } = recordingLogger();
    await openLaunchHistory(dir, logger).remember("first-start-token");
    const second = openLaunchHistory(dir, logger);
    expect([...second.earlier]).toEqual([launchTokenDigest("first-start-token")]);
    await second.remember("second-start-token");
    expect([...openLaunchHistory(dir, logger).earlier]).toEqual([
      launchTokenDigest("first-start-token"),
      launchTokenDigest("second-start-token"),
    ]);
    const file = join(dir, "launch-links.json");
    const text = await readFile(file, "utf8");
    expect(text).not.toContain("first-start-token");
    expect(text).not.toContain("second-start-token");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  test("remembering twice in one start keeps both launch tokens", async () => {
    const dir = await dataFolder();
    const { logger } = recordingLogger();
    const history = openLaunchHistory(dir, logger);
    await history.remember("token-a");
    await history.remember("token-b");
    expect([...openLaunchHistory(dir, logger).earlier]).toEqual([
      launchTokenDigest("token-a"),
      launchTokenDigest("token-b"),
    ]);
  });

  test("keeps only the newest starts, so an older link reads as never printed", async () => {
    const dir = await dataFolder();
    const { logger } = recordingLogger();
    // Seeded with one more than the limit, so one start's write must drop the oldest two.
    const older = Array.from({ length: REMEMBERED_STARTS + 2 }, (_, start) =>
      launchTokenDigest(`token-${start}`),
    );
    await writeFile(join(dir, "launch-links.json"), JSON.stringify(older));
    await openLaunchHistory(dir, logger).remember("newest-token");
    const digests = [...openLaunchHistory(dir, logger).earlier];
    expect(digests).toHaveLength(REMEMBERED_STARTS);
    expect(digests.at(-1)).toBe(launchTokenDigest("newest-token"));
    expect(digests).not.toContain(launchTokenDigest("token-2"));
    expect(digests).toContain(launchTokenDigest("token-3"));
  });

  test("a damaged history file is logged and counts as no history; the next start replaces it", async () => {
    const dir = await dataFolder();
    const { logger, events } = recordingLogger();
    await writeFile(join(dir, "launch-links.json"), "{not json");
    expect(openLaunchHistory(dir, logger).earlier.size).toBe(0);
    await writeFile(join(dir, "launch-links.json"), JSON.stringify(["not-a-digest"]));
    expect(openLaunchHistory(dir, logger).earlier.size).toBe(0);
    expect(events).toEqual(["launch-links.unreadable", "launch-links.unreadable"]);
    await openLaunchHistory(dir, logger).remember("after-damage");
    expect([...openLaunchHistory(dir, logger).earlier]).toEqual([
      launchTokenDigest("after-damage"),
    ]);
  });

  test("a history that cannot be read is logged, and the start goes on", async () => {
    const dir = await dataFolder();
    const { logger, events } = recordingLogger();
    await mkdir(join(dir, "launch-links.json"));
    expect(openLaunchHistory(dir, logger).earlier.size).toBe(0);
    expect(events).toEqual(["launch-links.unreadable"]);
  });

  test("a history that cannot be saved is logged, and remembering does not throw", async () => {
    const dir = await dataFolder();
    const blocked = join(dir, "not-a-folder");
    await writeFile(blocked, "a file where the data folder should be");
    const { logger, events } = recordingLogger();
    await expect(openLaunchHistory(blocked, logger).remember("token")).resolves.toBeUndefined();
    expect(events).toContain("launch-links.not-saved");
  });
});
