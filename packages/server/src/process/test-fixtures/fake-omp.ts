#!/usr/bin/env bun
/**
 * Minimal stand-in for `omp --mode rpc-ui`, used only by A0.5's OmpProcess tests. It is never a
 * real agent: it emits one `ready` frame, echoes every JSONL command on stdin as a trivial
 * success `response`, and otherwise behaves exactly as the test controlling it asks:
 *
 * - `FAKE_OMP_STDERR`: text to write to stderr once at startup.
 * - `FAKE_OMP_EXIT_CODE`: when set, exit with this code shortly after starting (simulates a crash).
 * - `FAKE_OMP_IGNORE_SIGTERM`: when `"1"`, install a SIGTERM handler that swallows the signal, so
 *   only SIGKILL can stop this process (exercises the grace-period escalation).
 */

export {};

const stderrText = Bun.env.FAKE_OMP_STDERR ?? "";
if (stderrText.length > 0) process.stderr.write(stderrText);

if (Bun.env.FAKE_OMP_IGNORE_SIGTERM === "1") {
  process.on("SIGTERM", () => {
    // Deliberately ignored; the test expects the caller to escalate to SIGKILL.
  });
}

console.log(
  JSON.stringify({
    type: "ready",
    protocolVersion: 1,
    supportedProtocolVersions: [1, 2],
    maxFrameBytes: 1048576,
    maxReassembledFrameBytes: 67108864,
  }),
);

console.log(
  JSON.stringify({
    type: "notice",
    cwd: process.cwd(),
    echoedEnv: Bun.env.FAKE_OMP_PASSTHROUGH_CHECK ?? null,
    configFiles: Bun.env.PI_CONFIG_FILES ?? null,
  }),
);

const exitCodeText = Bun.env.FAKE_OMP_EXIT_CODE;
if (exitCodeText !== undefined) {
  const exitCode = Number(exitCodeText);
  setTimeout(() => process.exit(exitCode), 30);
}

for await (const chunk of Bun.stdin.stream()) {
  const text = new TextDecoder().decode(chunk);
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    let command: { id?: unknown; type?: unknown };
    try {
      command = JSON.parse(line) as { id?: unknown; type?: unknown };
    } catch {
      continue;
    }
    console.log(
      JSON.stringify({
        type: "response",
        id: typeof command.id === "string" ? command.id : undefined,
        command: typeof command.type === "string" ? command.type : "unknown",
        success: true,
        data: {},
      }),
    );
  }
}
