/**
 * A stand-in for the omp binary whose command list cannot be read: each `get_available_commands` request gets an
 * error reply, the way omp's own failure does, and the `available_commands_update` frames omp pushes on its own (at
 * start and when commands change, omp v18.12.6 `modes/rpc/rpc-mode.ts:1753-1759`) are held back. Every other line
 * passes unchanged both ways. The fix-1371 spec starts the app with it through a shell wrapper, so the list fails
 * inside the real app while the chat is real omp.
 *
 * Usage: bun fix-1371-omp-without-command-list.ts <real omp> [omp arguments...]
 */
import { spawn } from "node:child_process";

const [realOmp, ...args] = process.argv.slice(2);
if (realOmp === undefined) {
  throw new Error("usage: fix-1371-omp-without-command-list.ts <real omp> [omp arguments...]");
}

const child = spawn(realOmp, args, { stdio: ["pipe", "pipe", "inherit"], env: process.env });

/** Whether a line omp wrote is a pushed command list. */
function isCommandListPush(line: string): boolean {
  if (!line.includes('"available_commands_update"')) return false;
  try {
    const frame: unknown = JSON.parse(line);
    return (
      typeof frame === "object" &&
      frame !== null &&
      "type" in frame &&
      frame.type === "available_commands_update"
    );
  } catch {
    return false;
  }
}

let pendingOutput = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk: string) => {
  pendingOutput += chunk;
  for (let end = pendingOutput.indexOf("\n"); end !== -1; end = pendingOutput.indexOf("\n")) {
    const line = pendingOutput.slice(0, end + 1);
    pendingOutput = pendingOutput.slice(end + 1);
    if (!isCommandListPush(line)) process.stdout.write(line);
  }
});
child.stdout.on("end", () => {
  if (pendingOutput !== "") process.stdout.write(pendingOutput);
});
// The child may exit before its stdin is written again; its exit ends this process, so the write error is not news.
child.stdin.on("error", () => undefined);
// `close` comes after omp's output has ended, so its last lines are passed on before this process exits.
child.once("close", (code, signal) => process.exit(code ?? (signal === null ? 0 : 1)));
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
