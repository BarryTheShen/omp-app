import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type ConfigChanged, JsonValue } from "@omp-app/contracts";
import { describe, expect, test, vi } from "vitest";
import { ConfigStoreService } from "../../../../../../../packages/server/src/modules/A1/config/config-store";
import type * as FileWatcherModule from "../../../../../../../packages/server/src/modules/A1/fs/file-watcher";
import type { ConfigChangeSource, ConfigStoreClient } from "../../../S1/settings-kit";
import { ToolsSettingsStore } from "../../tools";

const worktreeData = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../../../.data");

// The store starts a re-read when its file watcher (`fs.watch`, inotify) reports a change. That
// report never comes when the machine's inotify instances are used up: `watch` throws EMFILE and
// the store stays silent (#903). So this file replaces only the watcher, and the test starts the
// re-read itself after each write. The rest is the real store: it reads, compares and emits, and
// the tools store re-reads.
const fileChangeListeners = vi.hoisted(
  () => new Map<string, FileWatcherModule.FileChangeListener>(),
);

vi.mock(
  "../../../../../../../packages/server/src/modules/A1/fs/file-watcher",
  async (importOriginal) => {
    const actual = await importOriginal<typeof FileWatcherModule>();
    return {
      ...actual,
      watchFile: (path: string, onChange: FileWatcherModule.FileChangeListener) => {
        fileChangeListeners.set(path, onChange);
        return {
          dispose: () => {
            fileChangeListeners.delete(path);
          },
        };
      },
    };
  },
);

function waitForToolsRevision(settings: ToolsSettingsStore, revision: string): Promise<void> {
  if (settings.getSnapshot().config?.revision === revision) return Promise.resolve();
  const pending = Promise.withResolvers<void>();
  let unsubscribe = () => {};
  const update = settings.subscribe((snapshot) => {
    if (snapshot.config?.revision !== revision) return;
    unsubscribe();
    pending.resolve();
  });
  unsubscribe = update;
  if (settings.getSnapshot().config?.revision === revision) {
    unsubscribe();
    pending.resolve();
  }
  return pending.promise;
}

/** Starts the store's re-read of `path`, as its file watcher does after a change. */
function rereadChangedFile(path: string): Promise<void> {
  const onChange = fileChangeListeners.get(path);
  if (!onChange) throw new Error(`No ConfigStore file watcher is armed for ${path}.`);
  // The store re-reads the file itself, so the event's hash is not used.
  return Promise.resolve(onChange({ path, hash: null }));
}

async function writeExternalConfig(
  configStore: ConfigStoreService,
  settings: ToolsSettingsStore,
  configPath: string,
  content: string,
): Promise<ConfigChanged> {
  const pending = Promise.withResolvers<ConfigChanged>();
  const unsubscribe = configStore.subscribe(null, pending.resolve);
  try {
    await writeFile(configPath, content, "utf8");
    await rereadChangedFile(configPath);
    const change = await pending.promise;
    await waitForToolsRevision(settings, change.revision);
    return change;
  } finally {
    unsubscribe();
  }
}

describe("ToolsSettingsStore with the real ConfigStoreService", () => {
  test("re-reads parent-key, non-Tools and multi-key external changes", async () => {
    await mkdir(worktreeData, { recursive: true });
    const root = await mkdtemp(join(worktreeData, "s3-real-config-"));
    const agentDir = join(root, "agent");
    const appDataDir = join(root, "app");
    const configPath = join(agentDir, "config.yml");
    await mkdir(agentDir, { recursive: true });
    await mkdir(appDataDir, { recursive: true });
    await writeFile(
      configPath,
      "model: initial\nglob:\n  enabled: true\ngithub:\n  cache:\n    softTtlSec: 10\n",
      "utf8",
    );

    const configStore = new ConfigStoreService({ agentDir, appDataDir, watchDebounceMs: 10 });
    const client: ConfigStoreClient = {
      read: (args) => configStore.read(args),
      list: (args) => configStore.list(args),
      write: (args) =>
        configStore.write({
          ...args,
          value: args.value.secret
            ? args.value
            : { secret: false, value: JsonValue.parse(args.value.value) },
        }),
    };
    const source: ConfigChangeSource = {
      subscribe: (listener) => configStore.subscribe(null, listener),
    };
    const settings = new ToolsSettingsStore(client, source, { folder: null, layer: "global" });

    try {
      await settings.read();
      await writeExternalConfig(
        configStore,
        settings,
        configPath,
        "model: primed\nglob:\n  enabled: true\ngithub:\n  cache:\n    softTtlSec: 10\n",
      );

      const firstToolsChange = await writeExternalConfig(
        configStore,
        settings,
        configPath,
        "model: primed\nglob:\n  enabled: false\ngithub:\n  cache:\n    softTtlSec: 10\n",
      );
      expect(firstToolsChange.key).toBe("glob");
      expect(firstToolsChange.entry.key).toBe("glob");
      expect(settings.getSnapshot().policy?.availability.glob).toBe(false);

      const beforeNonToolsChange = settings.getSnapshot().config?.revision;
      const nonToolsChange = await writeExternalConfig(
        configStore,
        settings,
        configPath,
        "model: external\nglob:\n  enabled: false\ngithub:\n  cache:\n    softTtlSec: 10\n",
      );
      expect(nonToolsChange.key).toBe("model");
      expect(settings.getSnapshot().config?.revision).not.toBe(beforeNonToolsChange);
      expect(settings.getSnapshot().policy?.availability.glob).toBe(false);

      expect(settings.stage("async.enabled", { secret: false, value: false }).ok).toBe(true);
      const multipleToolsChange = await writeExternalConfig(
        configStore,
        settings,
        configPath,
        "model: external again\nglob:\n  enabled: true\ngithub:\n  cache:\n    softTtlSec: 30\n",
      );
      expect(multipleToolsChange.key).toBe("github");
      expect(multipleToolsChange.entry.key).toBe("github");
      expect(settings.getSnapshot()).toMatchObject({
        phase: "conflict",
        policy: {
          availability: { glob: true },
          github: { cacheSoftTtlSec: 30 },
        },
        staged: { edits: { "async.enabled": { secret: false, value: false } } },
      });
    } finally {
      settings.dispose();
      configStore.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});
