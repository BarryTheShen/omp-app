import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACCESS_SSH_CONFIG_ENV, readAccessNote, withAccessNote } from "./access-note";

let dir: string | null = null;
afterEach(async () => {
  if (dir !== null) await rm(dir, { recursive: true, force: true });
  dir = null;
});

/** The server's access ssh_config as `SshFiles` writes it, for these computers. */
const config = (aliases: readonly string[]) =>
  `# Written by omp-app (agent access); changes here are replaced.\n\n${aliases
    .map(
      (alias) =>
        `Host ${alias}\n  HostName ${alias}\n  HostKeyAlias omp-access-${alias}\n  User omp-agent\n`,
    )
    .join("\n")}`;

describe("what a chat is told about the computers agent access reaches (PLAN §7e)", () => {
  test("the linked computers by name, the ssh that reaches them, and how to ask for a folder", async () => {
    dir = await mkdtemp(join(tmpdir(), "omp-access-note-"));
    const path = join(dir, "ssh_config");
    await writeFile(path, config(["laptop", "lab-2"]));
    const note = await readAccessNote({ [ACCESS_SSH_CONFIG_ENV]: path });
    expect(note).toContain("Linked to this omp-app server: laptop, lab-2.");
    expect(note).toContain(`\`ssh -F ${path} <name> '<command>'\``);
    expect(note).toContain("omp-app-device ask-folder '~/<folder>' --why '<one line>'");
  });

  test("nothing without agent access on (no file named), without the file, or without computers", async () => {
    dir = await mkdtemp(join(tmpdir(), "omp-access-note-"));
    const path = join(dir, "ssh_config");
    expect(await readAccessNote({})).toBeNull();
    expect(await readAccessNote({ [ACCESS_SSH_CONFIG_ENV]: path })).toBeNull();
    await writeFile(path, config([]));
    expect(await readAccessNote({ [ACCESS_SSH_CONFIG_ENV]: path })).toBeNull();
  });

  test("a path with a space is quoted for the shell", async () => {
    dir = await mkdtemp(join(tmpdir(), "omp access note "));
    const path = join(dir, "ssh_config");
    await writeFile(path, config(["laptop"]));
    expect(await readAccessNote({ [ACCESS_SSH_CONFIG_ENV]: path })).toContain(
      `ssh -F '${path}' <name>`,
    );
  });

  test("the note comes after what omp appends anyway, which it never replaces", () => {
    expect(withAccessNote("From APPEND_SYSTEM.md", "NOTE")).toBe("From APPEND_SYSTEM.md\n\nNOTE");
    expect(withAccessNote(undefined, "NOTE")).toBe("NOTE");
    expect(withAccessNote("Kept", null)).toBe("Kept");
    expect(withAccessNote(undefined, null)).toBeUndefined();
  });
});
