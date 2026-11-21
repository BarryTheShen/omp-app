import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { programOf } from "../omp-host/chat-command";

/** What a stand-in program does when run, in this order: count the run, wait, write, exit. */
export interface FakeProgram {
  /** Adds a line to `runs.txt` beside the program on every run. */
  readonly countRuns?: boolean;
  readonly sleepMs?: number;
  /** Written with a line end after it. */
  readonly stdout?: string;
  /** Written with a line end after it. */
  readonly stderr?: string;
  readonly exitCode?: number;
}

/**
 * Writes a stand-in program (for omp, git, gh, …) into `directory` as a Bun script whose code is `body`, and returns its
 * path: for options that take a program's path, which the server starts with `programOf`. Its arguments are
 * `Bun.argv.slice(2)`.
 */
export async function fakeScriptFile(
  directory: string,
  name: string,
  body: string,
): Promise<string> {
  const script = join(directory, `${name}.ts`);
  await writeFile(script, `#!/usr/bin/env bun\n${body}\n`, { mode: 0o755 });
  return script;
}

/**
 * The command that starts a stand-in whose code is `body`: the script itself, or on Windows, which runs no script by
 * its `#!` line, Bun with the script.
 */
export async function writeFakeScript(
  directory: string,
  name: string,
  body: string,
): Promise<string[]> {
  return programOf(await fakeScriptFile(directory, name, body));
}

/** Writes a stand-in program that does `does`, and returns its path (see `fakeScriptFile`). */
export function fakeProgramFile(
  directory: string,
  name: string,
  does: FakeProgram,
): Promise<string> {
  return fakeScriptFile(
    directory,
    name,
    `import { appendFileSync } from "node:fs";
import { join } from "node:path";
const does = ${JSON.stringify(does)};
if (does.countRuns) appendFileSync(join(import.meta.dir, "runs.txt"), "run\\n");
if (does.sleepMs) await Bun.sleep(does.sleepMs);
if (does.stdout !== undefined) process.stdout.write(does.stdout + "\\n");
if (does.stderr !== undefined) process.stderr.write(does.stderr + "\\n");
process.exit(does.exitCode ?? 0);`,
  );
}

/** The command that starts a stand-in that does `does` (see `writeFakeScript`). */
export async function writeFakeProgram(
  directory: string,
  name: string,
  does: FakeProgram,
): Promise<string[]> {
  return programOf(await fakeProgramFile(directory, name, does));
}

/** The file a counting stand-in adds a line to on every run. */
export function runsFileOf(command: readonly string[]): string {
  return join(dirname(command.at(-1) ?? ""), "runs.txt");
}
