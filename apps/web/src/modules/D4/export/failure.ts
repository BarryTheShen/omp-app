import { AppFailure } from "@omp-app/contracts";

/** A failure the person sees: its message is plain English, and retrying the same request will not change it. */
export function failure(code: AppFailure["appError"]["code"], message: string): AppFailure {
  return new AppFailure({ code, message, retryable: false });
}

/** Whatever the call threw becomes an AppFailure; a failure the call already made is passed through. */
export async function asFailure<T>(run: () => Promise<T>, message: string): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw error instanceof AppFailure ? error : failure("internal", message);
  }
}
