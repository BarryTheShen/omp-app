import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppLookStoreService } from "./store";

const made: string[] = [];
async function store(): Promise<AppLookStoreService> {
  const dir = await mkdtemp(join(tmpdir(), "app-look-"));
  made.push(dir);
  return new AppLookStoreService({ appDataDir: dir });
}
afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("the app's look for every device", () => {
  test("a change is saved, heard by every listener and refused when made on an older revision", async () => {
    const looks = await store();
    const heard: unknown[] = [];
    looks.subscribe((look) => heard.push(look.look));
    const first = await looks.read();
    expect(first.look).toEqual({});
    const saved = await looks.set({
      look: { themeMode: "dark", style: "paper" },
      expectedRevision: first.revision,
    });
    expect((await looks.read()).look).toEqual({ themeMode: "dark", style: "paper" });
    expect(heard).toEqual([{ themeMode: "dark", style: "paper" }]);
    expect(saved.revision).not.toBe(first.revision);
    await expect(
      looks.set({ look: { themeMode: "light" }, expectedRevision: first.revision }),
    ).rejects.toThrow("The look changed on another device");
    // A second store on the same folder (a restart) reads what was saved.
    expect((await new AppLookStoreService({ appDataDir: made[0] }).read()).look.style).toBe(
      "paper",
    );
  });
});
