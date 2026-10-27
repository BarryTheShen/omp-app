/**
 * A stand-in for a chat whose command list cannot be read: each request for the list gets an error reply, the way omp's
 * own failure does, and the lists the chat pushes on its own (at start and when commands change) are held back. It reads
 * both protocols that pass through it: the chat host's (the app's chats: a `get_available_commands` request and the
 * `available_commands` event) and omp's RPC (the capability probe: the request and the `available_commands_update`
 * frame, omp v18.12.6 `modes/rpc/rpc-mode.ts:1753-1759`). Every other line passes unchanged both ways. The fix-1371 spec
 * runs every chat through it with a shell wrapper, so the list fails inside the real app while the chat is real.
 *
 * Usage: bun fix-1371-omp-without-command-list.ts <chat command...>
 */
import { spawn } from "node:child_process";

const [program, ...args] = process.argv.slice(2);
if (program === undefined) {
  throw new Error("usage: fix-1371-omp-without-command-list.ts <chat command...>");
}

const child = spawn(program, args, { stdio: ["pipe", "pipe", "inherit"], env: process.env });

/** Whether a line the chat wrote is a pushed command list: the chat host's event, or omp's RPC frame. */
function isCommandListPush(line: string): boolean {
  if (!line.includes('"available_commands')) return false;
  try {
    const frame = JSON.parse(line) as Record<string, unknown>;
    if (frame.type === "available_commands_update") return true;
    const event = frame.event as { readonly type?: unknown } | undefined;
    return frame.kind === "event" && event?.type === "available_commands";
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

/** The error reply for a request for the command list, or undefined when the line is anything else. */
function refusalFor(line: string): string | undefined {
  let frame: unknown;
  try {
    frame = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof frame !== "object" || frame === null) return undefined;
  const message = "omp could not list its commands.";
  // The chat host's request, from the app's chats.
  if ("kind" in frame && frame.kind === "request" && "method" in frame) {
    if (frame.method !== "get_available_commands" || !("id" in frame)) return undefined;
    return `${JSON.stringify({ kind: "response", id: frame.id, ok: false, error: { code: "failed", message } })}\n`;
  }
  // omp's RPC request, from the capability probe.
  if (!("type" in frame) || frame.type !== "get_available_commands") return undefined;
  const id = "id" in frame && typeof frame.id === "string" ? frame.id : undefined;
  return `${JSON.stringify({
    ...(id === undefined ? {} : { id }),
    type: "response",
    command: "get_available_commands",
    success: false,
    error: message,
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
