import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DeviceStore, deviceKeyHash } from "./store";

const DATA = join(import.meta.dir, "../../../../.data");
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function folder(): Promise<string> {
  await Bun.write(join(DATA, ".keep"), "");
  const root = await mkdtemp(join(DATA, "devices-"));
  roots.push(root);
  return root;
}

describe("the paired devices", () => {
  test("a paired device's key opens it, the file keeps only the key's hash, owner-only, and a new start reads it back", async () => {
    const dir = await folder();
    const store = await DeviceStore.open({ appDataDir: dir });
    const { device, key } = await store.add("Laptop · desktop window", "desktop-window");
    expect(store.deviceForKey(key)?.id).toBe(device.id);
    expect(store.deviceForKey("x".repeat(43))).toBeUndefined();

    const text = await readFile(store.filePath, "utf8");
    expect(text).not.toContain(key);
    expect(text).toContain(deviceKeyHash(key));
    expect((await stat(store.filePath)).mode & 0o777).toBe(0o600);

    const again = await DeviceStore.open({ appDataDir: dir });
    expect(again.deviceForKey(key)).toMatchObject({
      id: device.id,
      name: "Laptop · desktop window",
    });
  });

  test("a removed device's key stops at once, its removal is heard first, and it stays removed after a restart", async () => {
    const dir = await folder();
    const store = await DeviceStore.open({ appDataDir: dir });
    const { device, key } = await store.add("iPhone", "home-screen-app");
    const removed: string[] = [];
    store.onRemoved((id) => removed.push(id));
    expect(await store.remove(device.id)).toBe(true);
    expect(removed).toEqual([device.id]);
    expect(store.deviceForKey(key)).toBeUndefined();
    expect(await store.remove(device.id)).toBe(false);
    expect((await DeviceStore.open({ appDataDir: dir })).list()).toEqual([]);
  });

  test("a rename is kept; the list is in pairing order and is heard on every change", async () => {
    const now = { value: Date.parse("2026-10-31T10:00:00Z") };
    const store = await DeviceStore.open({
      appDataDir: await folder(),
      now: () => new Date(now.value),
    });
    let heard = 0;
    store.subscribe(() => {
      heard += 1;
    });
    const first = await store.add("One", "browser");
    now.value += 1_000;
    await store.add("Two", "browser");
    expect(await store.rename(first.device.id, "Laptop")).toBe(true);
    expect(store.list().map((device) => device.name)).toEqual(["Laptop", "Two"]);
    expect(heard).toBe(3);
  });

  test("a connection's time is saved at most once a minute", async () => {
    const now = { value: Date.parse("2026-10-31T10:00:00Z") };
    const store = await DeviceStore.open({
      appDataDir: await folder(),
      now: () => new Date(now.value),
    });
    const { device } = await store.add("Laptop", "browser");
    store.seen(device.id);
    const firstSeen = store.list()[0]?.lastSeenAt;
    expect(firstSeen).toBe("2026-10-31T10:00:00.000Z");
    now.value += 30_000;
    store.seen(device.id);
    expect(store.list()[0]?.lastSeenAt).toBe(firstSeen);
    now.value += 30_000;
    store.seen(device.id);
    expect(store.list()[0]?.lastSeenAt).toBe("2026-10-31T10:01:00.000Z");
  });

  test("a damaged file pairs no device, and the next pairing writes a good one", async () => {
    const dir = await folder();
    await writeFile(join(dir, "devices.json"), "{not json");
    const store = await DeviceStore.open({ appDataDir: dir });
    expect(store.list()).toEqual([]);
    const { key } = await store.add("Laptop", "browser");
    expect((await DeviceStore.open({ appDataDir: dir })).deviceForKey(key)).toBeDefined();
  });

  test("a device keeps the frame it paired from; the app that paired last names the origin, and records from before read as pages of their own", async () => {
    const ORIGIN = "vscode-webview://0a1b2c3d4e5f";
    const now = { value: Date.parse("2026-11-12T10:00:00Z") };
    const dir = await folder();
    const store = await DeviceStore.open({ appDataDir: dir, now: () => new Date(now.value) });
    expect(store.namedFramedBy(ORIGIN)).toBeNull();
    const first = await store.add("First panel", "browser", { framed: true, framedBy: ORIGIN });
    expect(first.device).toMatchObject({ framed: true, framedBy: ORIGIN });
    now.value += 1_000;
    await store.add("Second panel", "browser", { framed: true, framedBy: ORIGIN });
    now.value += 1_000;
    const unnamed = await store.add("Unnamed panel", "browser", { framed: true });
    expect(unnamed.device).toMatchObject({ framed: true });
    expect(unnamed.device).not.toHaveProperty("framedBy");
    const plain = await store.add("Plain page", "browser");
    expect(plain.device).not.toHaveProperty("framed");
    expect(plain.device).not.toHaveProperty("framedBy");

    expect(store.namedFramedBy(ORIGIN)).toBe("Second panel");
    expect(store.namedFramedBy("moz-extension://other")).toBeNull();

    // A new start reads the frames back.
    const again = await DeviceStore.open({ appDataDir: dir });
    expect(again.list().map(({ name, framed, framedBy }) => ({ name, framed, framedBy }))).toEqual([
      { name: "First panel", framed: true, framedBy: ORIGIN },
      { name: "Second panel", framed: true, framedBy: ORIGIN },
      { name: "Unnamed panel", framed: true, framedBy: undefined },
      { name: "Plain page", framed: undefined, framedBy: undefined },
    ]);

    // A device file written before frames were kept still reads, as pages of their own.
    const old = await folder();
    await writeFile(
      join(old, "devices.json"),
      JSON.stringify({
        version: 1,
        devices: [
          {
            id: "d1",
            name: "Old laptop",
            kind: "browser",
            keyHash: "a".repeat(64),
            pairedAt: "2026-11-01T10:00:00.000Z",
            lastSeenAt: null,
          },
        ],
      }),
    );
    const [oldDevice] = (await DeviceStore.open({ appDataDir: old })).list();
    expect(oldDevice).toEqual({
      id: "d1",
      name: "Old laptop",
      kind: "browser",
      pairedAt: "2026-11-01T10:00:00.000Z",
      lastSeenAt: null,
    });
  });
});
