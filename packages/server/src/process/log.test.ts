import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { FolderPath, type OmpProcessId, ThreadId } from "@omp-app/contracts";
import { createLogger, readLogTail } from "../logging";
import { logOmpProcess } from "./log";
import type { OmpProcess, OmpProcessEvent } from "./omp-process";
import { OmpProcessRegistry } from "./registry";

class FakeProcess {
  readonly threadId = ThreadId.parse("thread-log");
  readonly folder = FolderPath.parse("/workspace/log");
  readonly processId = "p" as OmpProcessId;
  status: OmpProcessEvent["status"] = "starting";
  pid: number | undefined = 4321;
  stderrTail = "";
  #listeners = new Set<(event: OmpProcessEvent) => void>();
  onEvent(listener: (event: OmpProcessEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  emit(event: OmpProcessEvent): void {
    this.status = event.status;
    for (const listener of [...this.#listeners]) listener(event);
  }
}

async function logDir(): Promise<string> {
  const base = join(import.meta.dir, "../../../../.data");
  await mkdir(base, { recursive: true });
  return mkdtemp(join(base, "process-log-"));
}

/** A made-up provider key, joined at run time so no line of this file looks like a real one. */
function fakeKey(): string {
  return ["sk", "ant", "api03", "A".repeat(10) + "b".repeat(10) + "1".repeat(10)].join("-");
}
describe("logOmpProcess", () => {
  test("records the start, how long it ran, and when it dies on its own the last stderr lines", async () => {
    const dir = await logDir();
    try {
      const logger = createLogger({ dir });
      const process = new FakeProcess();
      logOmpProcess(process as unknown as OmpProcess, logger);
      process.emit({ status: "starting" });
      process.emit({ status: "running" });
      process.emit({ status: "running" });
      process.stderrTail = `${"noise\n".repeat(30)}Error: provider said no ${fakeKey()}\nfatal: exiting\n`;
      process.emit({
        status: "exited",
        error: { code: "omp_exited", message: "omp exited with code 1", retryable: true },
      });
      const lines = readLogTail(dir, 60).split("\n");
      expect(lines[0]).toContain("omp.process.created thread=thread-log folder=/workspace/log");
      const events = lines.filter((line) => line.includes(" omp.process "));
      // The repeated "running" is one line, not two.
      expect(events.map((line) => line.match(/status=(\w+)/)?.[1])).toEqual([
        "starting",
        "running",
        "exited",
      ]);
      const exited = events.at(-1) ?? "";
      expect(exited).toContain("WARN ");
      expect(exited).toContain("pid=4321");
      expect(exited).toContain("error=omp_exited");
      expect(exited).toMatch(/ran_ms=\d+/);
      const stderr = lines.filter((line) => line.includes("omp.stderr"));
      // Twenty lines at most, the newest, with the key scrubbed.
      expect(stderr).toHaveLength(20);
      expect(stderr.at(-1)).toContain("fatal: exiting");
      expect(readLogTail(dir, 60)).not.toContain(fakeKey());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("OmpProcessRegistry.list", () => {
  test("lists the processes held, with their pid and status", () => {
    const processes: FakeProcess[] = [];
    const registry = new OmpProcessRegistry({
      createProcess: () => {
        const process = new FakeProcess();
        processes.push(process);
        return process as unknown as OmpProcess;
      },
    });
    expect(registry.list()).toEqual([]);
    const thread = ThreadId.parse("thread-a");
    registry.acquire({ threadId: thread, folder: FolderPath.parse("/workspace/a"), ompBin: "omp" });
    processes[0]?.emit({ status: "running" });
    expect(registry.list()).toEqual([{ threadId: thread, pid: 4321, status: "running" }]);
  });
});
