import { describe, expect, test } from "bun:test";
import { checkFolder, type FolderFacts, sharedAt } from "./folders";

/**
 * A home of the person's (uid 1000) as the guard sees it: real paths, links (`/home/p/out` → `/etc`, `/home/p/keys` →
 * `~/.ssh`), and one folder of another account's.
 */
const DIRS = new Map<string, number>([
  ["/home/p", 1000],
  ["/home/p/workspace", 1000],
  ["/home/p/notes", 1000],
  ["/home/p/workspace/app", 1000],
  ["/home/p/.ssh", 1000],
  ["/home/p/.config", 1000],
  ["/home/p/.config/chromium", 1000],
  ["/home/p/.config/nvim", 1000],
  ["/home/p/.local", 1000],
  ["/home/p/.local/share", 1000],
  ["/home/p/.local/share/keyrings", 1000],
  ["/home/p/shared-by-root", 0],
  ["/etc", 0],
]);
const LINKS = new Map<string, string>([
  ["/home/p/out", "/etc"],
  ["/home/p/keys", "/home/p/.ssh"],
  ["/home/p/workspace/notes.txt", "/home/p/workspace/notes.txt"],
]);

const facts: FolderFacts = {
  realpath: async (path) => {
    const linked = LINKS.get(path);
    if (linked !== undefined) return linked;
    if (DIRS.has(path)) return path;
    throw new Error("ENOENT");
  },
  stat: async (path) => {
    const uid = DIRS.get(path);
    if (uid !== undefined) return { isDirectory: () => true, uid };
    if (path === "/home/p/workspace/notes.txt") return { isDirectory: () => false, uid: 1000 };
    throw new Error("ENOENT");
  },
};

const person = { home: "/home/p", uid: 1000 };
const check = (path: string) => checkFolder(path, person, facts);

describe("folders an agent may ask for (PLAN §7d)", () => {
  test("a folder of the person's inside the home is shared, and reached under the guard's shared folder", async () => {
    expect(await check("/home/p/workspace/app")).toEqual({
      path: "/home/p/workspace/app",
      place: "workspace/app",
    });
    // '~/' is the person's home, never the agent account's.
    expect(await check("~/notes")).toMatchObject({ path: "/home/p/notes", place: "notes" });
    expect(sharedAt("workspace/app", "/run/omp-app-device/shared")).toBe(
      "/run/omp-app-device/shared/workspace/app",
    );
    expect(await check("/home/p/.config/nvim")).toMatchObject({ path: "/home/p/.config/nvim" });
  });

  test("the home itself, a path given relative, and anything outside the home are refused", async () => {
    expect(await check("/home/p")).toMatchObject({
      problem: expect.stringContaining("whole home"),
    });
    expect(await check("~")).toMatchObject({ problem: expect.stringContaining("whole home") });
    expect(await check("workspace")).toMatchObject({
      problem: expect.stringContaining("full path"),
    });
    expect(await check("/etc")).toMatchObject({ problem: expect.stringContaining("not inside") });
    // A link inside the home that leads out of it is judged where it leads.
    expect(await check("/home/p/out")).toMatchObject({
      problem: expect.stringContaining("not inside"),
    });
  });

  test("a secret place, a folder inside one, a link to one, and a folder holding one are refused", async () => {
    expect(await check("/home/p/.ssh")).toMatchObject({
      problem: expect.stringContaining("~/.ssh"),
    });
    expect(await check("/home/p/keys")).toMatchObject({
      problem: expect.stringContaining("~/.ssh"),
    });
    expect(await check("/home/p/.config/chromium")).toMatchObject({
      problem: expect.stringContaining("secrets"),
    });
    // Refused for holding any secret place, there or not yet (~/.config/omp-app comes first in the list).
    expect(await check("/home/p/.config")).toMatchObject({
      problem: expect.stringMatching(/holds ~\/\.config\/[a-z-]+, where the person keeps secrets/),
    });
    expect(await check("/home/p/.local")).toMatchObject({
      problem: expect.stringContaining("holds ~/.local/share/keyrings"),
    });
  });

  test("a missing path, a file, and another account's folder are refused", async () => {
    expect(await check("/home/p/nothing")).toMatchObject({
      problem: expect.stringContaining("does not exist"),
    });
    expect(await check("/home/p/workspace/notes.txt")).toMatchObject({
      problem: expect.stringContaining("not a folder"),
    });
    expect(await check("/home/p/shared-by-root")).toMatchObject({
      problem: expect.stringContaining("does not belong"),
    });
  });
});
