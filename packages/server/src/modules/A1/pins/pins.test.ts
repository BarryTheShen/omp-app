import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AppFailure, ThreadId } from "@omp-app/contracts";
import { SessionPinStoreService } from "./session-pin-store";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "omp-app-pins-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function writePins(path: string, ids: readonly string[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(ids, null, "\t"), "utf8");
}

/** Polls until a real watcher event has made the condition true, so each wait ends with the event, not a duration. */
async function waitUntil(condition: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the watcher's event");
    await Bun.sleep(10);
  }
}

async function expectAppFailure(promise: Promise<unknown>): Promise<AppFailure> {
  try {
    await promise;
    throw new Error("Expected an AppFailure.");
  } catch (error) {
    expect(error).toBeInstanceOf(AppFailure);
    return error as AppFailure;
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("SessionPinStoreService", () => {
  test("resolves omp's agent directory from an isolated home, profile, and override", () => {
    const home = "/isolated-pins-home";
    const defaultStore = new SessionPinStoreService({ homeDir: home, env: {} });
    expect(defaultStore.agentDir).toBe(join(home, ".omp", "agent"));
    expect(defaultStore.filePath).toBe(join(home, ".omp", "agent", "session-pins.json"));

    const profileStore = new SessionPinStoreService({
      homeDir: home,
      env: { OMP_PROFILE: "work" },
    });
    expect(profileStore.agentDir).toBe(join(home, ".omp", "profiles", "work", "agent"));

    const overrideStore = new SessionPinStoreService({
      homeDir: home,
      env: { PI_CODING_AGENT_DIR: "~/custom-agent", OMP_PROFILE: "ignored" },
    });
    expect(overrideStore.agentDir).toBe(join(home, "custom-agent"));

    defaultStore.dispose();
    profileStore.dispose();
    overrideStore.dispose();
  });

  test("lists an absent file as empty with a concrete revision without creating it", async () => {
    const home = await temporaryDirectory();
    const store = new SessionPinStoreService({ homeDir: home, env: {} });

    const listed = await store.list();

    expect(listed.pins).toEqual([]);
    expect(listed.revision).toHaveLength(64);
    expect(listed.readAt).toMatch(/T/);
    await expect(stat(store.filePath)).rejects.toMatchObject({ code: "ENOENT" });
    store.dispose();
  });

  test("creates and unpins the omp-compatible file atomically with private permissions", async () => {
    const home = await temporaryDirectory();
    const store = new SessionPinStoreService({ homeDir: home, env: {} });
    const sessionId = ThreadId.parse("session-one");

    const absent = await store.list();
    const pinned = await store.set({
      sessionId,
      pinned: true,
      expectedRevision: absent.revision,
    });

    expect(await readFile(store.filePath, "utf8")).toBe('[\n\t"session-one"\n]');
    expect((await stat(store.filePath)).mode & 0o777).toBe(0o600);
    expect(pinned).toMatchObject({ sessionId, pinned: true });

    const listed = await store.list();
    expect(listed.pins).toEqual([{ sessionId, pinned: true }]);
    const unpinned = await store.set({
      sessionId,
      pinned: false,
      expectedRevision: listed.revision,
    });
    expect(unpinned).toMatchObject({ sessionId, pinned: false });
    expect(await readFile(store.filePath, "utf8")).toBe("[]");
    expect((await store.list()).pins).toEqual([]);
    store.dispose();
  });

  test("accepts a direct absent-file CAS and keeps an already-correct request a no-op", async () => {
    const home = await temporaryDirectory();
    const store = new SessionPinStoreService({ homeDir: home, env: {} });
    const sessionId = ThreadId.parse("session-one");

    const first = await store.set({ sessionId, pinned: true, expectedRevision: null });
    const before = await readFile(store.filePath, "utf8");
    const second = await store.set({
      sessionId,
      pinned: true,
      expectedRevision: first.revision,
    });

    expect(second.revision).toBe(first.revision);
    expect(await readFile(store.filePath, "utf8")).toBe(before);
    store.dispose();
  });

  test("rejects stale and wrong absent-file revisions as retryable conflicts", async () => {
    const home = await temporaryDirectory();
    const store = new SessionPinStoreService({ homeDir: home, env: {} });
    const sessionId = ThreadId.parse("session-one");
    const listed = await store.list();
    await store.set({ sessionId, pinned: true, expectedRevision: listed.revision });

    const stale = await expectAppFailure(
      store.set({ sessionId, pinned: false, expectedRevision: listed.revision }),
    );
    expect(stale.appError).toMatchObject({ code: "conflict", retryable: true });

    const absent = await expectAppFailure(
      store.set({ sessionId, pinned: false, expectedRevision: null }),
    );
    expect(absent.appError).toMatchObject({ code: "conflict", retryable: true });
    store.dispose();
  });

  test("surfaces malformed JSON and shapes without overwriting the file", async () => {
    const home = await temporaryDirectory();
    const store = new SessionPinStoreService({ homeDir: home, env: {} });
    const malformed = '{"pins":';
    await mkdir(dirname(store.filePath), { recursive: true });
    await writeFile(store.filePath, malformed, "utf8");

    const listError = await expectAppFailure(store.list());
    expect(listError.appError).toMatchObject({ code: "invalid_args", retryable: false });
    expect(listError.appError.message).not.toContain(home);
    const setError = await expectAppFailure(
      store.set({
        sessionId: ThreadId.parse("session-one"),
        pinned: true,
        expectedRevision: null,
      }),
    );
    expect(setError.appError.code).toBe("invalid_args");
    expect(await readFile(store.filePath, "utf8")).toBe(malformed);

    await writePins(store.filePath, ["session-one"]);
    const wrongShape = '{"sessionId":"session-one"}';
    await writeFile(store.filePath, wrongShape, "utf8");
    const shapeError = await expectAppFailure(store.list());
    expect(shapeError.appError.code).toBe("invalid_args");
    expect(await readFile(store.filePath, "utf8")).toBe(wrongShape);
    const wrongEntry = "[1]";
    await writeFile(store.filePath, wrongEntry, "utf8");
    const wrongEntryError = await expectAppFailure(store.list());
    expect(wrongEntryError.appError.code).toBe("invalid_args");
    expect(await readFile(store.filePath, "utf8")).toBe(wrongEntry);
    store.dispose();
  });

  test("emits external pin deltas, suppresses own writes, and reports malformed external edits", async () => {
    const home = await temporaryDirectory();
    const store = new SessionPinStoreService({
      homeDir: home,
      env: {},
      watchDebounceMs: 20,
    });
    const sessionA = ThreadId.parse("session-a");
    const sessionB = ThreadId.parse("session-b");
    const events: { sessionId: string; pinned: boolean }[] = [];
    const errors: AppFailure[] = [];
    const unsubscribe = store.subscribe((change) => {
      events.push({ sessionId: change.sessionId, pinned: change.pinned });
    });

    const absent = await store.list();
    await store.set({ sessionId: sessionA, pinned: true, expectedRevision: absent.revision });

    const errorStore = new SessionPinStoreService({
      agentDir: store.agentDir,
      watchDebounceMs: 20,
      onError: (error) => errors.push(error),
    });
    const errorUnsubscribe = errorStore.subscribe(() => undefined);
    await writeFile(store.filePath, "not json", "utf8");
    await waitUntil(() => errors.some((error) => error.appError.code === "invalid_args"));
    // Neither our own set nor the malformed external edit is a pin change.
    expect(events).toEqual([]);

    await writePins(store.filePath, [sessionA, sessionB]);
    await waitUntil(() => events.length === 1);
    expect(events).toEqual([{ sessionId: sessionB, pinned: true }]);

    await writePins(store.filePath, ["session-c"]);
    await waitUntil(() => events.length === 4);
    expect(events).toEqual([
      { sessionId: sessionB, pinned: true },
      { sessionId: "session-c", pinned: true },
      { sessionId: sessionA, pinned: false },
      { sessionId: sessionB, pinned: false },
    ]);

    errorUnsubscribe();
    unsubscribe();
    errorStore.dispose();
    store.dispose();
  });

  test("reseeds the watcher baseline after unsubscribe and resubscribe", async () => {
    const home = await temporaryDirectory();
    const store = new SessionPinStoreService({ homeDir: home, env: {}, watchDebounceMs: 20 });
    await writePins(store.filePath, ["session-a"]);
    const events: { sessionId: string; pinned: boolean }[] = [];
    const unsubscribe = store.subscribe((change) => {
      events.push({ sessionId: change.sessionId, pinned: change.pinned });
    });
    unsubscribe();

    await writePins(store.filePath, ["session-b"]);
    const resubscribe = store.subscribe((change) => {
      events.push({ sessionId: change.sessionId, pinned: change.pinned });
    });
    await writePins(store.filePath, ["session-c"]);
    await waitUntil(() => events.length === 2);

    expect(events).toEqual([
      { sessionId: "session-c", pinned: true },
      { sessionId: "session-b", pinned: false },
    ]);
    resubscribe();
    store.dispose();
  });

  test("a change made right after subscribing is reported, not taken for the starting state", async () => {
    const home = await temporaryDirectory();
    const store = new SessionPinStoreService({ homeDir: home, env: {}, watchDebounceMs: 20 });
    await writePins(store.filePath, ["session-a"]);
    const events: { sessionId: string; pinned: boolean }[] = [];
    const unsubscribe = store.subscribe((change) => {
      events.push({ sessionId: change.sessionId, pinned: change.pinned });
    });
    // Synchronous, so it is written before any read that the subscription starts can run.
    writeFileSync(store.filePath, JSON.stringify(["session-b"]), "utf8");
    await waitUntil(() => events.length === 2);

    expect(events).toEqual([
      { sessionId: "session-b", pinned: true },
      { sessionId: "session-a", pinned: false },
    ]);
    unsubscribe();
    store.dispose();
  });
});
