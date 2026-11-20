/**
 * The person's shared folders (#20, PLAN §7d): the folders they allowed agents to reach, kept by the guard (root) in its
 * state folder, and mounted under the guard's root-owned shared folder while access is on.
 *
 * A mount is an id-mapped bind mount: the person's files show as the agent account's inside it, and what the agent
 * writes there is stored as the person's. `X-mount.idmap=u:<person uid>:<agent uid>:1 g:<person gid>:<agent gid>:1`, as
 * checked on Ubuntu 26.04 (util-linux 2.41, kernel 7.0); the other order shows the files as nobody's and refuses writes.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rmdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

export const SharedFolder = z.strictObject({
  /** The folder's real path in the person's home. */
  path: z.string().startsWith("/"),
  /** Its place below the person's home, which names where the agent reaches it (`sharedAt`). */
  place: z.string().min(1),
  /** Read and write, or read only. */
  write: z.boolean(),
  /** The server whose agent asked for it. */
  server: z.string().max(260).nullable(),
  grantedAt: z.string(),
});
export type SharedFolder = z.infer<typeof SharedFolder>;

const SharedFile = z.strictObject({ version: z.literal(1), folders: z.array(SharedFolder) });

/** The list, in `<state folder>/shared.json` (mode 600, root's); a file that cannot be read counts as none. */
export class SharedFolders {
  readonly #file: string;
  #folders: SharedFolder[] | null = null;

  constructor(file: string) {
    this.#file = file;
  }

  async list(): Promise<readonly SharedFolder[]> {
    if (this.#folders === null) {
      try {
        this.#folders = SharedFile.parse(JSON.parse(await readFile(this.#file, "utf8"))).folders;
      } catch {
        this.#folders = [];
      }
    }
    return this.#folders;
  }

  /** Adds a folder, or changes one shared already (another mode, a later grant). */
  async add(folder: SharedFolder): Promise<void> {
    const kept = (await this.list()).filter((each) => each.path !== folder.path);
    await this.#save([...kept, folder]);
  }

  /** Takes a folder off the list; whether it was on it. */
  async remove(path: string): Promise<boolean> {
    const before = await this.list();
    const after = before.filter((each) => each.path !== path);
    if (after.length === before.length) return false;
    await this.#save(after);
    return true;
  }

  async clear(): Promise<void> {
    await this.#save([]);
  }

  async #save(folders: SharedFolder[]): Promise<void> {
    await mkdir(dirname(this.#file), { recursive: true, mode: 0o700 });
    const temporary = `${this.#file}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ version: 1, folders })}\n`, { mode: 0o600 });
    await rename(temporary, this.#file);
    this.#folders = folders;
  }
}

/** Mounts and unmounts shared folders: the system's `mount`, or a stand-in in tests. */
export interface FolderMounter {
  /** Mounts `source` at `target`; null once mounted, else why not. */
  mount(source: string, target: string, write: boolean): Promise<string | null>;
  /** Unmounts `target` (lazily, so a session inside it never holds it) and removes its mount point. */
  unmount(target: string): Promise<void>;
  /** What is mounted below `root` now, deepest first: also what a crash left. */
  mounted(root: string): Promise<string[]>;
}

/**
 * The mount points in a mountinfo file's text (`/proc/self/mountinfo`) below `root`, deepest first. A mount point is
 * the fifth field, with space, tab, newline and backslash written as octal escapes.
 */
export function mountsBelow(mountinfo: string, root: string): string[] {
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return mountinfo
    .split("\n")
    .map((line) => line.split(" ")[4])
    .filter((field): field is string => field !== undefined)
    .map((field) =>
      field.replace(/\\([0-7]{3})/g, (_, octal: string) =>
        String.fromCharCode(Number.parseInt(octal, 8)),
      ),
    )
    .filter((point) => point.startsWith(prefix))
    .sort((a, b) => b.length - a.length);
}

export interface Ids {
  readonly uid: number;
  readonly gid: number;
}

/** A command's exit status and what it said on stderr. */
export type Run = (argv: readonly string[]) => Promise<{ code: number; stderr: string }>;

const runSystem: Run = async (argv) => {
  const child = Bun.spawn([...argv], { stdout: "ignore", stderr: "pipe" });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  return { code, stderr };
};

/** The id-mapped bind mounts, as root. */
export class IdmapMounter implements FolderMounter {
  readonly #person: Ids;
  readonly #agent: Ids;
  readonly #run: Run;

  readonly #mountinfo: string;

  constructor(person: Ids, agent: Ids, run: Run = runSystem, mountinfo = "/proc/self/mountinfo") {
    this.#person = person;
    this.#agent = agent;
    this.#run = run;
    this.#mountinfo = mountinfo;
  }

  /** The `mount` arguments for one folder. */
  argv(source: string, target: string, write: boolean): string[] {
    const idmap = `u:${this.#person.uid}:${this.#agent.uid}:1 g:${this.#person.gid}:${this.#agent.gid}:1`;
    const options = `X-mount.idmap=${idmap},nosuid,nodev${write ? "" : ",ro"}`;
    return ["mount", "--bind", "-o", options, source, target];
  }

  async mount(source: string, target: string, write: boolean): Promise<string | null> {
    await mkdir(target, { recursive: true, mode: 0o755 });
    const done = await this.#run(this.argv(source, target, write));
    if (done.code === 0) return null;
    await rmdir(target).catch(() => undefined);
    return done.stderr.trim() || `mount ended with ${done.code}`;
  }

  async unmount(target: string): Promise<void> {
    await this.#run(["umount", "--lazy", target]);
    await rmdir(target).catch(() => undefined);
  }

  async mounted(root: string): Promise<string[]> {
    return mountsBelow(await readFile(this.#mountinfo, "utf8").catch(() => ""), root);
  }
}
