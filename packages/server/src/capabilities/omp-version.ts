import { AppFailure, type UsableModel } from "@omp-app/contracts";
import { z } from "zod";
import { PATIENT_PROBE_TIMEOUT_MS } from ".";

/** A health the app reports: what the server's checks found, and why omp cannot be used. */
export interface OmpHealth {
  readonly status: "ok" | "unhealthy";
  readonly detail?: string;
  /** Set when the page can say what to do: omp runs but has no model to chat with. */
  readonly code?: "no_model";
}

/** What the version check found: the version, and whether omp can be used at all. */
export interface OmpProbe {
  readonly version: string | null;
  readonly health: OmpHealth;
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
  noModel: "omp has no model to chat with, so no chat can start.",
} as const;

export const OMP_VERSION_TIMEOUT_MS = 5_000;

/** `omp models --json` reads the model catalog, which takes longer than `--version`. */
const OMP_MODELS_TIMEOUT_MS = 10_000;

/** One run of omp: it could not be started, it ran out of time (and was killed), or it exited. */
type OmpRun =
  | { readonly kind: "not-started" }
  | { readonly kind: "timed-out" }
  | { readonly kind: "exited"; readonly exitCode: number; readonly stdout: string };

async function runOmp(
  binary: string,
  args: readonly string[],
  env: Record<string, string>,
  cwd: string,
  timeoutMs: number,
): Promise<OmpRun> {
  let child: Bun.Subprocess<"pipe", "pipe", "pipe">;
  try {
    child = Bun.spawn([binary, ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
  } catch {
    return { kind: "not-started" };
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
    if (outcome === "timed-out") return { kind: "timed-out" };
    const [exitCode, stdout] = outcome;
    return { kind: "exited", exitCode, stdout };
  } finally {
    clearTimeout(timer);
  }
}

/** Runs `omp --version`: is omp there, does it start, and which version is it. */
export async function probeOmp(
  binary: string,
  env: Record<string, string>,
  cwd: string,
  timeoutMs: number = OMP_VERSION_TIMEOUT_MS,
): Promise<OmpProbe> {
  const run = await runOmp(binary, ["--version"], env, cwd, timeoutMs);
  if (run.kind === "not-started") {
    return { version: null, health: { status: "unhealthy", detail: OMP_PROBLEM.notFound } };
  }
  if (run.kind === "timed-out") {
    return { version: null, health: { status: "unhealthy", detail: OMP_PROBLEM.timedOut } };
  }
  const version = run.stdout.match(/\d+\.\d+\.\d+/)?.[0] ?? null;
  if (run.exitCode === 0 && version !== null) {
    return { version, health: { status: "ok" } };
  }
  return { version, health: { status: "unhealthy", detail: OMP_PROBLEM.wouldNotStart } };
}

const ModelList = z.object({ models: z.array(z.unknown()) });

/**
 * How many models omp can use now: `omp models --json` lists only those with credentials. Null when omp
 * cannot say: it did not run, ran out of time, or printed something that is not that list.
 */
async function countUsableModels(
  binary: string,
  env: Record<string, string>,
  cwd: string,
  timeoutMs: number,
): Promise<number | null> {
  const run = await runOmp(binary, ["models", "--json"], env, cwd, timeoutMs);
  if (run.kind !== "exited" || run.exitCode !== 0) return null;
  let json: unknown;
  try {
    json = JSON.parse(run.stdout);
  } catch {
    return null;
  }
  const list = ModelList.safeParse(json);
  return list.success ? list.data.models.length : null;
}

const ModelsOutput = z.object({
  models: z.array(
    z.object({ provider: z.string().min(1), id: z.string().min(1), name: z.string() }),
  ),
});

function parseModels(stdout: string): z.infer<typeof ModelsOutput> | null {
  try {
    const parsed = ModelsOutput.safeParse(JSON.parse(stdout));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * The models omp can use now, as the picker lists them (`omp models --json`). It throws a plain failure when omp
 * cannot list them, so the picker says so instead of showing an empty list.
 */
export async function listUsableModels(
  binary: string,
  env: Record<string, string>,
  cwd: string,
  timeoutMs: number = OMP_MODELS_TIMEOUT_MS,
): Promise<UsableModel[]> {
  const run = await runOmp(binary, ["models", "--json"], env, cwd, timeoutMs);
  const list = run.kind === "exited" && run.exitCode === 0 ? parseModels(run.stdout) : null;
  if (list === null) {
    throw new AppFailure({
      code: "unavailable",
      message: "omp could not list its models. Try again.",
      retryable: true,
    });
  }
  return list.models.map((model) => ({
    provider: model.provider,
    modelId: model.id,
    name: model.name,
  }));
}

/**
 * The health to report after omp failed the checks that need it to start a chat. omp exits when no model is
 * set up, so when `omp models --json` lists none, the page says what to set up. Any other failure keeps the
 * checks message.
 */
export async function unhealthyAfterFailedChecks(
  binary: string,
  env: Record<string, string>,
  cwd: string,
  timeoutMs: number = OMP_MODELS_TIMEOUT_MS,
): Promise<OmpHealth> {
  if ((await countUsableModels(binary, env, cwd, timeoutMs)) === 0) {
    return { status: "unhealthy", detail: OMP_PROBLEM.noModel, code: "no_model" };
  }
  return { status: "unhealthy", detail: OMP_PROBLEM.checksFailed };
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
