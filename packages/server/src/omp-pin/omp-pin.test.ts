import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ensurePinnedOmp, type OmpPin, pinnedOmpPath } from ".";

const dataRoot = resolve(import.meta.dir, "../../../../.data");
const roots: string[] = [];

async function temporaryDir(): Promise<string> {
  await mkdir(dataRoot, { recursive: true });
  const root = await mkdtemp(join(dataRoot, "omp-pin-"));
  roots.push(root);
  return root;
}

const BYTES = new TextEncoder().encode("#!/bin/sh\necho omp/9.9.9\n");
const PIN: OmpPin = {
  version: "9.9.9",
  binaries: {
    "linux-x64": {
      asset: "omp-linux-x64",
      sha256: Bun.CryptoHasher.hash("sha256", BYTES, "hex"),
    },
  },
};

/** A download that answers every URL with `body` and records the URLs asked for. */
function fakeFetch(body: Uint8Array, status = 200) {
  const urls: string[] = [];
  const fetch = async (url: string): Promise<Response> => {
    urls.push(url);
    return new Response(body, { status });
  };
  return { fetch, urls };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ensurePinnedOmp", () => {
  test("downloads the release asset, checks its checksum and installs it as an executable", async () => {
    const dir = await temporaryDir();
    const download = fakeFetch(BYTES);

    const path = await ensurePinnedOmp({
      dir,
      pin: PIN,
      platform: "linux",
      arch: "x64",
      fetch: download.fetch,
    });

    expect(path).toBe(pinnedOmpPath(dir, PIN));
    expect(download.urls).toEqual([
      "https://github.com/can1357/oh-my-pi/releases/download/v9.9.9/omp-linux-x64",
    ]);
    expect(await Bun.file(path).text()).toBe("#!/bin/sh\necho omp/9.9.9\n");
    expect((await stat(path)).mode & 0o111).not.toBe(0);
    expect(await readdir(dir)).toEqual(["omp-9.9.9"]);
  });

  test("deletes a partial download whose process is gone, and keeps one whose process still runs", async () => {
    const dir = await temporaryDir();
    // 2147483647 is above any Linux pid_max, so no process has it.
    const abandoned = "omp-9.9.9.2147483647.0f8fad5b-d9cb-469f-a165-70867728950e.part";
    const running = `omp-9.9.9.${process.pid}.7c9e6679-7425-40de-944b-e07fc1f90ae7.part`;
    await writeFile(join(dir, abandoned), "half of an omp\n");
    await writeFile(join(dir, running), "another start's download\n");
    const download = fakeFetch(BYTES);

    await ensurePinnedOmp({ dir, pin: PIN, platform: "linux", arch: "x64", fetch: download.fetch });

    expect((await readdir(dir)).sort()).toEqual(["omp-9.9.9", running].sort());
  });

  test("after installing, deletes the binaries of older releases and keeps newer ones", async () => {
    const dir = await temporaryDir();
    for (const name of ["omp-9.8.12", "omp-9.9.8", "omp-9.10.0", "notes.txt"]) {
      await writeFile(join(dir, name), `${name}\n`);
    }
    const download = fakeFetch(BYTES);

    await ensurePinnedOmp({ dir, pin: PIN, platform: "linux", arch: "x64", fetch: download.fetch });

    expect((await readdir(dir)).sort()).toEqual(["notes.txt", "omp-9.10.0", "omp-9.9.9"]);
  });

  test("keeps every other release in a shared folder (removeOlder false)", async () => {
    const dir = await temporaryDir();
    for (const name of ["omp-9.8.12", "omp-9.9.8", "omp-9.10.0"]) {
      await writeFile(join(dir, name), `${name}\n`);
    }
    const download = fakeFetch(BYTES);

    await ensurePinnedOmp({
      dir,
      pin: PIN,
      platform: "linux",
      arch: "x64",
      fetch: download.fetch,
      removeOlder: false,
    });

    expect((await readdir(dir)).sort()).toEqual([
      "omp-9.10.0",
      "omp-9.8.12",
      "omp-9.9.8",
      "omp-9.9.9",
    ]);
  });

  test("uses a binary already in place without downloading again", async () => {
    const dir = await temporaryDir();
    await writeFile(pinnedOmpPath(dir, PIN), "already here\n");
    const download = fakeFetch(BYTES);

    const path = await ensurePinnedOmp({
      dir,
      pin: PIN,
      platform: "linux",
      arch: "x64",
      fetch: download.fetch,
    });

    expect(await Bun.file(path).text()).toBe("already here\n");
    expect(download.urls).toEqual([]);
  });

  test("refuses a download that does not match the checksum, and leaves nothing behind", async () => {
    const dir = await temporaryDir();
    const download = fakeFetch(new TextEncoder().encode("not omp\n"));

    await expect(
      ensurePinnedOmp({ dir, pin: PIN, platform: "linux", arch: "x64", fetch: download.fetch }),
    ).rejects.toThrow("the download of omp 9.9.9 does not match its release's checksum.");
    expect(await readdir(dir)).toEqual([]);
  });

  test("says why when the download fails", async () => {
    const dir = await temporaryDir();
    const download = fakeFetch(new Uint8Array(), 404);

    await expect(
      ensurePinnedOmp({ dir, pin: PIN, platform: "linux", arch: "x64", fetch: download.fetch }),
    ).rejects.toThrow("the download of omp 9.9.9 failed (HTTP 404).");
    expect(await readdir(dir)).toEqual([]);
  });

  test("says so on a computer with no build of the pinned omp", async () => {
    const dir = await temporaryDir();
    const download = fakeFetch(BYTES);

    await expect(
      ensurePinnedOmp({ dir, pin: PIN, platform: "win32", arch: "x64", fetch: download.fetch }),
    ).rejects.toThrow("omp 9.9.9 has no build for win32-x64 that this app can use.");
    expect(download.urls).toEqual([]);
  });
});
