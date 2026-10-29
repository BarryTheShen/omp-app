import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { keepLaunchToken, launchTokenFile, replaceLaunchToken } from "./launch-token";

const DATA = join(import.meta.dir, "../../../.data");
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** The app's state folder, not made yet: the first save makes it. */
async function stateFolder(): Promise<string> {
  await mkdir(DATA, { recursive: true });
  const root = await mkdtemp(join(DATA, "launch-token-"));
  roots.push(root);
  return join(root, "state", "omp-app");
}

/** 32 random bytes in base64url, as the app's links carry them. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

describe("the launch token the installed app keeps", () => {
  test("the first start saves a new token in a file only its owner can read, and every later start uses it", async () => {
    const file = launchTokenFile(await stateFolder());
    const first = await keepLaunchToken(file);
    expect(first.kept).toBe(true);
    expect(first.token).toMatch(TOKEN_SHAPE);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await readFile(file, "utf8")).trim()).toBe(first.token);
    expect(await keepLaunchToken(file)).toEqual({ token: first.token, kept: true });
  });

  test("starts at the same moment end with one token between them", async () => {
    const file = launchTokenFile(await stateFolder());
    const starts = await Promise.all([
      keepLaunchToken(file),
      keepLaunchToken(file),
      keepLaunchToken(file),
    ]);
    expect(starts.map((start) => start.kept)).toEqual([true, true, true]);
    expect(new Set(starts.map((start) => start.token)).size).toBe(1);
    expect((await readFile(file, "utf8")).trim()).toBe(starts[0]?.token);
  });

  test("a file that holds no token is replaced by a new one, which later starts keep", async () => {
    const folder = await stateFolder();
    await mkdir(folder, { recursive: true });
    const file = launchTokenFile(folder);
    await writeFile(file, "not a token\n");
    const replaced = await keepLaunchToken(file);
    expect(replaced.kept).toBe(true);
    expect(replaced.token).toMatch(TOKEN_SHAPE);
    expect(await keepLaunchToken(file)).toEqual({ token: replaced.token, kept: true });
  });

  test("a token file that cannot be read leaves each start a token of its own, unsaved, with the reason", async () => {
    const file = launchTokenFile(await stateFolder());
    // A folder where the file belongs: reading it fails, as an unreadable file would.
    await mkdir(file, { recursive: true });
    const first = await keepLaunchToken(file);
    expect(first.kept).toBe(false);
    expect(first.token).toMatch(TOKEN_SHAPE);
    expect(first.kept === false && first.reason.length > 0).toBe(true);
    expect((await keepLaunchToken(file)).token).not.toBe(first.token);
  });

  test("a new link replaces the token: the next start uses a new one, still readable only by its owner", async () => {
    const file = launchTokenFile(await stateFolder());
    const before = await keepLaunchToken(file);
    await replaceLaunchToken(file);
    const after = await keepLaunchToken(file);
    expect(after.kept).toBe(true);
    expect(after.token).toMatch(TOKEN_SHAPE);
    expect(after.token).not.toBe(before.token);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });
});
