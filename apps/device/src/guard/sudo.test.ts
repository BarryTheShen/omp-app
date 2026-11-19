/**
 * The agent account's sudo drop-in (#20). The real check needs sudo-rs's visudo (`OMP_APP_DEVICE_TEST_VISUDO`, which
 * checks a file without root); skipped without it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SudoersFile } from "./sudo";

const VISUDO = process.env.OMP_APP_DEVICE_TEST_VISUDO ?? "";

let dir: string | null = null;
afterEach(async () => {
  if (dir !== null) await rm(dir, { recursive: true, force: true });
  dir = null;
});

describe("the agent account's sudo drop-in (#20)", () => {
  test.skipIf(VISUDO === "")(
    "a grant is one checked rule for the agent account, read-only; revoking removes it",
    async () => {
      dir = await mkdtemp(join(tmpdir(), "omp-app-sudo-"));
      const path = join(dir, "zz-omp-app-agent");
      const sudoers = new SudoersFile(path, VISUDO);
      expect(await sudoers.grant("omp-agent")).toBeNull();
      expect(await readFile(path, "utf8")).toBe("omp-agent ALL=(ALL:ALL) NOPASSWD: ALL\n");
      expect((await stat(path)).mode & 0o777).toBe(0o440);
      await sudoers.revoke();
      expect(existsSync(path)).toBe(false);
    },
  );

  test("a rule the check refuses never goes in place, and nothing is left beside it", async () => {
    dir = await mkdtemp(join(tmpdir(), "omp-app-sudo-"));
    const path = join(dir, "zz-omp-app-agent");
    const refused = await new SudoersFile(path, "false").grant("omp-agent");
    expect(refused).toContain("did not check out");
    expect(await readdir(dir)).toEqual([]);
    expect(await new SudoersFile(path, "true").grant("omp-agent ALL")).toBe("not an account name");
  });
});
