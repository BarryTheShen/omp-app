/**
 * A stand-in for the omp binary whose command list cannot be read: each `get_available_commands` request gets an
 * error reply, the way omp's own failure does, and every other line reaches the real omp unchanged. The fix-1371 spec
 * starts the app with it through a shell wrapper, so the list fails inside the real app while the chat is real omp.
 *
 * Usage: bun fix-1371-omp-without-command-list.ts <real omp> [omp arguments...]
 */
import { spawn } from "node:child_process";

const [realOmp, ...args] = process.argv.slice(2);
if (realOmp === undefined) {
  throw new Error("usage: fix-1371-omp-without-command-list.ts <real omp> [omp arguments...]");
}

const child = spawn(realOmp, args, { stdio: ["pipe", "pipe", "inherit"], env: process.env });
child.stdout.pipe(process.stdout);
// The child may exit before its stdin is written again; its exit ends this process, so the write error is not news.
child.stdin.on("error", () => undefined);
child.once("exit", (code, signal) => process.exit(code ?? (signal === null ? 0 : 1)));
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => child.kill(signal));
}

/** omp's error reply for a `get_available_commands` request, or undefined when the line is any other frame. */
function refusalFor(line: string): string | undefined {
  let frame: unknown;
  try {
    frame = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof frame !== "object" || frame === null) return undefined;
  if (!("type" in frame) || frame.type !== "get_available_commands") return undefined;
  const id = "id" in frame && typeof frame.id === "string" ? frame.id : undefined;
  return `${JSON.stringify({
    ...(id === undefined ? {} : { id }),
    type: "response",
    command: "get_available_commands",
    success: false,
    error: "omp could not list its commands.",
  })}\n`;
}

let pending = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  pending += chunk;
  for (let end = pending.indexOf("\n"); end !== -1; end = pending.indexOf("\n")) {
    const line = pending.slice(0, end + 1);
    pending = pending.slice(end + 1);
    const refusal = refusalFor(line);
    if (refusal === undefined) child.stdin.write(line);
    else process.stdout.write(refusal);
  }
});
process.stdin.on("end", () => child.stdin.end());
