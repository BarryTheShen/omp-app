import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IdmapMounter, mountsBelow, type SharedFolder, SharedFolders } from "./shared";

const cleanups: string[] = [];
afterEach(async () => {
  for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function folder(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "omp-shared-"));
  cleanups.push(dir);
  return dir;
}

const workspace: SharedFolder = {
  path: "/home/p/workspace",
  place: "workspace",
  write: false,
  server: "https://server.example:8445",
  grantedAt: "2026-11-19T20:00:00.000Z",
};

describe("shared folders (PLAN §7d)", () => {
  test("the list is kept across starts, root's alone; a folder granted again replaces its entry; Remove takes it off", async () => {
    const file = join(await folder(), "state", "shared.json");
    const first = new SharedFolders(file);
    expect(await first.list()).toEqual([]);
    await first.add(workspace);
    await first.add({ ...workspace, write: true });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const again = new SharedFolders(file);
    expect(await again.list()).toEqual([{ ...workspace, write: true }]);
    expect(await again.remove("/home/p/other")).toBe(false);
    expect(await again.remove(workspace.path)).toBe(true);
    expect(await new SharedFolders(file).list()).toEqual([]);
  });

  test("a file that is not the list counts as no folders shared", async () => {
    const file = join(await folder(), "shared.json");
    await writeFile(file, '{"version":1,"folders":[{"path":"relative"}]}');
    expect(await new SharedFolders(file).list()).toEqual([]);
    await writeFile(file, "not json");
    expect(await new SharedFolders(file).list()).toEqual([]);
  });

  test("a mount maps the person's ids to the agent's, read only unless written, never setuid or devices", async () => {
    const calls: string[][] = [];
    const mounter = new IdmapMounter(
      { uid: 1001, gid: 1002 },
      { uid: 983, gid: 983 },
      async (argv) => {
        calls.push([...argv]);
        return { code: 0, stderr: "" };
      },
    );
    const target = join(await folder(), "shared", "workspace");
    expect(await mounter.mount("/home/p/workspace", target, false)).toBeNull();
    expect(calls[0]).toEqual([
      "mount",
      "--bind",
      "-o",
      "X-mount.idmap=u:1001:983:1 g:1002:983:1,nosuid,nodev,ro",
      "/home/p/workspace",
      target,
    ]);
    expect(mounter.argv("/a", "/b", true)[3]).toBe(
      "X-mount.idmap=u:1001:983:1 g:1002:983:1,nosuid,nodev",
    );
    await mounter.unmount(target);
    expect(calls[1]).toEqual(["umount", "--lazy", target]);
    await expect(stat(target)).rejects.toThrow();
  });

  test("a mount that fails says why and leaves no mount point", async () => {
    const mounter = new IdmapMounter({ uid: 1, gid: 1 }, { uid: 2, gid: 2 }, async () => ({
      code: 32,
      stderr: "mount: wrong fs type\n",
    }));
    const target = join(await folder(), "shared", "x");
    expect(await mounter.mount("/home/p/x", target, true)).toBe("mount: wrong fs type");
    await expect(stat(target)).rejects.toThrow();
  });

  test("what is mounted below the shared folder is found, deepest first, with escaped names read back", () => {
    const mountinfo = [
      "22 1 8:2 / / rw,relatime shared:1 - ext4 /dev/sda2 rw",
      "90 22 8:2 /home/p/workspace /run/omp-app-device/shared/workspace rw - ext4 /dev/sda2 rw",
      "91 22 8:2 /home/p/My\\040Notes /run/omp-app-device/shared/My\\040Notes/deep\\040er rw - ext4 /dev/sda2 rw",
      "92 22 0:5 / /run/omp-app-device rw - tmpfs tmpfs rw",
      "93 22 8:2 /x /run/omp-app-device/shared-other rw - ext4 /dev/sda2 rw",
    ].join("\n");
    expect(mountsBelow(mountinfo, "/run/omp-app-device/shared")).toEqual([
      "/run/omp-app-device/shared/My Notes/deep er",
      "/run/omp-app-device/shared/workspace",
    ]);
  });
});
