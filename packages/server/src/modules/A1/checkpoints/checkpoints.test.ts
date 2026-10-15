import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { AppFailure, EntryId, FolderPath, SessionFilePath, ThreadId } from "@omp-app/contracts";
import { CheckpointStoreService } from "./store";

type TreeEntry = { path: string; kind: string; mode: number; value?: string };

async function treeState(root: string): Promise<string> {
  const entries: TreeEntry[] = [];
  async function walk(directory: string): Promise<void> {
    const children = await fs.readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const absolute = join(directory, child.name);
      const path = absolute
        .slice(root.length + 1)
        .split("\\")
        .join("/");
      const stat = await fs.lstat(absolute);
      const entry: TreeEntry = {
        path,
        kind: child.isDirectory() ? "directory" : child.isSymbolicLink() ? "symlink" : "file",
        mode: stat.mode & 0o7777,
      };
      if (child.isDirectory()) {
        entries.push(entry);
        await walk(absolute);
      } else if (child.isSymbolicLink()) {
        entry.value = await fs.readlink(absolute);
        entries.push(entry);
      } else {
        entry.value = (await fs.readFile(absolute)).toString("base64");
        entries.push(entry);
      }
    }
  }
  await walk(root);
  return JSON.stringify(entries);
}

async function waitMs(milliseconds: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, milliseconds);
  await promise;
}

async function tempRoot(name: string): Promise<string> {
  const root = join(process.cwd(), ".data", `checkpoint-${name}-${crypto.randomUUID()}`);
  await fs.mkdir(root, { recursive: true });
  return root;
}

function conversation(workspace: string) {
  return {
    threadId: ThreadId.parse("thread-checkpoint"),
    sessionFile: SessionFilePath.parse(`${workspace}/session.jsonl`),
    entryId: EntryId.parse("entry-1"),
  };
}

describe("CheckpointStore", () => {
  test("captures a workspace in shadow git, diffs edits, and restores files without touching .git", async () => {
    const workspace = await tempRoot("restore");
    const appData = await tempRoot("app-data");
    await fs.writeFile(join(workspace, "hello.txt"), "before\n");
    try {
      const store = new CheckpointStoreService({ appDataDir: appData });
      const folder = FolderPath.parse(workspace);
      const first = await store.snapshot({
        workspace: folder,
        conversation: conversation(workspace),
        source: "manual",
        pinned: true,
      });
      expect(first.guarantee).toBe("boundary");
      expect(first.includedPaths.some((item) => item.path === "hello.txt")).toBe(true);
      expect(first.shadowTreeId).toBeTruthy();
      expect(first.includedPaths.some((item) => item.path.startsWith(".git"))).toBe(false);
      expect(first.workspaceKey).not.toContain("/");
      expect(
        await fs.stat(
          join(appData, "checkpoints", first.workspaceKey, first.ompSessionId, "shadow-git"),
        ),
      ).toBeTruthy();

      await fs.writeFile(join(workspace, "hello.txt"), "after\n");
      await fs.writeFile(join(workspace, "new.txt"), "new\n");
      const diff = await store.diff({ workspace: folder, snapshotId: first.snapshotId });
      expect(diff.entries.map((entry) => [entry.path, entry.change])).toEqual([
        ["hello.txt", "modified"],
        ["new.txt", "added"],
      ]);

      const plan = await store.planRestore({
        workspace: folder,
        operation: "files-only",
        snapshotId: first.snapshotId,
        currentConversation: conversation(workspace),
        targetConversation: null,
        expectedWorkspaceHash: first.workspaceHash,
      });
      expect(plan.requiresConfirmation).toBe(true);
      const restored = await store.restore({ planId: plan.planId, confirmed: true });
      expect(restored.filesRestored).toBe(true);
      expect(await fs.readFile(join(workspace, "hello.txt"), "utf8")).toBe("before\n");
      expect(restored.undoSnapshotId).toBeTruthy();
      expect(restored.redoAvailable).toBe(true);
      await expect(fs.access(join(workspace, "new.txt"))).rejects.toBeDefined();
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(appData, { recursive: true, force: true });
    }
  });

  test("retains pinned baseline plus the configured number of recent snapshots", async () => {
    const workspace = await tempRoot("retention");
    const appData = await tempRoot("retention-data");
    try {
      const store = new CheckpointStoreService({ appDataDir: appData, maxSnapshots: 2 });
      const folder = FolderPath.parse(workspace);
      const base = await store.snapshot({
        workspace: folder,
        conversation: conversation(workspace),
        source: "manual",
        pinned: true,
      });
      for (let index = 0; index < 4; index += 1) {
        await fs.writeFile(join(workspace, "state.txt"), `${index}\n`);
        await store.snapshot({
          workspace: folder,
          conversation: conversation(workspace),
          source: "manual",
        });
      }
      const listed = await store.list({
        workspace: folder,
        threadId: base.ompSessionId,
        limit: 100,
      });
      expect(listed.snapshots.some((snapshot) => snapshot.snapshotId === base.snapshotId)).toBe(
        true,
      );
      expect(listed.snapshots.length).toBeLessThanOrEqual(3);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(appData, { recursive: true, force: true });
    }
  });
  test("rejects a stale restore plan without changing the workspace", async () => {
    const workspace = await tempRoot("stale");
    const appData = await tempRoot("stale-data");
    await fs.writeFile(join(workspace, "state.txt"), "initial\n");
    try {
      const store = new CheckpointStoreService({ appDataDir: appData });
      const folder = FolderPath.parse(workspace);
      const snapshot = await store.snapshot({
        workspace: folder,
        conversation: conversation(workspace),
        source: "manual",
      });
      await fs.writeFile(join(workspace, "state.txt"), "planned\n");
      const plan = await store.planRestore({
        workspace: folder,
        operation: "files-only",
        snapshotId: snapshot.snapshotId,
        currentConversation: conversation(workspace),
        targetConversation: null,
        expectedWorkspaceHash: snapshot.workspaceHash,
      });
      await fs.writeFile(join(workspace, "state.txt"), "changed-after-plan\n");
      const before = await treeState(workspace);
      let rejection: unknown;
      try {
        await store.restore({ planId: plan.planId, confirmed: true });
      } catch (error) {
        rejection = error;
      }
      expect(rejection).toBeInstanceOf(AppFailure);
      expect((rejection as AppFailure).appError.code).toBe("conflict");
      expect(await treeState(workspace)).toBe(before);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(appData, { recursive: true, force: true });
    }
  });

  test("restores the exact pre-restore tree through the undo snapshot", async () => {
    const workspace = await tempRoot("undo");
    const appData = await tempRoot("undo-data");
    await fs.writeFile(join(workspace, "text.txt"), "before\n");
    await fs.writeFile(join(workspace, "binary.bin"), Buffer.from([0, 1, 2, 255]));
    await fs.writeFile(join(workspace, "deleted.txt"), "delete me\n");
    try {
      const store = new CheckpointStoreService({ appDataDir: appData });
      const folder = FolderPath.parse(workspace);
      const target = await store.snapshot({
        workspace: folder,
        conversation: conversation(workspace),
        source: "manual",
      });
      await fs.writeFile(join(workspace, "text.txt"), "after\n");
      await fs.writeFile(join(workspace, "binary.bin"), Buffer.from([255, 2, 1, 0]));
      await fs.writeFile(join(workspace, "created.txt"), "created after snapshot\n");
      await fs.rm(join(workspace, "deleted.txt"));
      const beforeRestore = await treeState(workspace);
      const plan = await store.planRestore({
        workspace: folder,
        operation: "files-only",
        snapshotId: target.snapshotId,
        currentConversation: conversation(workspace),
        targetConversation: null,
        expectedWorkspaceHash: target.workspaceHash,
      });
      const restored = await store.restore({ planId: plan.planId, confirmed: true });
      if (restored.undoSnapshotId === null)
        throw new Error("Restore did not create an undo snapshot");
      expect(await fs.readFile(join(workspace, "text.txt"), "utf8")).toBe("before\n");
      expect(await fs.readFile(join(workspace, "binary.bin"))).toEqual(Buffer.from([0, 1, 2, 255]));
      expect(await fs.readFile(join(workspace, "deleted.txt"), "utf8")).toBe("delete me\n");
      await expect(fs.access(join(workspace, "created.txt"))).rejects.toBeDefined();
      const undoPlan = await store.planRestore({
        workspace: folder,
        operation: "files-only",
        snapshotId: restored.undoSnapshotId,
        currentConversation: conversation(workspace),
        targetConversation: null,
        expectedWorkspaceHash: target.workspaceHash,
      });
      const undone = await store.restore({ planId: undoPlan.planId, confirmed: true });
      expect(undone.filesRestored).toBe(true);
      expect(await treeState(workspace)).toBe(beforeRestore);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(appData, { recursive: true, force: true });
    }
  });

  test("expires plans and bounds pending plans per workspace", async () => {
    const workspace = await tempRoot("plans");
    const appData = await tempRoot("plans-data");
    try {
      const folder = FolderPath.parse(workspace);
      const expiring = new CheckpointStoreService({ appDataDir: appData, planTtlMs: 5 });
      const expiringPlan = await expiring.planRestore({
        workspace: folder,
        operation: "conversation-only",
        snapshotId: null,
        currentConversation: conversation(workspace),
        targetConversation: null,
        expectedWorkspaceHash: "",
      });
      await waitMs(15);
      let expiredError: unknown;
      try {
        await expiring.restore({ planId: expiringPlan.planId, confirmed: true });
      } catch (error) {
        expiredError = error;
      }
      expect(expiredError).toBeInstanceOf(AppFailure);
      expect((expiredError as AppFailure).appError.code).toBe("not_found");

      const bounded = new CheckpointStoreService({ appDataDir: appData });
      const plans = [];
      for (let index = 0; index < 21; index += 1) {
        plans.push(
          await bounded.planRestore({
            workspace: folder,
            operation: "conversation-only",
            snapshotId: null,
            currentConversation: conversation(workspace),
            targetConversation: null,
            expectedWorkspaceHash: "",
          }),
        );
      }
      const firstPlan = plans[0];
      if (firstPlan === undefined) throw new Error("Missing first plan");
      let boundedError: unknown;
      try {
        await bounded.restore({ planId: firstPlan.planId, confirmed: true });
      } catch (error) {
        boundedError = error;
      }
      expect(boundedError).toBeInstanceOf(AppFailure);
      expect((boundedError as AppFailure).appError.code).toBe("not_found");
      const latestPlan = plans.at(-1);
      if (latestPlan === undefined) throw new Error("Missing latest plan");
      expect(
        (await bounded.restore({ planId: latestPlan.planId, confirmed: true }))
          .conversationRestored,
      ).toBe(true);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(appData, { recursive: true, force: true });
    }
  });

  test("reports a typed failure when shadow git cannot start", async () => {
    const workspace = await tempRoot("missing-git");
    const appData = await tempRoot("missing-git-data");
    try {
      const store = new CheckpointStoreService({
        appDataDir: appData,
        gitBinary: join(workspace, "missing-git"),
      });
      let rejection: unknown;
      try {
        await store.snapshot({
          workspace: FolderPath.parse(workspace),
          conversation: conversation(workspace),
          source: "manual",
        });
      } catch (error) {
        rejection = error;
      }
      expect(rejection).toBeInstanceOf(AppFailure);
      expect((rejection as AppFailure).appError.code).toBe("internal");
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(appData, { recursive: true, force: true });
    }
  });

  /** The records file a chat's checkpoints are kept in: the one file under the app data folder. */
  async function recordsFileUnder(appData: string): Promise<string> {
    const found: string[] = [];
    async function walk(directory: string): Promise<void> {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const absolute = join(directory, entry.name);
        if (entry.isDirectory()) await walk(absolute);
        else if (entry.name === "records.jsonl") found.push(absolute);
      }
    }
    await walk(appData);
    const [only] = found;
    if (found.length !== 1 || only === undefined) {
      throw new Error(`Expected one records file, found ${found.length}.`);
    }
    return only;
  }

  test("a record that cannot be read is skipped and kept in the file, and history survives", async () => {
    const workspace = await tempRoot("damaged-record");
    const appData = await tempRoot("damaged-record-data");
    const reported: string[] = [];
    try {
      const store = new CheckpointStoreService({
        appDataDir: appData,
        onError: (error) => reported.push(error.appError.message),
      });
      const folder = FolderPath.parse(workspace);
      const checkpoint = () =>
        store.snapshot({
          workspace: folder,
          conversation: conversation(workspace),
          source: "manual",
        });
      await fs.writeFile(join(workspace, "state.txt"), "0\n");
      const first = await checkpoint();
      await fs.writeFile(join(workspace, "state.txt"), "1\n");
      const second = await checkpoint();
      await fs.writeFile(join(workspace, "state.txt"), "2\n");
      const third = await checkpoint();
      // A record another version of the app wrote: one field this version does not know.
      const recordsPath = await recordsFileUnder(appData);
      const lines = (await fs.readFile(recordsPath, "utf8")).split("\n").filter(Boolean);
      const [firstLine] = lines;
      if (firstLine === undefined) throw new Error("No checkpoint was written.");
      const damaged = JSON.stringify({ ...JSON.parse(firstLine), renamedField: true });
      await fs.writeFile(recordsPath, `${[...lines, damaged].join("\n")}\n`);

      const fourth = await checkpoint();
      const written = (await fs.readFile(recordsPath, "utf8")).split("\n").filter(Boolean);
      expect(written).toHaveLength(5);
      expect(written[3]).toBe(damaged);
      expect(written.at(-1)).toContain(fourth.snapshotId);
      expect(fourth.parentSnapshotId).toBe(third.snapshotId);
      const listed = await store.list({
        workspace: folder,
        threadId: first.ompSessionId,
        limit: 100,
      });
      expect(listed.snapshots.map((item) => item.snapshotId)).toEqual([
        first.snapshotId,
        second.snapshotId,
        third.snapshotId,
        fourth.snapshotId,
      ]);
      expect(reported.some((text) => text.includes(recordsPath) && text.includes("line 4"))).toBe(
        true,
      );
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(appData, { recursive: true, force: true });
    }
  });

  test("a records file that cannot be read is an error, not an empty history, and is left alone", async () => {
    const workspace = await tempRoot("unreadable-records");
    const appData = await tempRoot("unreadable-records-data");
    try {
      const store = new CheckpointStoreService({ appDataDir: appData });
      const folder = FolderPath.parse(workspace);
      const checkpoint = () =>
        store.snapshot({
          workspace: folder,
          conversation: conversation(workspace),
          source: "manual",
        });
      await fs.writeFile(join(workspace, "state.txt"), "0\n");
      const taken = await checkpoint();
      // The records file is replaced by a folder, so it cannot be read at all.
      const recordsPath = await recordsFileUnder(appData);
      await fs.rm(recordsPath);
      await fs.mkdir(recordsPath);
      await expect(
        store.list({ workspace: folder, threadId: taken.ompSessionId, limit: 100 }),
      ).rejects.toBeInstanceOf(AppFailure);
      await expect(checkpoint()).rejects.toBeInstanceOf(AppFailure);
      expect((await fs.stat(recordsPath)).isDirectory()).toBe(true);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(appData, { recursive: true, force: true });
    }
  });

  test("pruning drops old records that can be read and keeps a line that cannot", async () => {
    const workspace = await tempRoot("damaged-prune");
    const appData = await tempRoot("damaged-prune-data");
    try {
      const store = new CheckpointStoreService({ appDataDir: appData, maxSnapshots: 2 });
      const folder = FolderPath.parse(workspace);
      const checkpoint = () =>
        store.snapshot({
          workspace: folder,
          conversation: conversation(workspace),
          source: "manual",
        });
      for (const value of ["0", "1", "2"]) {
        await fs.writeFile(join(workspace, "state.txt"), `${value}\n`);
        await checkpoint();
      }
      const recordsPath = await recordsFileUnder(appData);
      const lines = (await fs.readFile(recordsPath, "utf8")).split("\n").filter(Boolean);
      const damaged = '{"from":"another version"}';
      await fs.writeFile(recordsPath, `${[...lines, damaged].join("\n")}\n`);
      await fs.writeFile(join(workspace, "state.txt"), "3\n");
      const newest = await checkpoint();
      // Only the newest two readable records remain; the line that cannot be read stays where it was.
      const kept = (await fs.readFile(recordsPath, "utf8")).split("\n").filter(Boolean);
      expect(kept).toHaveLength(3);
      expect(kept[1]).toBe(damaged);
      expect(kept.at(-1)).toContain(newest.snapshotId);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(appData, { recursive: true, force: true });
    }
  });
});

describe("CheckpointStore and git-ignored files", () => {
  async function shadowTreeNames(
    appData: string,
    record: { workspaceKey: string; ompSessionId: string; shadowTreeId: string },
  ): Promise<string[]> {
    const gitDir = join(
      appData,
      "checkpoints",
      record.workspaceKey,
      record.ompSessionId,
      "shadow-git",
    );
    const child = Bun.spawn({
      cmd: ["git", "--git-dir", gitDir, "ls-tree", "-r", "-z", "--name-only", record.shadowTreeId],
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    if (code !== 0) throw new Error("git ls-tree failed");
    return stdout
      .split("\0")
      .filter((entry) => entry !== "")
      .sort();
  }

  test("never captures, deletes or overwrites ignored files, and undo keeps them", async () => {
    const workspace = await tempRoot("ignored");
    const appData = await tempRoot("ignored-data");
    try {
      await fs.writeFile(join(workspace, ".gitignore"), "data/\n.venv/\ntarget/\n*.log\n");
      await fs.writeFile(join(workspace, "a.txt"), "one\n");
      await fs.mkdir(join(workspace, "src"));
      await fs.writeFile(join(workspace, "src", "keep.ts"), "keep\n");
      await fs.writeFile(join(workspace, "src", "gen.log"), "generated\n");
      await fs.mkdir(join(workspace, ".venv", "lib"), { recursive: true });
      await fs.writeFile(join(workspace, ".venv", "lib", "x.py"), "venv\n");
      const store = new CheckpointStoreService({ appDataDir: appData });
      const folder = FolderPath.parse(workspace);
      const checkpoint = await store.snapshot({
        workspace: folder,
        conversation: conversation(workspace),
        source: "manual",
      });
      const included = checkpoint.includedPaths.map((item) => item.path);
      expect(included).toEqual([".gitignore", "a.txt", "src/keep.ts"]);
      expect(checkpoint.excludedPaths.map((item) => item.path).sort()).toEqual([
        ".venv",
        "src/gen.log",
      ]);
      expect(await shadowTreeNames(appData, checkpoint)).toEqual(included);

      await fs.mkdir(join(workspace, "data"));
      await fs.writeFile(join(workspace, "data", "app.db"), "database\n");
      await fs.writeFile(join(workspace, ".venv", "lib", "y.py"), "new venv\n");
      await fs.mkdir(join(workspace, "target", "debug"), { recursive: true });
      await fs.writeFile(join(workspace, "target", "debug", "app"), "build\n");
      await fs.writeFile(join(workspace, "src", "new.log"), "new log\n");
      await fs.writeFile(join(workspace, "a.txt"), "two\n");

      const plan = await store.planRestore({
        workspace: folder,
        operation: "files-only",
        snapshotId: checkpoint.snapshotId,
        currentConversation: conversation(workspace),
        targetConversation: null,
        expectedWorkspaceHash: checkpoint.workspaceHash,
      });
      expect(plan.includedPaths.map((item) => item.path)).toEqual(included);
      expect(plan.capturedPathCount).toBe(1);
      expect(plan.requiresConfirmation).toBe(true);
      expect(plan.excludedPaths.map((item) => item.path)).toContain("data");

      const restored = await store.restore({ planId: plan.planId, confirmed: true });
      expect(restored.filesRestored).toBe(true);
      expect(await fs.readFile(join(workspace, "a.txt"), "utf8")).toBe("one\n");
      expect(await fs.readFile(join(workspace, "data", "app.db"), "utf8")).toBe("database\n");
      expect(await fs.readFile(join(workspace, ".venv", "lib", "x.py"), "utf8")).toBe("venv\n");
      expect(await fs.readFile(join(workspace, "target", "debug", "app"), "utf8")).toBe("build\n");
      expect(await fs.readFile(join(workspace, "src", "new.log"), "utf8")).toBe("new log\n");
      expect(await fs.readFile(join(workspace, ".venv", "lib", "y.py"), "utf8")).toBe("new venv\n");
      if (restored.undoSnapshotId === null)
        throw new Error("Restore did not create an undo snapshot");

      const undoPlan = await store.planRestore({
        workspace: folder,
        operation: "files-only",
        snapshotId: restored.undoSnapshotId,
        currentConversation: conversation(workspace),
        targetConversation: null,
        expectedWorkspaceHash: checkpoint.workspaceHash,
      });
      const undone = await store.restore({ planId: undoPlan.planId, confirmed: true });
      expect(undone.filesRestored).toBe(true);
      expect(await fs.readFile(join(workspace, "a.txt"), "utf8")).toBe("two\n");
      expect(await fs.readFile(join(workspace, "data", "app.db"), "utf8")).toBe("database\n");
      expect(await fs.readFile(join(workspace, ".venv", "lib", "x.py"), "utf8")).toBe("venv\n");
      expect(await fs.readFile(join(workspace, "target", "debug", "app"), "utf8")).toBe("build\n");
      expect(await fs.readFile(join(workspace, "src", "new.log"), "utf8")).toBe("new log\n");
      expect(await fs.readFile(join(workspace, ".venv", "lib", "y.py"), "utf8")).toBe("new venv\n");
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(appData, { recursive: true, force: true });
    }
  });

  test("a restore never deletes a file that a later ignore rule now covers", async () => {
    const workspace = await tempRoot("tracked-ignored");
    const appData = await tempRoot("tracked-ignored-data");
    try {
      await fs.writeFile(join(workspace, ".gitignore"), "\n");
      await fs.writeFile(join(workspace, "a.txt"), "one\n");
      const store = new CheckpointStoreService({ appDataDir: appData });
      const folder = FolderPath.parse(workspace);
      const older = await store.snapshot({
        workspace: folder,
        conversation: conversation(workspace),
        source: "manual",
      });
      await fs.writeFile(join(workspace, "cache.bin"), "cache\n");
      await store.snapshot({
        workspace: folder,
        conversation: conversation(workspace),
        source: "manual",
      });
      await fs.writeFile(join(workspace, ".gitignore"), "cache.bin\n");

      const plan = await store.planRestore({
        workspace: folder,
        operation: "files-only",
        snapshotId: older.snapshotId,
        currentConversation: conversation(workspace),
        targetConversation: null,
        expectedWorkspaceHash: older.workspaceHash,
      });
      expect(plan.capturedPathCount).toBe(1);
      const restored = await store.restore({ planId: plan.planId, confirmed: true });
      expect(restored.filesRestored).toBe(true);
      expect(await fs.readFile(join(workspace, ".gitignore"), "utf8")).toBe("\n");
      expect(await fs.readFile(join(workspace, "cache.bin"), "utf8")).toBe("cache\n");
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(appData, { recursive: true, force: true });
    }
  });

  test("restoring a checkpoint from another conversation never deletes a file the workspace now ignores", async () => {
    const workspace = await tempRoot("other-conversation");
    const appData = await tempRoot("other-conversation-data");
    try {
      await fs.writeFile(join(workspace, ".gitignore"), "\n");
      await fs.writeFile(join(workspace, "a.txt"), "one\n");
      const store = new CheckpointStoreService({ appDataDir: appData });
      const folder = FolderPath.parse(workspace);
      const older = await store.snapshot({
        workspace: folder,
        conversation: conversation(workspace),
        source: "manual",
      });
      await fs.writeFile(join(workspace, "cache.bin"), "cache\n");
      await store.snapshot({
        workspace: folder,
        conversation: conversation(workspace),
        source: "manual",
      });
      await fs.writeFile(join(workspace, ".gitignore"), "cache.bin\n");

      const otherConversation = {
        ...conversation(workspace),
        threadId: ThreadId.parse("thread-other"),
      };
      const plan = await store.planRestore({
        workspace: folder,
        operation: "files-only",
        snapshotId: older.snapshotId,
        currentConversation: otherConversation,
        targetConversation: null,
        expectedWorkspaceHash: older.workspaceHash,
      });
      await store.restore({ planId: plan.planId, confirmed: true });
      expect(await fs.readFile(join(workspace, ".gitignore"), "utf8")).toBe("\n");
      expect(await fs.readFile(join(workspace, "cache.bin"), "utf8")).toBe("cache\n");
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(appData, { recursive: true, force: true });
    }
  });

  test("refuses a restore that would overwrite an ignored file, and changes nothing", async () => {
    const workspace = await tempRoot("overwrite");
    const appData = await tempRoot("overwrite-data");
    try {
      await fs.writeFile(join(workspace, ".gitignore"), "\n");
      await fs.writeFile(join(workspace, "a.txt"), "one\n");
      await fs.writeFile(join(workspace, "keep.bin"), "kept\n");
      const store = new CheckpointStoreService({ appDataDir: appData });
      const folder = FolderPath.parse(workspace);
      const checkpoint = await store.snapshot({
        workspace: folder,
        conversation: conversation(workspace),
        source: "manual",
      });
      await fs.writeFile(join(workspace, ".gitignore"), "keep.bin\n");
      await fs.writeFile(join(workspace, "keep.bin"), "edited\n");
      await fs.writeFile(join(workspace, "a.txt"), "two\n");
      const planArgs = {
        workspace: folder,
        operation: "files-only" as const,
        snapshotId: checkpoint.snapshotId,
        currentConversation: conversation(workspace),
        targetConversation: null,
        expectedWorkspaceHash: checkpoint.workspaceHash,
      };

      let rejection: unknown;
      try {
        await store.planRestore(planArgs);
      } catch (error) {
        rejection = error;
      }
      expect(rejection).toBeInstanceOf(AppFailure);
      expect((rejection as AppFailure).appError.code).toBe("conflict");
      expect((rejection as AppFailure).appError.message).toContain("keep.bin");
      expect(await fs.readFile(join(workspace, "keep.bin"), "utf8")).toBe("edited\n");
      expect(await fs.readFile(join(workspace, "a.txt"), "utf8")).toBe("two\n");

      await fs.rm(join(workspace, "keep.bin"));
      const plan = await store.planRestore(planArgs);
      await store.restore({ planId: plan.planId, confirmed: true });
      expect(await fs.readFile(join(workspace, "keep.bin"), "utf8")).toBe("kept\n");
      expect(await fs.readFile(join(workspace, "a.txt"), "utf8")).toBe("one\n");
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(appData, { recursive: true, force: true });
    }
  });

  test("honours the person's global git ignore file", async () => {
    const workspace = await tempRoot("global-ignore");
    const appData = await tempRoot("global-ignore-data");
    const globalConfig = await tempRoot("global-config");
    const previous = process.env.GIT_CONFIG_GLOBAL;
    try {
      await fs.writeFile(join(globalConfig, "ignore"), "*.local\n");
      await fs.writeFile(
        join(globalConfig, "gitconfig"),
        `[core]\n\texcludesFile = ${join(globalConfig, "ignore")}\n`,
      );
      process.env.GIT_CONFIG_GLOBAL = join(globalConfig, "gitconfig");
      await fs.writeFile(join(workspace, "a.txt"), "one\n");
      await fs.writeFile(join(workspace, "notes.local"), "notes\n");
      const store = new CheckpointStoreService({ appDataDir: appData });
      const folder = FolderPath.parse(workspace);
      const checkpoint = await store.snapshot({
        workspace: folder,
        conversation: conversation(workspace),
        source: "manual",
      });
      expect(checkpoint.includedPaths.map((item) => item.path)).toEqual(["a.txt"]);
      expect(checkpoint.excludedPaths.map((item) => item.path)).toEqual(["notes.local"]);

      await fs.writeFile(join(workspace, "scratch.local"), "scratch\n");
      await fs.writeFile(join(workspace, "a.txt"), "two\n");
      const plan = await store.planRestore({
        workspace: folder,
        operation: "files-only",
        snapshotId: checkpoint.snapshotId,
        currentConversation: conversation(workspace),
        targetConversation: null,
        expectedWorkspaceHash: checkpoint.workspaceHash,
      });
      expect(plan.capturedPathCount).toBe(1);
      await store.restore({ planId: plan.planId, confirmed: true });
      expect(await fs.readFile(join(workspace, "scratch.local"), "utf8")).toBe("scratch\n");
      expect(await fs.readFile(join(workspace, "a.txt"), "utf8")).toBe("one\n");
    } finally {
      if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = previous;
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(appData, { recursive: true, force: true });
      await fs.rm(globalConfig, { recursive: true, force: true });
    }
  });

  test("a checkpoint recorded with ignored files lists only what its tree holds", async () => {
    const workspace = await tempRoot("legacy-record");
    const appData = await tempRoot("legacy-record-data");
    try {
      await fs.writeFile(join(workspace, ".gitignore"), "data/\n");
      await fs.writeFile(join(workspace, "a.txt"), "one\n");
      const store = new CheckpointStoreService({ appDataDir: appData });
      const folder = FolderPath.parse(workspace);
      const checkpoint = await store.snapshot({
        workspace: folder,
        conversation: conversation(workspace),
        source: "manual",
      });
      // Earlier builds listed every file in the record, ignored or not. Rewrite this record that way.
      const recordsPath = join(
        appData,
        "checkpoints",
        checkpoint.workspaceKey,
        checkpoint.ompSessionId,
        "records.jsonl",
      );
      const [record] = (await fs.readFile(recordsPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { includedPaths: unknown[] });
      if (record === undefined) throw new Error("No checkpoint record was written");
      record.includedPaths.push({
        path: "data/app.db",
        kind: "file",
        mode: 420,
        hash: "a".repeat(64),
        sizeBytes: 9,
      });
      await fs.writeFile(recordsPath, `${JSON.stringify(record)}\n`);
      await fs.mkdir(join(workspace, "data"));
      await fs.writeFile(join(workspace, "data", "app.db"), "database\n");

      const diff = await store.diff({ workspace: folder, snapshotId: checkpoint.snapshotId });
      expect(diff.entries).toEqual([]);
      const plan = await store.planRestore({
        workspace: folder,
        operation: "files-only",
        snapshotId: checkpoint.snapshotId,
        currentConversation: conversation(workspace),
        targetConversation: null,
        expectedWorkspaceHash: checkpoint.workspaceHash,
      });
      expect(plan.includedPaths.map((item) => item.path)).toEqual([".gitignore", "a.txt"]);
      expect(plan.capturedPathCount).toBe(0);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(appData, { recursive: true, force: true });
    }
  });

  test("refuses a restore when an ignored file stands where the checkpoint holds a folder", async () => {
    const workspace = await tempRoot("ignored-file-in-the-way");
    const appData = await tempRoot("ignored-file-in-the-way-data");
    try {
      await fs.writeFile(join(workspace, ".gitignore"), "\n");
      await fs.mkdir(join(workspace, "dir"));
      await fs.writeFile(join(workspace, "dir", "x.txt"), "x\n");
      const store = new CheckpointStoreService({ appDataDir: appData });
      const folder = FolderPath.parse(workspace);
      const checkpoint = await store.snapshot({
        workspace: folder,
        conversation: conversation(workspace),
        source: "manual",
      });
      await fs.rm(join(workspace, "dir"), { recursive: true });
      await fs.writeFile(join(workspace, "dir"), "ignored file\n");
      await fs.writeFile(join(workspace, ".gitignore"), "dir\n");
      const planArgs = {
        workspace: folder,
        operation: "files-only" as const,
        snapshotId: checkpoint.snapshotId,
        currentConversation: conversation(workspace),
        targetConversation: null,
        expectedWorkspaceHash: checkpoint.workspaceHash,
      };

      let rejection: unknown;
      try {
        await store.planRestore(planArgs);
      } catch (error) {
        rejection = error;
      }
      expect(rejection).toBeInstanceOf(AppFailure);
      expect((rejection as AppFailure).appError.code).toBe("conflict");
      expect((rejection as AppFailure).appError.message).toContain("dir");
      expect(await fs.readFile(join(workspace, "dir"), "utf8")).toBe("ignored file\n");

      await fs.rm(join(workspace, "dir"));
      const plan = await store.planRestore(planArgs);
      await store.restore({ planId: plan.planId, confirmed: true });
      expect(await fs.readFile(join(workspace, "dir", "x.txt"), "utf8")).toBe("x\n");
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(appData, { recursive: true, force: true });
    }
  });

  test("refuses a restore when a folder holding ignored files stands where the checkpoint holds a file", async () => {
    const workspace = await tempRoot("ignored-folder-in-the-way");
    const appData = await tempRoot("ignored-folder-in-the-way-data");
    try {
      await fs.writeFile(join(workspace, ".gitignore"), "\n");
      await fs.writeFile(join(workspace, "pkg"), "old\n");
      await fs.writeFile(join(workspace, "a.txt"), "one\n");
      const store = new CheckpointStoreService({ appDataDir: appData });
      const folder = FolderPath.parse(workspace);
      const checkpoint = await store.snapshot({
        workspace: folder,
        conversation: conversation(workspace),
        source: "manual",
      });
      await fs.rm(join(workspace, "pkg"));
      await fs.mkdir(join(workspace, "pkg"));
      await fs.writeFile(join(workspace, "pkg", "cache.log"), "cache\n");
      await fs.writeFile(join(workspace, "pkg", "keep.ts"), "keep\n");
      await fs.writeFile(join(workspace, ".gitignore"), "*.log\n");

      let rejection: unknown;
      try {
        await store.planRestore({
          workspace: folder,
          operation: "files-only",
          snapshotId: checkpoint.snapshotId,
          currentConversation: conversation(workspace),
          targetConversation: null,
          expectedWorkspaceHash: checkpoint.workspaceHash,
        });
      } catch (error) {
        rejection = error;
      }
      expect(rejection).toBeInstanceOf(AppFailure);
      expect((rejection as AppFailure).appError.code).toBe("conflict");
      expect((rejection as AppFailure).appError.message).toContain("pkg");
      expect(await fs.readFile(join(workspace, "pkg", "cache.log"), "utf8")).toBe("cache\n");
      expect(await fs.readFile(join(workspace, "pkg", "keep.ts"), "utf8")).toBe("keep\n");
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(appData, { recursive: true, force: true });
    }
  });

  test("refuses a restore that would overwrite an ignored file inside an ignored folder", async () => {
    const workspace = await tempRoot("ignored-in-folder");
    const appData = await tempRoot("ignored-in-folder-data");
    try {
      await fs.writeFile(join(workspace, ".gitignore"), "\n");
      await fs.mkdir(join(workspace, "data"));
      await fs.writeFile(join(workspace, "data", "app.db"), "v1\n");
      const store = new CheckpointStoreService({ appDataDir: appData });
      const folder = FolderPath.parse(workspace);
      const checkpoint = await store.snapshot({
        workspace: folder,
        conversation: conversation(workspace),
        source: "manual",
      });
      await fs.writeFile(join(workspace, ".gitignore"), "data/\n");
      await fs.writeFile(join(workspace, "data", "app.db"), "v2\n");

      let rejection: unknown;
      try {
        await store.planRestore({
          workspace: folder,
          operation: "files-only",
          snapshotId: checkpoint.snapshotId,
          currentConversation: conversation(workspace),
          targetConversation: null,
          expectedWorkspaceHash: checkpoint.workspaceHash,
        });
      } catch (error) {
        rejection = error;
      }
      expect(rejection).toBeInstanceOf(AppFailure);
      expect((rejection as AppFailure).appError.code).toBe("conflict");
      expect((rejection as AppFailure).appError.message).toContain("data/app.db");
      expect(await fs.readFile(join(workspace, "data", "app.db"), "utf8")).toBe("v2\n");
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(appData, { recursive: true, force: true });
    }
  });

  test("refuses a restore when an ignored file sits where the checkpoint holds a path inside an ignored folder", async () => {
    const workspace = await tempRoot("ignored-file-blocks-path");
    const appData = await tempRoot("ignored-file-blocks-path-data");
    try {
      await fs.writeFile(join(workspace, ".gitignore"), "\n");
      await fs.mkdir(join(workspace, "data", "sub"), { recursive: true });
      await fs.writeFile(join(workspace, "data", "sub", "file.txt"), "x\n");
      const store = new CheckpointStoreService({ appDataDir: appData });
      const folder = FolderPath.parse(workspace);
      const checkpoint = await store.snapshot({
        workspace: folder,
        conversation: conversation(workspace),
        source: "manual",
      });
      await fs.rm(join(workspace, "data"), { recursive: true });
      await fs.mkdir(join(workspace, "data"));
      await fs.writeFile(join(workspace, "data", "sub"), "blocker\n");
      await fs.writeFile(join(workspace, ".gitignore"), "data/\n");

      let rejection: unknown;
      try {
        await store.planRestore({
          workspace: folder,
          operation: "files-only",
          snapshotId: checkpoint.snapshotId,
          currentConversation: conversation(workspace),
          targetConversation: null,
          expectedWorkspaceHash: checkpoint.workspaceHash,
        });
      } catch (error) {
        rejection = error;
      }
      expect(rejection).toBeInstanceOf(AppFailure);
      expect((rejection as AppFailure).appError.code).toBe("conflict");
      expect((rejection as AppFailure).appError.message).toContain("data/sub");
      expect(await fs.readFile(join(workspace, "data", "sub"), "utf8")).toBe("blocker\n");
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(appData, { recursive: true, force: true });
    }
  });

  function runGitIn(directory: string, args: string[]): void {
    const result = Bun.spawnSync({
      cmd: ["git", "-C", directory, ...args],
      stdout: "ignore",
      stderr: "pipe",
    });
    if (result.exitCode !== 0)
      throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  }

  function initNestedRepo(directory: string): void {
    runGitIn(directory, ["init", "-q"]);
    runGitIn(directory, [
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@localhost",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "init",
    ]);
  }

  test("leaves a nested git repository out of checkpoints, plans and restores", async () => {
    const workspace = await tempRoot("nested-repo");
    const appData = await tempRoot("nested-repo-data");
    try {
      await fs.writeFile(join(workspace, "a.txt"), "one\n");
      const store = new CheckpointStoreService({ appDataDir: appData });
      const folder = FolderPath.parse(workspace);
      const before = await store.snapshot({
        workspace: folder,
        conversation: conversation(workspace),
        source: "manual",
      });
      await fs.mkdir(join(workspace, "nested"));
      initNestedRepo(join(workspace, "nested"));
      await fs.writeFile(join(workspace, "nested", "x.txt"), "precious\n");

      const checkpoint = await store.snapshot({
        workspace: folder,
        conversation: conversation(workspace),
        source: "manual",
      });
      expect(checkpoint.includedPaths.map((item) => item.path)).toEqual(["a.txt"]);
      expect(checkpoint.excludedPaths.map((item) => item.path)).toContain("nested");
      expect(await shadowTreeNames(appData, checkpoint)).toEqual(["a.txt"]);

      await fs.writeFile(join(workspace, "a.txt"), "two\n");
      const plan = await store.planRestore({
        workspace: folder,
        operation: "files-only",
        snapshotId: before.snapshotId,
        currentConversation: conversation(workspace),
        targetConversation: null,
        expectedWorkspaceHash: before.workspaceHash,
      });
      expect(plan.excludedPaths.map((item) => item.path)).toContain("nested");
      const restored = await store.restore({ planId: plan.planId, confirmed: true });
      expect(restored.filesRestored).toBe(true);
      expect(await fs.readFile(join(workspace, "a.txt"), "utf8")).toBe("one\n");
      expect(await fs.readFile(join(workspace, "nested", "x.txt"), "utf8")).toBe("precious\n");
      if (restored.undoSnapshotId === null)
        throw new Error("Restore did not create an undo snapshot");

      const undoPlan = await store.planRestore({
        workspace: folder,
        operation: "files-only",
        snapshotId: restored.undoSnapshotId,
        currentConversation: conversation(workspace),
        targetConversation: null,
        expectedWorkspaceHash: before.workspaceHash,
      });
      await store.restore({ planId: undoPlan.planId, confirmed: true });
      expect(await fs.readFile(join(workspace, "a.txt"), "utf8")).toBe("two\n");
      expect(await fs.readFile(join(workspace, "nested", "x.txt"), "utf8")).toBe("precious\n");
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(appData, { recursive: true, force: true });
    }
  });

  test("refuses a restore that would replace a nested git repository with a file", async () => {
    const workspace = await tempRoot("nested-repo-in-the-way");
    const appData = await tempRoot("nested-repo-in-the-way-data");
    try {
      await fs.writeFile(join(workspace, "nested"), "old\n");
      const store = new CheckpointStoreService({ appDataDir: appData });
      const folder = FolderPath.parse(workspace);
      const checkpoint = await store.snapshot({
        workspace: folder,
        conversation: conversation(workspace),
        source: "manual",
      });
      await fs.rm(join(workspace, "nested"));
      await fs.mkdir(join(workspace, "nested"));
      initNestedRepo(join(workspace, "nested"));
      await fs.writeFile(join(workspace, "nested", "x.txt"), "precious\n");

      let rejection: unknown;
      try {
        await store.planRestore({
          workspace: folder,
          operation: "files-only",
          snapshotId: checkpoint.snapshotId,
          currentConversation: conversation(workspace),
          targetConversation: null,
          expectedWorkspaceHash: checkpoint.workspaceHash,
        });
      } catch (error) {
        rejection = error;
      }
      expect(rejection).toBeInstanceOf(AppFailure);
      expect((rejection as AppFailure).appError.code).toBe("conflict");
      expect((rejection as AppFailure).appError.message).toContain("nested");
      expect(await fs.readFile(join(workspace, "nested", "x.txt"), "utf8")).toBe("precious\n");
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(appData, { recursive: true, force: true });
    }
  });

  test("a checkpoint that holds a nested repository's reference restores while that repository is in the workspace", async () => {
    const workspace = await tempRoot("gitlink-restore");
    const appData = await tempRoot("gitlink-restore-data");
    try {
      await fs.writeFile(join(workspace, "a.txt"), "one\n");
      const store = new CheckpointStoreService({ appDataDir: appData });
      const folder = FolderPath.parse(workspace);
      const checkpoint = await store.snapshot({
        workspace: folder,
        conversation: conversation(workspace),
        source: "manual",
      });
      await fs.mkdir(join(workspace, "nested"));
      initNestedRepo(join(workspace, "nested"));
      await fs.writeFile(join(workspace, "nested", "x.txt"), "precious\n");

      // Checkpoints taken before nested repositories were left out stored one reference to each: a commit entry.
      // Rewrite this checkpoint's tree that way, with the nested repository's commit at its path.
      const root = join(appData, "checkpoints", checkpoint.workspaceKey, checkpoint.ompSessionId);
      const index = join(root, "gitlink-index");
      const shadowGit = (args: string[]): string => {
        const result = Bun.spawnSync({
          cmd: ["git", ...args],
          env: { ...process.env, GIT_DIR: join(root, "shadow-git"), GIT_INDEX_FILE: index },
          stdout: "pipe",
          stderr: "pipe",
        });
        if (result.exitCode !== 0)
          throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
        return result.stdout.toString().trim();
      };
      const nestedHead = Bun.spawnSync({
        cmd: ["git", "-C", join(workspace, "nested"), "rev-parse", "HEAD"],
        stdout: "pipe",
        stderr: "pipe",
      })
        .stdout.toString()
        .trim();
      const recordsPath = join(root, "records.jsonl");
      const [record] = (await fs.readFile(recordsPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { shadowTreeId: string });
      if (record === undefined) throw new Error("No checkpoint record was written");
      shadowGit(["read-tree", record.shadowTreeId]);
      shadowGit(["update-index", "--add", "--cacheinfo", `160000,${nestedHead},nested`]);
      record.shadowTreeId = shadowGit(["write-tree"]);
      await fs.writeFile(recordsPath, `${JSON.stringify(record)}\n`);

      await fs.writeFile(join(workspace, "a.txt"), "two\n");
      const plan = await store.planRestore({
        workspace: folder,
        operation: "files-only",
        snapshotId: checkpoint.snapshotId,
        currentConversation: conversation(workspace),
        targetConversation: null,
        expectedWorkspaceHash: checkpoint.workspaceHash,
      });
      expect(plan.excludedPaths.map((item) => item.path)).toContain("nested");
      const restored = await store.restore({ planId: plan.planId, confirmed: true });
      expect(restored.filesRestored).toBe(true);
      expect(await fs.readFile(join(workspace, "a.txt"), "utf8")).toBe("one\n");
      expect(await fs.readFile(join(workspace, "nested", "x.txt"), "utf8")).toBe("precious\n");
      // The nested repository itself is untouched: its own .git is still there and still points at the same commit.
      expect((await fs.stat(join(workspace, "nested", ".git"))).isDirectory()).toBe(true);
      const headAfter = Bun.spawnSync({
        cmd: ["git", "-C", join(workspace, "nested"), "rev-parse", "HEAD"],
        stdout: "pipe",
        stderr: "pipe",
      })
        .stdout.toString()
        .trim();
      expect(headAfter).toBe(nestedHead);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
      await fs.rm(appData, { recursive: true, force: true });
    }
  });
});
