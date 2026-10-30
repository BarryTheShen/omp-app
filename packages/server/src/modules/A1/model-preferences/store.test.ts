import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { AppFailure, type ModelPreferences } from "@omp-app/contracts";
import { ModelPreferenceStoreService } from "./store";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function store(): Promise<ModelPreferenceStoreService> {
  const appDataDir = join(process.cwd(), ".data", `model-preferences-${crypto.randomUUID()}`);
  roots.push(appDataDir);
  return new ModelPreferenceStoreService({ appDataDir });
}

const code = (error: unknown) =>
  error instanceof AppFailure ? error.appError.code : String(error);

describe("the model menu's stars and hidden models", () => {
  test("start empty; a star and a hide are saved, also for a store opened later on the same folder", async () => {
    const first = await store();
    const empty = await first.read();
    expect(empty).toMatchObject({ favorites: [], hidden: [] });

    const starred = await first.set({
      model: "fake/claude-fable-5",
      favorite: true,
      expectedRevision: empty.revision,
    });
    const hid = await first.set({
      model: "fake/claude-3-5-sonnet-20240620",
      hidden: true,
      expectedRevision: starred.revision,
    });
    expect(hid).toMatchObject({
      favorites: ["fake/claude-fable-5"],
      hidden: ["fake/claude-3-5-sonnet-20240620"],
    });
    const reopened = new ModelPreferenceStoreService({ appDataDir: join(first.filePath, "..") });
    expect(await reopened.read()).toEqual(hid);
  });

  test("starring a hidden model shows it, and hiding a starred one unstars it; stars keep their order", async () => {
    const preferences = await store();
    let state = await preferences.read();
    const set = async (args: { model: string; favorite?: boolean; hidden?: boolean }) => {
      state = await preferences.set({ ...args, expectedRevision: state.revision });
    };
    await set({ model: "fake/a", favorite: true });
    await set({ model: "fake/b", favorite: true });
    await set({ model: "fake/c", hidden: true });
    await set({ model: "fake/c", favorite: true });
    expect(state).toMatchObject({ favorites: ["fake/a", "fake/b", "fake/c"], hidden: [] });

    await set({ model: "fake/a", hidden: true });
    expect(state).toMatchObject({ favorites: ["fake/b", "fake/c"], hidden: ["fake/a"] });
    // A star given again changes nothing: the model keeps its place.
    await set({ model: "fake/b", favorite: true });
    expect(state.favorites).toEqual(["fake/b", "fake/c"]);
    await set({ model: "fake/a", hidden: false });
    expect(state).toMatchObject({ favorites: ["fake/b", "fake/c"], hidden: [] });
  });

  test("a change made on an older revision is refused as a conflict, and the newer change stays", async () => {
    const preferences = await store();
    const read = await preferences.read();
    await preferences.set({ model: "fake/a", favorite: true, expectedRevision: read.revision });
    const stale = preferences.set({
      model: "fake/b",
      favorite: true,
      expectedRevision: read.revision,
    });
    expect(await stale.then(() => "saved", code)).toBe("conflict");
    expect((await preferences.read()).favorites).toEqual(["fake/a"]);
  });

  test("tells every listener of each saved change, and not of a change that changes nothing", async () => {
    const preferences = await store();
    const heard: ModelPreferences[] = [];
    const stop = preferences.subscribe((change) => heard.push(change));
    const read = await preferences.read();
    const saved = await preferences.set({
      model: "fake/a",
      favorite: true,
      expectedRevision: read.revision,
    });
    await preferences.set({ model: "fake/a", favorite: true, expectedRevision: saved.revision });
    stop();
    await preferences.set({ model: "fake/a", favorite: false, expectedRevision: saved.revision });
    expect(heard).toEqual([saved]);
  });

  test("refuses a star and a hide at once, and a file it cannot read is left as it is", async () => {
    const preferences = await store();
    const read = await preferences.read();
    const both = preferences.set({
      model: "fake/a",
      favorite: true,
      hidden: true,
      expectedRevision: read.revision,
    });
    expect(await both.then(() => "saved", code)).toBe("invalid_args");

    await fs.mkdir(join(preferences.filePath, ".."), { recursive: true });
    await fs.writeFile(preferences.filePath, "{ not json");
    expect(await preferences.read().then(() => "read", code)).toBe("invalid_args");
    expect(await fs.readFile(preferences.filePath, "utf8")).toBe("{ not json");
  });
});
