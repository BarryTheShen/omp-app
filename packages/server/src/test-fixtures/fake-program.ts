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
 * Writes a stand-in program (for omp, git, …) into `directory` as a Bun script whose code is `body`, and returns the
 * command that starts it: the script itself, or on Windows, which runs no script by its `#!` line, Bun with the script.
 * Its arguments are `Bun.argv.slice(2)`.
 */
export async function writeFakeScript(
  directory: string,
  name: string,
  body: string,
): Promise<string[]> {
  const script = join(directory, `${name}.ts`);
  await writeFile(script, `#!/usr/bin/env bun\n${body}\n`, { mode: 0o755 });
  return programOf(script);
}

/** Writes a stand-in program that does `does`; the command that starts it (see `writeFakeScript`). */
export function writeFakeProgram(
  directory: string,
  name: string,
  does: FakeProgram,
): Promise<string[]> {
  return writeFakeScript(
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

/** The file a counting stand-in adds a line to on every run. */
export function runsFileOf(command: readonly string[]): string {
  return join(dirname(command.at(-1) ?? ""), "runs.txt");
}
