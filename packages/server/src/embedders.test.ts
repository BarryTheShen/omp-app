import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EmbedderRefused, EmbeddersStore } from "./embedders";

const folders: string[] = [];
afterEach(async () => {
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});

async function file(): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "embedders-"));
  folders.push(folder);
  return join(folder, "app", "embedders.json");
}

describe("the saved pages and panels that may frame the lite view", () => {
  test("none at first; a saved list comes back on the next open, readable by its owner only", async () => {
    const path = await file();
    expect((await EmbeddersStore.open(path)).list()).toEqual([]);
    const store = await EmbeddersStore.open(path);
    expect(
      await store.set(["moz-extension:", " https://NOTES.tail1.ts.net:8443/ ", "moz-extension:"]),
    ).toEqual(["moz-extension:", "https://notes.tail1.ts.net:8443"]);
    expect((await EmbeddersStore.open(path)).list()).toEqual([
      "moz-extension:",
      "https://notes.tail1.ts.net:8443",
    ]);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("a source the app does not take refuses the change, and the list stays as it was", async () => {
    const store = await EmbeddersStore.open(await file());
    await store.set(["vscode-webview:", "vscode-file:"]);
    await expect(store.set(["moz-extension:", "https://example.com"])).rejects.toBeInstanceOf(
      EmbedderRefused,
    );
    expect(store.list()).toEqual(["vscode-webview:", "vscode-file:"]);
  });

  test("a file edited by hand keeps only the sources the app takes", async () => {
    const path = await file();
    await (await EmbeddersStore.open(path)).set(["moz-extension:"]);
    await writeFile(
      path,
      JSON.stringify({ sources: ["chrome-extension:", "*", "https://evil.example"] }),
    );
    expect((await EmbeddersStore.open(path)).list()).toEqual(["chrome-extension:"]);
    expect(JSON.parse(await readFile(path, "utf8")).sources).toHaveLength(3);
  });
});
