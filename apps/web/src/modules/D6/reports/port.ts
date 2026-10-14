import type { AppClient } from "@omp-app/client";
import {
  AppFailure,
  type CommandRunResult,
  OmpCommandGateway,
  type ThreadId,
} from "@omp-app/contracts";
import {
  type DiagnosticCommandPort,
  type DiagnosticCommandRequest,
  type DiagnosticCommandResult,
  DiagnosticCommandResultSchema,
  diagnosticSlashCommand,
  redactDiagnosticLines,
} from "../contract";

/** The most lines a report keeps; the same bound the D6.1 result schema allows. */
const MAX_REPORT_LINES = 500;

/** omp prints terminal colour and cursor codes (ESC [ ... final byte) in some reports; the panel shows the words only. */
const TERMINAL_CODES = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, "gu");

/**
 * Maps a settled gateway run into a D6.1 result. omp's words are kept as omp printed them, split
 * into lines and redacted. Nothing here reads what the text means: the browser never classifies
 * omp's prose (AP4).
 */
export function diagnosticResultOf(
  request: DiagnosticCommandRequest,
  run: CommandRunResult,
): DiagnosticCommandResult {
  const flat = run.outputs.flatMap((output) =>
    output.text
      .replace(TERMINAL_CODES, "")
      .replace(/\n+$/u, "")
      .split(/\r?\n/u)
      .map((text) => ({ text })),
  );
  const { lines, truncated } = redactDiagnosticLines(flat, MAX_REPORT_LINES);
  return DiagnosticCommandResultSchema.parse({
    command: request.name,
    status: run.status === "aborted" ? "aborted" : "completed",
    lines,
    promptSettled: run.promptSettled,
    sessionSettled: run.sessionSettled,
    truncated,
  });
}

/**
 * D6.1's DiagnosticCommandPort over A1's OmpCommandGateway: each report is one slash command sent
 * through `gateway.run`. Aborting the call stops waiting for omp; it sends omp no cancel, so the
 * command still finishes there.
 */
export function createDiagnosticCommandPort(
  client: Pick<AppClient, "port">,
): DiagnosticCommandPort {
  const gateway = client.port(OmpCommandGateway);
  return {
    async run(threadId: ThreadId, request: DiagnosticCommandRequest, options) {
      const run = await gateway.run(
        { threadId, command: diagnosticSlashCommand(request) },
        options,
      );
      return diagnosticResultOf(request, run);
    },
    async cancel() {
      // A run has no id until it settles, so a caller cannot name one to stop. The call's signal
      // stops the wait for it (PortCallOptions.signal); omp's command is not stopped.
      throw new AppFailure({
        code: "unavailable",
        message:
          "A report cannot be stopped by its id. Closing the panel stops waiting for it, but omp still finishes the command.",
        retryable: false,
      });
    },
  };
}
