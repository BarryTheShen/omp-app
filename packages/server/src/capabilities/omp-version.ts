import { PATIENT_PROBE_TIMEOUT_MS } from ".";

/** What the version check found: the version, and whether omp can be used at all. */
export interface OmpProbe {
  readonly version: string | null;
  readonly health: { readonly status: "ok" | "unhealthy"; readonly detail?: string };
}

/**
 * Why omp cannot be used, in the words the page shows a person. These are the `detail` of an
 * unhealthy `AppPort.health` and decide what the "omp isn't available" screen says.
 */
export const OMP_PROBLEM = {
  notFound: "omp was not found.",
  timedOut: "omp did not answer in time.",
  wouldNotStart: "omp could not start.",
  checksFailed: "omp started but did not answer the app's checks.",
  checksTimedOut: "omp started but did not answer the app's checks in time.",
} as const;

export const OMP_VERSION_TIMEOUT_MS = 5_000;

/** Runs `omp --version`: is omp there, does it start, and which version is it. */
export async function probeOmp(
  binary: string,
  env: Record<string, string>,
  cwd: string,
  timeoutMs: number = OMP_VERSION_TIMEOUT_MS,
): Promise<OmpProbe> {
  let child: Bun.Subprocess<"pipe", "pipe", "pipe">;
  try {
    child = Bun.spawn([binary, "--version"], { cwd, env, stdout: "pipe", stderr: "pipe" });
  } catch {
    return { version: null, health: { status: "unhealthy", detail: OMP_PROBLEM.notFound } };
  }
  const finished = Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ranOutOfTime = new Promise<"timed-out">((resolve) => {
    timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // The child may already have exited.
      }
      resolve("timed-out");
    }, timeoutMs);
  });
  try {
    // Not waiting for the output after the kill: a child of omp could still hold its pipes open.
    const outcome = await Promise.race([finished, ranOutOfTime]);
    if (outcome === "timed-out") {
      return { version: null, health: { status: "unhealthy", detail: OMP_PROBLEM.timedOut } };
    }
    const [exitCode, stdout] = outcome;
    const version = stdout.match(/\d+\.\d+\.\d+/)?.[0] ?? null;
    if (exitCode === 0 && version !== null) {
      return { version, health: { status: "ok" } };
    }
    return { version, health: { status: "unhealthy", detail: OMP_PROBLEM.wouldNotStart } };
  } finally {
    clearTimeout(timer);
  }
}

export interface PatientOmpProbeOptions {
  /** How long the first attempt waits; a quiet computer answers well within it. */
  readonly quickMs?: number;
  /** How long the one retry waits; a busy computer can need this long. */
  readonly patientMs?: number;
  /** Called once, with how long the first attempt waited, when it ran out of time. */
  readonly onRetry?: (waitedMs: number) => void;
}

/**
 * `probeOmp`, asked once more with a longer wait when the first answer ran out of time. A busy
 * computer can take longer than five seconds to start omp; giving up then would leave the app
 * without omp until it is restarted.
 */
export async function probeOmpPatiently(
  binary: string,
  env: Record<string, string>,
  cwd: string,
  options: PatientOmpProbeOptions = {},
): Promise<OmpProbe> {
  const started = performance.now();
  const first = await probeOmp(binary, env, cwd, options.quickMs ?? OMP_VERSION_TIMEOUT_MS);
  if (first.health.detail !== OMP_PROBLEM.timedOut) return first;
  options.onRetry?.(Math.round(performance.now() - started));
  return probeOmp(binary, env, cwd, options.patientMs ?? PATIENT_PROBE_TIMEOUT_MS);
}
