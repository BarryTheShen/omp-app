import type { Logger } from "../logging";
import type { OmpProcess } from "./omp-process";

/** Stderr lines kept when a process exits on its own: enough to see why, never a transcript. */
const STDERR_LINES = 20;

/**
 * Records one omp process in the debug log: that it was created, every status change with its pid
 * and how long it has run, and, when it dies on its own, the last lines it wrote to stderr (each
 * scrubbed and cut by the logger). Returns the same process.
 */
export function logOmpProcess<T extends OmpProcess>(process: T, logger: Logger): T {
  const startedAt = Date.now();
  logger.info("omp.process.created", { thread: process.threadId, folder: process.folder });
  let lastStatus: string | undefined;
  process.onEvent((event) => {
    if (event.status === lastStatus && event.error === undefined) return;
    lastStatus = event.status;
    const dying = event.status === "exited" || event.status === "error";
    const fields = {
      thread: process.threadId,
      status: event.status,
      pid: process.pid,
      ran_ms: Date.now() - startedAt,
      error: event.error?.code,
      message: event.error?.message,
    };
    if (dying) logger.warn("omp.process", fields);
    else logger.info("omp.process", fields);
    if (!dying) return;
    const lines = process.stderrTail
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0)
      .slice(-STDERR_LINES);
    for (const line of lines) logger.warn("omp.stderr", { thread: process.threadId, line });
  });
  return process;
}
