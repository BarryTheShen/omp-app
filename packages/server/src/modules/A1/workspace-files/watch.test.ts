import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { watch } from "node:fs";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FolderPath, WorkspaceFileChanged, WorkspaceRelativePath } from "@omp-app/contracts";
import { FileWatchRegistry } from "../fs/file-watch-registry";
import {
  CHANGE_DEBOUNCE_MS,
  WATCH_POLL_MS,
  WorkspaceWatches,
  type WorkspaceWatchTimer,
} from "./watch";

let scratch: string;
let folder: FolderPath;
let watches: WorkspaceWatches | null = null;
const path = (text: string) => text as WorkspaceRelativePath;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "omp-app-workspace-watch-"));
  folder = join(scratch, "folder") as FolderPath;
  await mkdir(join(folder, "notes"), { recursive: true });
  await writeFile(join(folder, "notes", "a.md"), "first");
});

afterEach(async () => {
  watches?.close();
  watches = null;
  await rm(scratch, { recursive: true, force: true });
});

/** The changes told, as they arrive. */
function listen(on: WorkspaceWatches): WorkspaceFileChanged[] {
  const heard: WorkspaceFileChanged[] = [];
  on.onChange((event) => heard.push(event));
  return heard;
}

async function until(check: () => boolean, ms = 2000): Promise<void> {
  const end = performance.now() + ms;
  while (!check() && performance.now() < end) await Bun.sleep(20);
}

describe("the Files panel's watches (#2782)", () => {
  test("a watched directory tells a file made, changed and removed in it, each once, with its path", async () => {
    watches = new WorkspaceWatches({ registry: new FileWatchRegistry() });
    const heard = listen(watches);
    await watches.set("connection-1", folder, ["", path("notes")]);

    await writeFile(join(folder, "notes", "b.md"), "new");
    await until(() => heard.some((event) => event.path === "notes/b.md"));
    await appendFile(join(folder, "notes", "a.md"), " more");
    await until(() => heard.some((event) => event.path === "notes/a.md"));
    await rm(join(folder, "notes", "b.md"));
    await until(() => heard.filter((event) => event.path === "notes/b.md").length === 2);
    await Bun.sleep(CHANGE_DEBOUNCE_MS * 2);

    expect(heard).toContainEqual({ folder, path: path("notes/b.md"), change: "created" });
    expect(heard).toContainEqual({ folder, path: path("notes/a.md"), change: "modified" });
    expect(heard).toContainEqual({ folder, path: path("notes/b.md"), change: "deleted" });
    expect(heard.filter((event) => event.path === "notes/a.md")).toHaveLength(1);
  });

  test("a watch ends with the last connection that named it", async () => {
    watches = new WorkspaceWatches({ registry: new FileWatchRegistry() });
    await watches.set("one", folder, [path("notes")]);
    await watches.set("two", folder, [path("notes")]);
    expect(watches.watching).toHaveLength(1);
    watches.dropConnection("one");
    expect(watches.watching).toHaveLength(1);
    await watches.set("two", folder, []);
    expect(watches.watching).toHaveLength(0);
  });

  test("a path whose watch cannot open is polled, then watched again once a watch opens", async () => {
    let slots = false;
    const registry = new FileWatchRegistry({
      watchDirectory: (directory, listener) => {
        if (!slots) throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
        return watch(directory, { persistent: false }, listener);
      },
    });
    const ticks: Array<() => void> = [];
    const timer: WorkspaceWatchTimer = {
      setTimeout: (handler, ms) => setTimeout(handler, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      setInterval: (handler, ms) => {
        expect(ms).toBe(WATCH_POLL_MS);
        ticks.push(handler);
        return ticks.length;
      },
      clearInterval: (handle) => {
        ticks[(handle as number) - 1] = () => undefined;
      },
    };
    watches = new WorkspaceWatches({ registry, timer });
    const heard = listen(watches);
    await watches.set("connection-1", folder, [path("notes")]);
    expect(registry.snapshot()).toMatchObject({ state: "limited", reason: "watcher-limit" });

    await writeFile(join(folder, "notes", "c.md"), "polled");
    for (const tick of ticks) tick();
    await until(() => heard.some((event) => event.path === "notes/c.md"));
    expect(heard).toContainEqual({ folder, path: path("notes/c.md"), change: "created" });

    slots = true;
    for (const tick of ticks) tick();
    await until(() => registry.snapshot().state === "ok");
    expect(registry.snapshot()).toEqual({ state: "ok" });
  });
});
