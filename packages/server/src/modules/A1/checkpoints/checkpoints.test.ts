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
});
