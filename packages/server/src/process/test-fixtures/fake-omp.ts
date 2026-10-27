#!/usr/bin/env bun
/**
 * Minimal stand-in for a chat process, used only by A0.5's OmpProcess tests. It is never a real agent: it writes a
 * chat host's `hello`, answers every request on stdin with a trivial success `response` that names the method, and
 * otherwise behaves exactly as the test controlling it asks:
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
    kind: "hello",
    protocol: 1,
    ompVersion: "18.12.6",
    methods: ["get_state"],
    session: { id: "fake-session", file: null, cwd: process.cwd() },
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
    let request: { id?: unknown; method?: unknown };
    try {
      request = JSON.parse(line) as { id?: unknown; method?: unknown };
    } catch {
      continue;
    }
    console.log(
      JSON.stringify({
        kind: "response",
        id: typeof request.id === "string" ? request.id : undefined,
        ok: true,
        result: { method: typeof request.method === "string" ? request.method : "unknown" },
      }),
    );
  }
}
